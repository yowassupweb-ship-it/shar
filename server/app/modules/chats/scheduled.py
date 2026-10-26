"""Отложенная отправка: сообщение уходит в чат в назначенное время (правый щелчок по кнопке отправки).

  GET    /api/chats/{chat_id}/scheduled      мои запланированные в этом чате
  POST   /api/chats/{chat_id}/scheduled      {sendAt, message: {content, replyToId?, attachments?, mentions?, metadata?}}
  PATCH  /api/scheduled/{id}                 {sendAt?, content?}
  DELETE /api/scheduled/{id}                 отменить
  POST   /api/scheduled/{id}/send            отправить сейчас

Отправляет обычный send_message от имени автора — с теми же проверками (участник ли он ещё), пушами и
событиями. id запланированного становится id сообщения, поэтому повтор отправки (процесс упал между
отправкой и удалением строки) не даёт дубля: вставка с тем же id узнаётся. Строку берёт один процесс —
отметкой claimed_at под SKIP LOCKED; зависшую отметку (старше двух минут) подхватывает следующий проход.
Цикл работает и там, где общие фоновые задачи выключены (SHAR_SCHEDULED_JOBS=0): у старого бэкенда этого нет.
Автору на все его устройства уходит scheduled_changed — список запланированных обновляется везде.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import anyio.to_thread
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity, identity_of
from app.modules.chats.access import require_member
from app.modules.chats.schemas import MessageCreate

router = APIRouter()
log = logging.getLogger("shar.scheduled")

schema.register("scheduled_messages", """
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL,
    author_id  TEXT NOT NULL,
    send_at    TIMESTAMPTZ NOT NULL,
    payload    JSONB NOT NULL,
    claimed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(send_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_author ON scheduled_messages(author_id, chat_id);
""")

MAX_PER_USER = 200
MAX_AHEAD = timedelta(days=366)
TICK_SECONDS = 5


class ScheduledMessage(BaseModel):
    content: str = Field(default="", max_length=20000)
    replyToId: Optional[str] = None
    attachments: Optional[List[Dict[str, Any]]] = None
    mentions: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None


class ScheduleBody(BaseModel):
    sendAt: datetime
    message: ScheduledMessage


class SchedulePatch(BaseModel):
    sendAt: Optional[datetime] = None
    content: Optional[str] = Field(default=None, max_length=20000)


def _present(row: dict) -> dict:
    send_at = row["send_at"]
    return {
        "id": str(row["id"]),
        "chatId": str(row["chat_id"]),
        "sendAt": send_at.isoformat() if hasattr(send_at, "isoformat") else str(send_at),
        **(row["payload"] if isinstance(row["payload"], dict) else json.loads(row["payload"] or "{}")),
    }


def _when(value: datetime) -> datetime:
    when = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if when > now + MAX_AHEAD:
        raise HTTPException(status_code=400, detail="Не дальше чем через год")
    # Время в прошлом (часы клиента спешат, выбрали «сейчас») — просто отправится на ближайшем проходе.
    return max(when, now)


def _own(scheduled_id: str, me: Identity) -> dict:
    row = db.conn.fetch_one("SELECT * FROM scheduled_messages WHERE id = %s", (scheduled_id,))
    if not row or str(row["author_id"]) != me.user_id:
        raise HTTPException(status_code=404, detail="Запланированное сообщение не найдено")
    return dict(row)


def _changed(user_id: str, chat_id: str) -> None:
    try:
        sse_manager.push(user_id, {"type": "scheduled_changed", "chatId": chat_id})
    except Exception as exc:
        log.debug("scheduled_changed push failed: %s", exc)


def _list(chat_id: str, user_id: str) -> list[dict]:
    rows = db.conn.fetch_all(
        "SELECT * FROM scheduled_messages WHERE chat_id = %s AND author_id = %s ORDER BY send_at, created_at",
        (chat_id, user_id),
    ) or []
    return [_present(dict(r)) for r in rows]


@router.get("/api/chats/{chat_id}/scheduled")
def list_scheduled(chat_id: str, me: Identity = Depends(current_identity)):
    return {"items": _list(chat_id, me.user_id)}


@router.post("/api/chats/{chat_id}/scheduled", status_code=201)
def create_scheduled(chat_id: str, body: ScheduleBody, me: Identity = Depends(current_identity)):
    require_member(chat_id, me)
    msg = body.message
    if not msg.content.strip() and not msg.attachments:
        raise HTTPException(status_code=400, detail="Пустое сообщение")
    count = db.conn.fetch_one("SELECT count(*) AS n FROM scheduled_messages WHERE author_id = %s", (me.user_id,))["n"]
    if count >= MAX_PER_USER:
        raise HTTPException(status_code=400, detail="Слишком много запланированных сообщений")
    payload = msg.model_dump(exclude_none=True)
    payload["content"] = msg.content.strip()
    row = db.conn.fetch_one(
        "INSERT INTO scheduled_messages (id, chat_id, author_id, send_at, payload) VALUES (%s, %s, %s, %s, %s::jsonb) RETURNING *",
        (str(uuid.uuid4()), chat_id, me.user_id, _when(body.sendAt), json.dumps(payload, ensure_ascii=False)),
    )
    _changed(me.user_id, chat_id)
    return {"item": _present(dict(row))}


@router.patch("/api/scheduled/{scheduled_id}")
def patch_scheduled(scheduled_id: str, body: SchedulePatch, me: Identity = Depends(current_identity)):
    row = _own(scheduled_id, me)
    payload = row["payload"] if isinstance(row["payload"], dict) else json.loads(row["payload"] or "{}")
    if body.content is not None:
        if not body.content.strip() and not payload.get("attachments"):
            raise HTTPException(status_code=400, detail="Пустое сообщение")
        payload["content"] = body.content.strip()
    send_at = _when(body.sendAt) if body.sendAt else row["send_at"]
    # Уже взятое на отправку не правим — иначе правка разойдётся с ушедшим сообщением.
    updated = db.conn.fetch_one(
        "UPDATE scheduled_messages SET send_at = %s, payload = %s::jsonb WHERE id = %s AND claimed_at IS NULL RETURNING *",
        (send_at, json.dumps(payload, ensure_ascii=False), scheduled_id),
    )
    if not updated:
        raise HTTPException(status_code=409, detail="Сообщение уже отправляется")
    _changed(me.user_id, str(row["chat_id"]))
    return {"item": _present(dict(updated))}


@router.delete("/api/scheduled/{scheduled_id}")
def delete_scheduled(scheduled_id: str, me: Identity = Depends(current_identity)):
    row = _own(scheduled_id, me)
    gone = db.conn.fetch_one("DELETE FROM scheduled_messages WHERE id = %s AND claimed_at IS NULL RETURNING id", (scheduled_id,))
    if not gone:
        raise HTTPException(status_code=409, detail="Сообщение уже отправляется")
    _changed(me.user_id, str(row["chat_id"]))
    return {"ok": True}


@router.post("/api/scheduled/{scheduled_id}/send")
def send_scheduled_now(scheduled_id: str, me: Identity = Depends(current_identity)):
    _own(scheduled_id, me)
    rows = db.conn.fetch_all(
        "UPDATE scheduled_messages SET claimed_at = now() WHERE id = %s AND claimed_at IS NULL RETURNING *", (scheduled_id,),
    ) or []
    if not rows:
        raise HTTPException(status_code=409, detail="Сообщение уже отправляется")
    message = _deliver(dict(rows[0]))
    if message is None:
        raise HTTPException(status_code=400, detail="Не удалось отправить")
    return {"message": message}


def _deliver(row: dict) -> Optional[dict]:
    """Отправить взятую строку от имени автора и удалить её. Не вышло по правам (автора убрали из чата,
    учётку отключили) — строка удаляется, автору уходит scheduled_failed; сбой базы — строка остаётся
    и будет взята снова."""
    from app.modules.chats.messages import send_message
    from app.modules.realtime.router import _run_background

    chat_id, author_id = str(row["chat_id"]), str(row["author_id"])
    payload = row["payload"] if isinstance(row["payload"], dict) else json.loads(row["payload"] or "{}")
    me = identity_of(author_id)
    saved: Optional[dict] = None
    try:
        if me is None:
            raise HTTPException(status_code=403, detail="user disabled")
        bt = BackgroundTasks()
        saved = send_message(chat_id, MessageCreate(id=str(row["id"]), authorId=author_id, **payload), bt, me=me)
        _run_background(bt)
        # Обычная отправка не шлёт событие автору — его клиент сам рисует своё сообщение. Здесь автор ничего
        # не нажимал: сообщение должно появиться на всех его устройствах.
        try:
            sse_manager.push(author_id, {"type": "new_message", "chatId": chat_id, "messageId": saved.get("id"), "message": saved})
        except Exception as exc:
            log.debug("scheduled: author push failed: %s", exc)
    except HTTPException as exc:
        log.info("[scheduled] %s dropped: %s %s", row["id"], exc.status_code, exc.detail)
        try:
            sse_manager.push(author_id, {"type": "scheduled_failed", "chatId": chat_id, "id": str(row["id"]), "reason": str(exc.detail)})
        except Exception:
            pass
    db.conn.execute_query("DELETE FROM scheduled_messages WHERE id = %s", (str(row["id"]),))
    _changed(author_id, chat_id)
    return saved


def deliver_due(limit: int = 50) -> int:
    """Отправить созревшие. Возвращает число взятых строк."""
    rows = db.conn.fetch_all(
        "UPDATE scheduled_messages SET claimed_at = now() WHERE id IN ("
        "  SELECT id FROM scheduled_messages WHERE send_at <= now() "
        "  AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes') "
        "  ORDER BY send_at LIMIT %s FOR UPDATE SKIP LOCKED"
        ") RETURNING *",
        (limit,),
    ) or []
    for row in sorted((dict(r) for r in rows), key=lambda r: (r["send_at"], r["created_at"])):
        try:
            _deliver(row)
        except Exception as exc:
            log.warning("[scheduled] %s failed, will retry: %s", row.get("id"), exc)
    return len(rows)


async def scheduled_loop():
    await asyncio.sleep(5)
    while True:
        try:
            await anyio.to_thread.run_sync(deliver_due)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            log.warning("[scheduled] tick failed: %s", exc)
        await asyncio.sleep(TICK_SECONDS)
