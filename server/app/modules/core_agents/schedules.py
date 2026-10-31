"""Запуски агента по расписанию: обычное сообщение в «Ядре» и обычная задача ноде.

Расписание живёт в Postgres, поэтому перезапуск сервера его не теряет. Созревшую строку
берёт один процесс; детерминированный id сообщения не даёт повторного запуска, если
процесс остановился между созданием сообщения и переносом следующего срока.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import anyio.to_thread

from app.core import schema
from app.core.db import db
from app.core.db.connection import Json
from app.modules.core_agents import dispatch, store

log = logging.getLogger("shar.core.schedules")

schema.register("core_agent_schedules", """
CREATE TABLE IF NOT EXISTS core_agent_schedules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES core_threads(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    effort TEXT NOT NULL DEFAULT 'medium',
    frequency TEXT NOT NULL CHECK (frequency IN ('once', 'daily', 'weekly')),
    run_time TEXT NOT NULL DEFAULT '09:00',
    weekdays JSONB NOT NULL DEFAULT '[]'::jsonb,
    next_run TIMESTAMPTZ NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    claimed_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_agent_schedules_due ON core_agent_schedules(next_run) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_core_agent_schedules_user ON core_agent_schedules(user_id, created_at DESC);
""")

MAX_PER_USER = 50
MAX_PROMPT = 20_000
TICK_SECONDS = 15
_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


class ScheduleError(ValueError):
    pass


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _local(value: datetime) -> datetime:
    return _aware(value).astimezone().replace(tzinfo=None)


def _iso(value: Any) -> Optional[str]:
    if not value:
        return None
    if isinstance(value, datetime):
        return _local(value).isoformat(timespec="seconds")
    return str(value)


def _parse_at(value: str) -> datetime:
    text = str(value or "").strip().replace(" ", "T")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ScheduleError("Нужно время at: 2026-11-03T15:00") from exc
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed


def _following(run_time: str, weekdays: list[int], *, after: datetime, start: Optional[datetime] = None) -> datetime:
    hour, minute = (int(x) for x in run_time.split(":"))
    candidate = _local(after).replace(hour=hour, minute=minute, second=0, microsecond=0)
    if start is not None:
        candidate = max(candidate, _local(start).replace(second=0, microsecond=0))
    allowed = set(weekdays)
    for _ in range(8):
        if candidate > _local(after) and (not allowed or candidate.weekday() in allowed):
            return candidate.astimezone()
        candidate += timedelta(days=1)
    raise ScheduleError("Не удалось вычислить следующий запуск")


def _clean_weekdays(values: Any) -> list[int]:
    if not isinstance(values, list):
        raise ScheduleError("weekdays — список чисел: 0 — понедельник, 6 — воскресенье")
    days = sorted({int(v) for v in values})
    if not days or any(v < 0 or v > 6 for v in days):
        raise ScheduleError("weekdays — числа от 0 (понедельник) до 6 (воскресенье)")
    return days


def _view(row: dict) -> dict:
    return {
        "id": row["id"], "threadId": row["thread_id"], "prompt": row["prompt"],
        "provider": row["provider"], "effort": row["effort"], "frequency": row["frequency"],
        "time": row["run_time"], "weekdays": row.get("weekdays") or [], "nextRun": _iso(row.get("next_run")),
        "enabled": bool(row["enabled"]), "lastRun": _iso(row.get("last_run_at")), "createdAt": _iso(row.get("created_at")),
        "url": f"/core?thread={row['thread_id']}",
    }


def create(user_id: str, *, prompt: str, thread_id: str = "", frequency: str = "once", at: str = "",
           run_time: str = "09:00", weekdays: Any = None, provider: str = "", effort: str = "medium") -> dict:
    text = str(prompt or "").strip()
    if not text:
        raise ScheduleError("Нужен prompt — что агент должен сделать")
    if len(text) > MAX_PROMPT:
        raise ScheduleError(f"prompt — не больше {MAX_PROMPT} символов")
    if frequency not in ("once", "daily", "weekly"):
        raise ScheduleError("frequency: once, daily или weekly")
    if effort not in ("low", "medium", "high"):
        raise ScheduleError("effort: low, medium или high")
    from app.modules.workspace import store as ws_store

    if not store.ready() or not ws_store.table_ready("core_agent_schedules"):
        raise ScheduleError("Планировщик агентов ещё не включён на сервере: нужна схема (выкладка с -Schema)")
    thread = None
    if thread_id:
        thread = db.conn.fetch_one("SELECT * FROM core_threads WHERE id = %s AND user_id = %s", (thread_id, user_id))
        if not thread:
            raise ScheduleError("Чат не найден")
    agent = dispatch.pick_agent(user_id, provider, (thread or {}).get("peer") or "")
    if agent is None:
        raise ScheduleError("Сначала подключите агента в настройках «Ядра»")
    wanted = provider or f"{agent['provider']}:{agent['model']}"
    if thread is None:
        thread = db.conn.fetch_one(
            "INSERT INTO core_threads (id, user_id, title, peer) VALUES (%s, %s, %s, %s) RETURNING *",
            (uuid.uuid4().hex[:24], user_id, f"Расписание: {text[:100]}", wanted.split(":")[0]))
    now = datetime.now(timezone.utc)
    days: list[int] = []
    if frequency == "once":
        if not at:
            raise ScheduleError("Для разового запуска нужно at")
        next_run = _parse_at(at)
        if next_run > now + timedelta(days=366):
            raise ScheduleError("Разовый запуск — не дальше чем через год")
        next_run = max(next_run, now + timedelta(seconds=2))
    else:
        if not _TIME.match(run_time):
            raise ScheduleError("time — местное время HH:MM, например 09:00")
        days = _clean_weekdays(weekdays) if frequency == "weekly" else []
        start = _parse_at(at) if at else None
        next_run = _following(run_time, days, after=now, start=start)
    count = db.conn.fetch_one("SELECT count(*)::int AS n FROM core_agent_schedules WHERE user_id = %s AND enabled", (user_id,))["n"]
    if count >= MAX_PER_USER:
        raise ScheduleError(f"Не больше {MAX_PER_USER} активных расписаний на человека")
    row = db.conn.fetch_one(
        """INSERT INTO core_agent_schedules
             (id, user_id, thread_id, prompt, provider, effort, frequency, run_time, weekdays, next_run)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *""",
        (uuid.uuid4().hex, user_id, thread["id"], text, wanted[:60], effort, frequency, run_time, Json(days), next_run))
    return _view(row)


def _schema_ready() -> bool:
    from app.modules.workspace import store as ws_store

    return store.ready() and ws_store.table_ready("core_agent_schedules")


def listing(user_id: str) -> list[dict]:
    if not _schema_ready():
        return []
    rows = db.conn.fetch_all(
        "SELECT * FROM core_agent_schedules WHERE user_id = %s ORDER BY enabled DESC, next_run, created_at DESC LIMIT 100", (user_id,)) or []
    return [_view(row) for row in rows]


def cancel(user_id: str, schedule_id: str) -> bool:
    return _schema_ready() and bool(db.conn.fetch_one(
        "DELETE FROM core_agent_schedules WHERE id = %s AND user_id = %s RETURNING id", (schedule_id, user_id)))


def _next_after(row: dict, now: datetime) -> Optional[datetime]:
    if row["frequency"] == "once":
        return None
    # Считаем от прошлого назначенного срока, а не от фактического окончания: ежедневный
    # запуск не «поплывёт» по времени, а все пропущенные окна не начнут выполняться пачкой.
    return _following(row["run_time"], row.get("weekdays") or [], after=max(_aware(row["next_run"]), now))


def _deliver(row: dict) -> None:
    from app.modules.core_chat.router import _announce, _touch, post_agent_message, present_message

    user_id, thread_id = row["user_id"], row["thread_id"]
    thread = db.conn.fetch_one("SELECT * FROM core_threads WHERE id = %s AND user_id = %s", (thread_id, user_id))
    if not thread:
        db.conn.execute_query("UPDATE core_agent_schedules SET enabled = false, claimed_at = NULL WHERE id = %s", (row["id"],))
        return
    scheduled_at = _aware(row["next_run"]).isoformat()
    digest = hashlib.sha256(f"{row['id']}:{scheduled_at}".encode()).hexdigest()[:32]
    message_id = f"sched-{digest}"
    user = db.get_user_by_id(user_id) or {}
    props = {"scheduled": {"id": row["id"], "at": scheduled_at}}
    created = db.conn.fetch_one(
        """INSERT INTO core_messages (id, thread_id, user_id, role, actor, body, props, status)
           VALUES (%s, %s, %s, 'user', %s, %s, %s, 'done') ON CONFLICT (id) DO NOTHING RETURNING *""",
        (message_id, thread_id, user_id, user.get("name") or user.get("username") or "Расписание", row["prompt"], Json(props)))
    if created:
        _touch(thread_id)
        message = present_message(created)
        _announce(user_id, message, thread_id)
    else:
        message = db.conn.fetch_one("SELECT * FROM core_messages WHERE id = %s", (message_id,))
        if not message:
            raise RuntimeError("scheduled message belongs to another thread")
        message = present_message(message)
    job = db.conn.fetch_one("SELECT id FROM core_jobs WHERE kind = 'run' AND payload->>'userMessageId' = %s", (message_id,))
    reply = None
    if not job:
        reply = dispatch.dispatch(user_id, thread, message, wanted=row["provider"], effort=row["effort"])
        if reply is None:
            post_agent_message(user_id, thread_id, "Планировщик", status="failed", props={"failed": True, "scheduled": props["scheduled"]},
                               body="Запланированный запуск не выполнен: нет подключённого агента. Подключите агента в настройках «Ядра».")
    next_run = _next_after(row, datetime.now(timezone.utc))
    db.conn.execute_query(
        """UPDATE core_agent_schedules SET next_run = COALESCE(%s, next_run), enabled = %s,
             claimed_at = NULL, last_run_at = now(), updated_at = now() WHERE id = %s""",
        (next_run, next_run is not None, row["id"]))


def deliver_due(limit: int = 20) -> int:
    if not _schema_ready():
        return 0
    rows = db.conn.fetch_all(
        """UPDATE core_agent_schedules SET claimed_at = now() WHERE id IN (
             SELECT id FROM core_agent_schedules WHERE enabled AND next_run <= now()
               AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes')
             ORDER BY next_run LIMIT %s FOR UPDATE SKIP LOCKED
           ) RETURNING *""", (limit,)) or []
    for row in sorted(rows, key=lambda r: r["next_run"]):
        try:
            _deliver(row)
        except Exception as exc:
            log.warning("[agent schedules] %s failed, will retry: %s", row.get("id"), exc)
    return len(rows)


async def schedule_loop():
    await asyncio.sleep(12)
    while True:
        try:
            await anyio.to_thread.run_sync(deliver_due)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            log.warning("[agent schedules] tick failed: %s", exc)
        await asyncio.sleep(TICK_SECONDS)
