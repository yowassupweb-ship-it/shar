"""«Ядро» — чат с агентами (по образцу чата MBOX): треды, сообщения, вложения, ответы, вопросы агента с кнопками,
цепочка шагов и ход работы. Отвечают личные агенты человека (Gemini, Claude, GPT), работающие на ноде
(core_agents/): они пишут ответы через post_agent_message / update_agent_message — тем же путём, что демо-ответ ниже.

Доступ: админ или тот, кому выдан инструмент `core` (users.enabled_tools). По умолчанию — только админы.

  GET    /api/core/catalog                         кто может отвечать (агенты, модели, «усилие»)
  GET    /api/core/threads?archived=0              мои чаты, новые сверху
  POST   /api/core/threads                         {title?, peer?}
  PATCH  /api/core/threads/{id}                    {title?, archived?}
  GET    /api/core/threads/{id}/messages?before=   последние сообщения (по 50), before — для подгрузки истории
  POST   /api/core/threads/{id}/messages           {id, body, replyTo?, attachments?, context?, model?, effort?}
  POST   /api/core/messages/{id}/answer            {value} — ответ на вопрос агента
  POST   /api/core/messages/{id}/cancel            остановить ожидание ответа

Живые события (сокет): {type: "core_message", message} и {type: "core_thread", thread} — только владельцу чата.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.db.connection import Json
from app.core.security import Identity, current_identity
from app.core.storage import is_upload_name

router = APIRouter()
log = logging.getLogger("shar.core")

TOOL = "core"
THREAD_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MAX_BODY = 20_000
PAGE = 50

schema.register("core_chat", """
CREATE TABLE IF NOT EXISTS core_threads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    peer TEXT NOT NULL DEFAULT '',
    archived BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_threads_user ON core_threads(user_id, archived, updated_at DESC);
