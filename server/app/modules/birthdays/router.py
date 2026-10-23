"""Дни рождения сотрудников.

  GET    /api/birthdays        все указанные дни рождения (для календаря и плашки «Укажите свой»)
  PUT    /api/birthdays/me     {day, month, year?} — указать свой
  DELETE /api/birthdays/me     убрать свой

В день рождения после 9:00 по Москве каждый сотрудник получает в чат уведомлений «Сегодня день рождения: …».
Задача запускается и там, где выключены общие фоновые задачи (SHAR_SCHEDULED_JOBS=0 — их ведёт старый бэкенд,
у которого дней рождения нет). Что уже разослано, отмечено в базе (app_kv) под блокировкой строки, поэтому ни
второй процесс, ни перезапуск не пришлют поздравление дважды.
"""

from __future__ import annotations

import asyncio
import calendar
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import anyio.to_thread
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import kv, schema
from app.core.db import db
from app.core.security import Identity, current_identity

router = APIRouter()
log = logging.getLogger("shar.birthdays")

# Москва без перевода часов с 2014 года; zoneinfo не берём — в образе может не быть базы поясов (tzdata).
TZ = timezone(timedelta(hours=3), "MSK")
NOTIFY_HOUR = 9

schema.register("user_birthdays", """
CREATE TABLE IF NOT EXISTS user_birthdays (
    user_id    TEXT PRIMARY KEY,
    day        SMALLINT NOT NULL,
    month      SMALLINT NOT NULL,
    year       SMALLINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)""")


class BirthdayBody(BaseModel):
    day: int = Field(ge=1, le=31)
    month: int = Field(ge=1, le=12)
    year: Optional[int] = Field(default=None, ge=1900, le=2100)


def _valid(day: int, month: int, year: Optional[int]) -> bool:
    # 29 февраля без года допустимо: в невисокосный год поздравим 28-го.
    return day <= calendar.monthrange(year or 2000, month)[1]


def list_birthdays() -> list[dict[str, Any]]:
    users = {str(u["id"]): u for u in (db.get_users() or []) if u and u.get("id")}
    rows = db.conn.fetch_all("SELECT user_id, day, month, year FROM user_birthdays") or []
    out = []
    for r in rows:
        user = users.get(str(r["user_id"]))
        if not user:  # отключённые и удалённые не показываются
            continue
        out.append({"userId": str(r["user_id"]), "name": user.get("name") or user.get("username") or "", "avatar": user.get("avatar") or "",
                    "day": r["day"], "month": r["month"], "year": r["year"]})
    out.sort(key=lambda b: (b["month"], b["day"], b["name"]))
    return out


@router.get("/api/birthdays")
def get_birthdays(me: Identity = Depends(current_identity)):
    items = list_birthdays()
    return {"items": items, "mine": next((b for b in items if b["userId"] == me.user_id), None)}


@router.put("/api/birthdays/me")
def set_my_birthday(body: BirthdayBody, me: Identity = Depends(current_identity)):
    if not _valid(body.day, body.month, body.year):
        raise HTTPException(status_code=400, detail="Такой даты нет")
    if body.year and datetime(body.year, body.month, body.day, tzinfo=TZ) > datetime.now(TZ):
        raise HTTPException(status_code=400, detail="Дата рождения в будущем")
    db.conn.execute_query(
        "INSERT INTO user_birthdays (user_id, day, month, year, updated_at) VALUES (%s,%s,%s,%s,NOW()) "
        "ON CONFLICT (user_id) DO UPDATE SET day = EXCLUDED.day, month = EXCLUDED.month, year = EXCLUDED.year, updated_at = NOW()",
        (me.user_id, body.day, body.month, body.year),
    )
    return get_birthdays(me)


@router.delete("/api/birthdays/me")
def clear_my_birthday(me: Identity = Depends(current_identity)):
    db.conn.execute_query("DELETE FROM user_birthdays WHERE user_id = %s", (me.user_id,))
    return get_birthdays(me)


def celebrants(today: datetime) -> list[dict[str, Any]]:
    """Чей день рождения сегодня. 29 февраля в невисокосный год — 28-го."""
    leap = calendar.isleap(today.year)
    out = []
    for b in list_birthdays():
        day, month = b["day"], b["month"]
        if month == 2 and day == 29 and not leap:
            day = 28
        if (day, month) == (today.day, today.month):
            out.append(b)
    return out


def notify_today(now: Optional[datetime] = None) -> int:
    """Разослать сегодняшние поздравления, если пора и ещё не разослано. Возвращает число отправленных."""
    from app.modules.chats.chat_notifications import send_notification_message

    now = now or datetime.now(TZ)
    if now.hour < NOTIFY_HOUR:
        return 0
    people = celebrants(now)
    if not people:
        return 0
    key = f"birthdays:sent:{now:%Y-%m-%d}"
    todo: list[dict[str, Any]] = []

    def claim(done: Any) -> list[str]:
        done = list(done or [])
        todo.extend(b for b in people if b["userId"] not in done)
        return done + [b["userId"] for b in todo]

    kv.update(key, [], claim)  # под блокировкой: второй процесс увидит, что уже взято
    if not todo:
        return 0
    recipients = [str(u["id"]) for u in (db.get_users() or []) if u and u.get("id")]
    sent = 0
    for b in todo:
        age = f", {now.year - b['year']}" if b.get("year") else ""
        for uid in recipients:
            text = "🎂 С днём рождения! Коллеги поздравляют вас." if uid == b["userId"] \
                else f"🎂 Сегодня день рождения: {b['name']}{age}. Не забудьте поздравить!"
            try:
                send_notification_message(uid, {"content": text, "notificationType": "birthday", "fromUserId": b["userId"] if uid != b["userId"] else None,
                                                "metadata": {"birthdayUserId": b["userId"]}})
                sent += 1
            except Exception as exc:
                log.debug("birthday notice to %s failed: %s", uid, exc)
    log.info("[birthdays] sent %s notice(s) for %s", sent, ", ".join(b["name"] for b in todo))
    return sent


async def birthday_loop():
    await asyncio.sleep(40)
    while True:
        try:
            await anyio.to_thread.run_sync(notify_today)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            log.warning("[birthdays] check failed: %s", exc)
        await asyncio.sleep(300)