-- Сессии CLI агентов по чату ({провайдер: id}): нода продолжает разговор, а не начинает заново (core_agents/node.py).
ALTER TABLE core_threads ADD COLUMN IF NOT EXISTS sessions JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS core_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES core_threads(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
    actor TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    props JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('queued', 'working', 'done', 'failed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_messages_thread ON core_messages(thread_id, created_at);
""")

EFFORTS = [
    {"id": "low", "label": "Быстро", "hint": "Короткие ответы, мало размышлений"},
    {"id": "medium", "label": "Обычно", "hint": "Как по умолчанию"},
    {"id": "high", "label": "Тщательно", "hint": "Дольше думает, для сложных задач"},
]


# ── доступ ───────────────────────────────────────────────────────────────────

def allowed(me: Identity) -> bool:
    if me.is_admin:
        return True
    user = db.get_user_by_id(me.user_id) or {}
    return TOOL in (user.get("enabled_tools") or user.get("enabledTools") or [])


def _guard(me: Identity) -> None:
    if not allowed(me):
        raise HTTPException(status_code=403, detail="«Ядро» вам пока не включено — его включает администратор")


def _thread(thread_id: str, me: Identity) -> dict:
    row = db.conn.fetch_one("SELECT * FROM core_threads WHERE id = %s AND user_id = %s", (thread_id, me.user_id)) if THREAD_ID.match(thread_id or "") else None
    if not row:
        raise HTTPException(status_code=404, detail="Чат не найден")
    return row


# ── представление ────────────────────────────────────────────────────────────

def _iso(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value or "")


def present_message(row: dict) -> dict:
    return {"id": row["id"], "threadId": row["thread_id"], "role": row["role"], "actor": row["actor"], "body": row["body"],
            "props": row.get("props") or {}, "status": row["status"], "createdAt": _iso(row["created_at"])}


def _thread_view(row: dict, stats: Optional[dict] = None) -> dict:
    stats = stats or {}
    return {"id": row["id"], "title": row["title"] or stats.get("first_text") or "Новый чат", "customTitle": bool(row["title"]),
            "peer": row["peer"], "archived": row["archived"], "createdAt": _iso(row["created_at"]), "updatedAt": _iso(row["updated_at"]),
            "messages": int(stats.get("messages") or 0), "lastText": stats.get("last_text") or "", "lastRole": stats.get("last_role") or "",
            "lastWork": stats.get("last_work") or None}


def _stats(thread_ids: list[str]) -> dict[str, dict]:
    if not thread_ids:
        return {}
    rows = db.conn.fetch_all(
        """SELECT thread_id, count(*)::int AS messages,
                  (array_agg(left(body, 90) ORDER BY created_at) FILTER (WHERE role = 'user'))[1] AS first_text,
                  (array_agg(left(body, 160) ORDER BY created_at DESC))[1] AS last_text,
                  (array_agg(role ORDER BY created_at DESC))[1] AS last_role,
                  (array_agg(props->'work' ORDER BY created_at DESC) FILTER (WHERE props ? 'work'))[1] AS last_work
           FROM core_messages WHERE thread_id = ANY(%s) GROUP BY thread_id""", (thread_ids,)) or []
    return {r["thread_id"]: r for r in rows}


def _thread_full(thread_id: str) -> dict:
    row = db.conn.fetch_one("SELECT * FROM core_threads WHERE id = %s", (thread_id,))
    return _thread_view(row, _stats([thread_id]).get(thread_id))


def _push(user_id: str, payload: dict) -> None:
    try:
        from app.core.realtime import sse_manager  # поздний импорт: realtime тянет много

        sse_manager.push(user_id, payload)
    except Exception as exc:  # живое обновление не должно ломать запрос
        log.debug("core: push failed: %s", exc)


def _announce(user_id: str, message: dict, thread_id: str) -> None:
    _push(user_id, {"type": "core_message", "message": message})
    _push(user_id, {"type": "core_thread", "thread": _thread_full(thread_id)})


def _touch(thread_id: str) -> None:
    db.conn.execute_query("UPDATE core_threads SET updated_at = now() WHERE id = %s", (thread_id,))


# ── для агентов (позже — нода; сейчас — демо) ────────────────────────────────

def post_agent_message(user_id: str, thread_id: str, actor: str, *, body: str = "", status: str = "working", props: Optional[dict] = None) -> dict:
    """Сообщение агента в чат: сначала «работает» (цепочка растёт на глазах), потом — готовый ответ."""
    row = db.conn.fetch_one(
        "INSERT INTO core_messages (id, thread_id, user_id, role, actor, body, props, status) VALUES (%s, %s, %s, 'agent', %s, %s, %s, %s) RETURNING *",
        (uuid.uuid4().hex, thread_id, user_id, actor, body, Json(props or {}), status))
    _touch(thread_id)
    message = present_message(row)
    _announce(user_id, message, thread_id)
    return message


def update_agent_message(message_id: str, *, body: Optional[str] = None, status: Optional[str] = None, props: Optional[dict] = None) -> Optional[dict]:
    """Дописать ответ: шаги цепочки, текст, ход работы. props сливаются с прежними. Отменённое не трогаем."""
    sets, params = [], []
    if body is not None:
        sets.append("body = %s")
        params.append(body)
    if status is not None:
        sets.append("status = %s")
        params.append(status)
    if props:
        sets.append("props = props || %s")
        params.append(Json(props))
    if not sets:
        return None
    row = db.conn.fetch_one(f"UPDATE core_messages SET {', '.join(sets)} WHERE id = %s AND status <> 'cancelled' RETURNING *", (*params, message_id))
    if not row:
        return None
    message = present_message(row)
    if status in ("done", "failed"):
        _touch(row["thread_id"])
        _announce(row["user_id"], message, row["thread_id"])
    else:
        _push(row["user_id"], {"type": "core_message", "message": message})
    return message


# ── чаты ─────────────────────────────────────────────────────────────────────

class ThreadBody(BaseModel):
    title: str = Field(default="", max_length=120)
    peer: str = Field(default="", max_length=60)


class ThreadPatch(BaseModel):
    title: Optional[str] = Field(default=None, max_length=120)
    archived: Optional[bool] = None


@router.get("/api/core/catalog")
def catalog(me: Identity = Depends(current_identity)):
    """Кто отвечает: подключённые агенты человека с их моделями. Никого — интерфейс зовёт подключить в настройках."""
    _guard(me)
    from app.modules.core_agents import store as agents

    ready = agents.ready_agents(me.user_id) if agents.ready() else []
    return {"agents": [{"id": a["provider"], "name": a["label"], "model": a["model"], "models": a["models"], "online": a["nodeOnline"]} for a in ready],
            "models": [], "efforts": EFFORTS, "demo": me.is_admin}


@router.get("/api/core/threads")
def list_threads(archived: bool = False, me: Identity = Depends(current_identity)):
    _guard(me)
    rows = db.conn.fetch_all(
        "SELECT * FROM core_threads WHERE user_id = %s AND archived = %s ORDER BY updated_at DESC LIMIT 200", (me.user_id, archived)) or []
    stats = _stats([r["id"] for r in rows])
    return {"threads": [_thread_view(r, stats.get(r["id"])) for r in rows]}


@router.post("/api/core/threads", status_code=201)
def create_thread(body: ThreadBody, me: Identity = Depends(current_identity)):
    _guard(me)
    row = db.conn.fetch_one(
        "INSERT INTO core_threads (id, user_id, title, peer) VALUES (%s, %s, %s, %s) RETURNING *",
        (uuid.uuid4().hex[:24], me.user_id, body.title.strip(), body.peer.strip()))
    thread = _thread_view(row)
    _push(me.user_id, {"type": "core_thread", "thread": thread})
    return {"thread": thread}


@router.patch("/api/core/threads/{thread_id}")
def change_thread(thread_id: str, body: ThreadPatch, me: Identity = Depends(current_identity)):
    _guard(me)
    _thread(thread_id, me)
    if body.title is not None:
        db.conn.execute_query("UPDATE core_threads SET title = %s WHERE id = %s", (body.title.strip(), thread_id))
    if body.archived is not None:
        db.conn.execute_query("UPDATE core_threads SET archived = %s, updated_at = now() WHERE id = %s", (body.archived, thread_id))
    thread = _thread_full(thread_id)
    _push(me.user_id, {"type": "core_thread", "thread": thread})
    return {"thread": thread}


# ── сообщения ────────────────────────────────────────────────────────────────

class Attachment(BaseModel):
    name: str = Field(max_length=255)
    key: str = Field(max_length=300)
    size: int = 0
    type: str = Field(default="", max_length=120)


class ContextItem(BaseModel):
    """Что открыто у человека (раздел, документ, окна) — агент знает, «где я». Зачёркнутое в поле ввода сюда не попадает."""
    kind: str = Field(max_length=30)
    title: str = Field(max_length=200)
    id: str = Field(default="", max_length=80)
    url: str = Field(default="", max_length=300)


class MessageBody(BaseModel):
    id: str = Field(min_length=8, max_length=64)
    body: str = Field(default="", max_length=MAX_BODY)
    replyTo: Optional[str] = Field(default=None, max_length=64)
    attachments: list[Attachment] = Field(default_factory=list, max_length=10)
    context: list[ContextItem] = Field(default_factory=list, max_length=12)
    model: str = Field(default="", max_length=60)
    effort: Literal["", "low", "medium", "high"] = ""


class AnswerBody(BaseModel):
    value: str = Field(min_length=1, max_length=2000)


def _clean_attachments(items: list[Attachment]) -> list[dict]:
    """Только наши загрузки (/api/upload): ссылку строим сами — чужой адрес в чат не попадёт."""
    out = []
    for item in items:
        name = Path(item.key).name
        if not is_upload_name(name):
            continue
        out.append({"name": item.name.strip() or name, "key": item.key, "url": f"/api/uploads/{name}", "size": max(0, item.size), "type": item.type})
    return out


@router.get("/api/core/threads/{thread_id}/messages")
def list_messages(thread_id: str, before: Optional[str] = None, me: Identity = Depends(current_identity)):
    _guard(me)
    _thread(thread_id, me)
    if before:
        rows = db.conn.fetch_all(
            "SELECT * FROM core_messages WHERE thread_id = %s AND created_at < %s::timestamptz ORDER BY created_at DESC LIMIT %s",
            (thread_id, before, PAGE + 1)) or []
    else:
        rows = db.conn.fetch_all("SELECT * FROM core_messages WHERE thread_id = %s ORDER BY created_at DESC LIMIT %s", (thread_id, PAGE + 1)) or []
    more = len(rows) > PAGE
    return {"messages": [present_message(r) for r in reversed(rows[:PAGE])], "hasMore": more}


@router.post("/api/core/threads/{thread_id}/messages", status_code=201)
def send_message(thread_id: str, body: MessageBody, tasks: BackgroundTasks, me: Identity = Depends(current_identity)):
    _guard(me)
    thread = _thread(thread_id, me)
    text = body.body.strip()
    attachments = _clean_attachments(body.attachments)
    if not text and not attachments:
        raise HTTPException(status_code=400, detail="Пустое сообщение")
    # Повтор той же отправки (сеть моргнула) узнаётся по id: второй раз не пишем.
    existing = db.conn.fetch_one("SELECT * FROM core_messages WHERE id = %s AND user_id = %s", (body.id, me.user_id))
    if existing:
        return {"message": present_message(existing)}
    props: dict[str, Any] = {}
    if attachments:
        props["attachments"] = attachments
    if body.context:
        props["context"] = [c.model_dump() for c in body.context]
    if body.model:
        props["model"] = body.model
    if body.effort:
        props["effort"] = body.effort
    if body.replyTo:
        quoted = db.conn.fetch_one("SELECT id, role, actor, body FROM core_messages WHERE id = %s AND thread_id = %s", (body.replyTo, thread_id))
        if quoted:
            props["replyTo"] = {"id": quoted["id"], "actor": quoted["actor"] if quoted["role"] == "agent" else "", "text": quoted["body"][:300]}
    row = db.conn.fetch_one(
        "INSERT INTO core_messages (id, thread_id, user_id, role, actor, body, props, status) VALUES (%s, %s, %s, 'user', %s, %s, %s, 'done') RETURNING *",
        (body.id, thread_id, me.user_id, me.display_name, text, Json(props)))
    _touch(thread_id)
    message = present_message(row)
    _announce(me.user_id, message, thread_id)
    if me.is_admin and text.split(maxsplit=1)[:1] == ["/demo"]:  # все состояния ответа — без агента
        tasks.add_task(_demo_reply, me.user_id, thread["id"], text[5:].strip())
        return {"message": message}
    from app.modules.core_agents.dispatch import dispatch

    reply = dispatch(me.user_id, thread, message, wanted=body.model, effort=body.effort)
    if reply and body.model and not thread.get("peer"):  # агент, которого выбрали, становится агентом чата
        db.conn.execute_query("UPDATE core_threads SET peer = %s WHERE id = %s", (body.model.split(":")[0], thread_id))
    return {"message": message, "reply": reply}


@router.post("/api/core/messages/{message_id}/answer")
def answer_ask(message_id: str, body: AnswerBody, me: Identity = Depends(current_identity)):
    """Ответ на вопрос агента (кнопки): вопрос помечается отвеченным, ответ уходит обычным сообщением."""
    _guard(me)
    row = db.conn.fetch_one("SELECT * FROM core_messages WHERE id = %s AND user_id = %s AND role = 'agent'", (message_id, me.user_id))
    if not row or not (row.get("props") or {}).get("ask"):
        raise HTTPException(status_code=404, detail="Вопрос не найден")
    if (row.get("props") or {}).get("answered"):
        raise HTTPException(status_code=409, detail="На этот вопрос уже ответили")
    updated = db.conn.fetch_one("UPDATE core_messages SET props = props || %s WHERE id = %s RETURNING *", (Json({"answered": body.value}), message_id))
    _push(me.user_id, {"type": "core_message", "message": present_message(updated)})
    reply = db.conn.fetch_one(
        "INSERT INTO core_messages (id, thread_id, user_id, role, actor, body, props, status) VALUES (%s, %s, %s, 'user', %s, %s, %s, 'done') RETURNING *",
        (uuid.uuid4().hex, row["thread_id"], me.user_id, me.display_name, body.value,
         Json({"replyTo": {"id": row["id"], "actor": row["actor"], "text": row["body"][:300]}})))
    _touch(row["thread_id"])
    message = present_message(reply)
    _announce(me.user_id, message, row["thread_id"])
    # Ответ на вопрос — продолжение разговора: спросивший агент работает дальше.
    from app.modules.core_agents.dispatch import dispatch

    thread = db.conn.fetch_one("SELECT * FROM core_threads WHERE id = %s", (row["thread_id"],))
    provider = (row.get("props") or {}).get("provider") or ""
    reply_agent = dispatch(me.user_id, thread, message, wanted=provider) if thread else None
    return {"message": message, "reply": reply_agent}


@router.post("/api/core/messages/{message_id}/cancel")
def cancel_reply(message_id: str, me: Identity = Depends(current_identity)):
    """Остановить ожидание ответа: агент, который ещё не взял задачу, её уже не возьмёт."""
    _guard(me)
    row = db.conn.fetch_one(
        "UPDATE core_messages SET status = 'cancelled' WHERE id = %s AND user_id = %s AND role = 'agent' AND status IN ('queued', 'working') RETURNING *",
        (message_id, me.user_id))
    if not row:
        raise HTTPException(status_code=404, detail="Ответ уже готов или не найден")
    from app.modules.core_agents import store as agents

    if agents.ready():
        agents.cancel_by_message(message_id)
    message = present_message(row)
    _announce(me.user_id, message, row["thread_id"])
    return {"message": message}


# ── демо: все состояния ответа агента, пока настоящих агентов нет ─────────────

DEMO_STEPS = [
    {"kind": "tool", "name": "search", "hint": "Поиск по «Офису»", "input": '{"query": "программа тура Карелия"}', "output": "Найдено 3 материала: «Карелия 4 дня», «Цены 2027», «Кижи — расписание»", "ms": 420},
    {"kind": "text", "text": "Нашёл программу и таблицу цен — сверю даты с расписанием парома."},
    {"kind": "tool", "name": "read_item", "hint": "Чтение документа", "input": '{"id": "d-128"}', "output": "Карелия 4 дня: Петрозаводск, Кижи, Рускеала…", "ms": 610},
    {"kind": "tool", "name": "read_table", "hint": "Чтение таблицы", "input": '{"id": "t-77", "sheet": "Цены 2027"}', "output": "Лист «Цены 2027»: 14 строк", "ms": 380},
    {"kind": "tool", "name": "update_item", "hint": "Правка документа", "input": '{"id": "d-128", "section": "Стоимость"}', "output": "Нет доступа к документу на правку", "is_error": True, "ms": 120},
]

DEMO_REPLY = """Готово, собрал короткую сводку по туру **«Карелия 4 дня»**:

| День | Что | Время |
|---|---|---|
| 1 | Петрозаводск, обзорная экскурсия | 10:00–14:00 |
| 2 | Кижи (паром) | 09:00–17:30 |
| 3 | Рускеала, горный парк | весь день |

- Цены сверил с листом «Цены 2027» — расхождений нет.
- Раздел «Стоимость» в документе поправить не смог: **нет доступа на правку**.

```
Итого на группу 20 человек: 389 000 ₽
```
"""


def _demo_reply(user_id: str, thread_id: str, mode: str) -> None:
    """Показывает весь путь ответа: «думает», цепочка шагов на глазах, ход работы, вопрос с кнопками.
    /demo fail — ответ не получился; /demo limit — упёрлись в лимит подписки."""
    started = time.monotonic()
    message = post_agent_message(user_id, thread_id, "Демо-агент", status="working", props={"steps": [], "phase": "читает «Офис»", "model": "демо", "effort": "medium"})
    steps: list[dict] = []
    for step in DEMO_STEPS:
        time.sleep(0.9)
        steps.append(step)
        current = db.conn.fetch_one("SELECT status FROM core_messages WHERE id = %s", (message["id"],))
        if not current or current["status"] == "cancelled":
            return
        update_agent_message(message["id"], props={"steps": steps, "phase": step.get("hint") or "думает"})
    time.sleep(0.8)
    work = {"input_tokens": 41_200, "cached_input_tokens": 33_900, "output_tokens": 2_350, "thinking_tokens": 1_120,
            "duration_ms": int((time.monotonic() - started) * 1000), "turns": 5, "context_tokens": 48_600, "context_window": 1_000_000}
    if mode == "fail":
        update_agent_message(message["id"], body="Агент не смог ответить: соединение с нодой оборвалось.", status="failed", props={"work": work, "failed": True})
        return
    if mode == "limit":
        update_agent_message(message["id"], body="Не успел закончить: упёрся в лимит подписки.", status="done",
                             props={"work": work, "rateLimit": {"provider": "Claude", "wait_seconds": 5400, "used_percent": 100}})
        return
    update_agent_message(message["id"], body=DEMO_REPLY, status="done", props={
        "work": work,
        "reasoning": ["Сначала найти программу и цены в «Офисе», потом сверить с расписанием парома на Кижи.",
                      "Правка раздела «Стоимость» не прошла — сообщить и спросить, что делать дальше."],
        "ask": {"kind": "choice"},
        "actions": [{"label": "Попросить доступ у автора", "value": "Попроси доступ на правку у автора документа"},
                    {"label": "Сохранить сводку заметкой", "value": "Сохрани сводку отдельной заметкой"},
                    {"label": "Ничего не делать", "value": "Пока ничего не делай"}],
    })
