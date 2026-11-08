"""Задача, поручённая агенту «Ядра»: просыпается по сроку, выполняет, отчитывается в задаче и засыпает.

Человек в задаче нажимает «Поручить агенту». Агент работает от его имени и с его правами — как в обычном чате «Ядра»: для
задачи заводится свой чат (там весь ход работы), а в самой задаче копятся короткие отчёты: «Выполнено» или «Сбой».

Когда просыпается:
  • срок задачи без повтора — один раз в день и час срока (нет времени у срока — в run_time, по умолчанию 09:00; срока нет
    или он уже прошёл — сразу);
  • повтор задачи (каждый день, по будням, каждую неделю, раз в две недели, каждый месяц) — на каждое ближайшее
    наступление, в то же время. Расписание берётся из самой задачи, отдельно его настраивать не нужно.
После запуска агент «засыпает»: следующий срок хранится в базе, процесс ноды закрывается сам (тёплый — по простою).

Отчёт берётся из последнего сообщения агента. Первая строка «СБОЙ…» (как просит промпт) или ошибка запуска — это сбой:
человеку приходит уведомление. Успешное разовое поручение закрывает задачу, если так отмечено (complete_on_success).

Новые таблицы на проде появляются отдельным шагом схемы; пока их нет, код ведёт себя как раньше (table_ready).
"""

from __future__ import annotations

import calendar as _calendar
import hashlib
import json
import logging
import re
import uuid
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.db.connection import Json
from app.core.security import Identity, current_identity
from app.modules.core_agents import dispatch, store

log = logging.getLogger("shar.core.task_agent")
router = APIRouter()

LOCAL_TZ = timezone(timedelta(hours=3))  # Время Шара для сотрудников — МСК, независимо от зоны хоста.
_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
MAX_REPORT = 8000
KEEP_REPORTS = 60
REPEAT_LABELS = {"daily": "каждый день", "weekdays": "по будням", "weekly": "каждую неделю", "biweekly": "раз в две недели", "monthly": "каждый месяц"}

schema.register("task_agent", """
CREATE TABLE IF NOT EXISTS task_agent (
    task_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    effort TEXT NOT NULL DEFAULT 'medium',
    thread_id TEXT NOT NULL DEFAULT '',
    run_time TEXT NOT NULL DEFAULT '09:00',
    complete_on_success BOOLEAN NOT NULL DEFAULT true,
    enabled BOOLEAN NOT NULL DEFAULT true,
    next_run TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    last_status TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_agent_due ON task_agent(next_run) WHERE enabled;
CREATE TABLE IF NOT EXISTS task_agent_reports (
    id BIGSERIAL PRIMARY KEY,
    task_id TEXT NOT NULL,
    run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'ok',
    text TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_agent_reports_task ON task_agent_reports(task_id, id DESC);
""")


def _ready() -> bool:
    from app.modules.workspace import store as ws_store

    return store.ready() and ws_store.table_ready("task_agent") and ws_store.table_ready("task_agent_reports")


# ── расписание из самой задачи ───────────────────────────────────────────────

def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=LOCAL_TZ) if value.tzinfo is None else value


def _local(value: datetime) -> datetime:
    return _aware(value).astimezone(LOCAL_TZ).replace(tzinfo=None)


def _meta(task: dict) -> dict:
    meta: Any = task.get("metadata") or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except ValueError:
            meta = {}
    return meta if isinstance(meta, dict) else {}


def _repeat_of(task: dict) -> str:
    rep = str(_meta(task).get("repeat") or "none")
    return rep if rep in REPEAT_LABELS else "none"


def _due_of(task: dict) -> Optional[datetime]:
    """Срок задачи как местное время без зоны; None — срока нет."""
    value = task.get("due_date") or task.get("dueDate")
    if not value:
        return None
    if isinstance(value, datetime):
        return _local(value)
    text = str(value).strip().replace(" ", "T")[:19]
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _matches(rule: str, day: date, base: date) -> bool:
    if day < base and rule in ("weekly", "biweekly", "monthly"):
        return False
    if rule == "daily":
        return True
    if rule == "weekdays":
        return day.weekday() < 5
    if rule == "weekly":
        return day.weekday() == base.weekday()
    if rule == "biweekly":
        return (day - base).days % 14 == 0
    if rule == "monthly":
        return day.day == min(base.day, _calendar.monthrange(day.year, day.month)[1])
    return False


def compute_next(task: dict, run_time: str, after: datetime) -> Optional[datetime]:
    """Ближайший запуск строго после `after` (aware). Повтор — по правилу задачи; без повтора — срок, если он впереди; иначе None."""
    due = _due_of(task)
    rule = _repeat_of(task)
    hour, minute = (int(x) for x in run_time.split(":"))
    if due is not None and (due.hour or due.minute):
        hour, minute = due.hour, due.minute
    after_l = _local(after)
    if rule == "none":
        if due is None:
            return None
        at = datetime.combine(due.date(), dtime(hour, minute))
        return at.replace(tzinfo=LOCAL_TZ) if at > after_l else None
    base = due.date() if due else after_l.date()
    start = max(base, after_l.date())
    for i in range(0, 800):
        day = start + timedelta(days=i)
        if not _matches(rule, day, base):
            continue
        at = datetime.combine(day, dtime(hour, minute))
        if at > after_l:
            return at.replace(tzinfo=LOCAL_TZ)
    return None


def _describe(task: dict, row: dict) -> str:
    """Словами, когда проснётся агент — для окна в задаче."""
    if not row.get("enabled"):
        return ""
    nxt = row.get("next_run")
    rule = _repeat_of(task)
    when = _local(nxt).strftime("%d.%m в %H:%M") if nxt else ""
    if rule != "none":
        return f"Просыпается {REPEAT_LABELS[rule]}, ближайший раз — {when}" if when else f"Просыпается {REPEAT_LABELS[rule]}"
    return f"Выполнит {when}" if when else "Ждёт запуска"


# ── строки и отчёты ──────────────────────────────────────────────────────────

def _row(task_id: str) -> Optional[dict]:
    return db.conn.fetch_one("SELECT * FROM task_agent WHERE task_id = %s", (task_id,))


def _reports(task_id: str) -> list[dict]:
    rows = db.conn.fetch_all("SELECT id, run_at, status, text, message_id, thread_id FROM task_agent_reports WHERE task_id = %s ORDER BY id DESC LIMIT 30", (task_id,)) or []
    return [{"id": int(r["id"]), "runAt": _local(r["run_at"]).isoformat(timespec="seconds"), "status": r["status"], "text": r["text"],
             "threadId": r["thread_id"], "messageId": r["message_id"]} for r in rows]


def _view(task: dict, row: Optional[dict], me: Identity) -> dict:
    agents = store.ready_agents(me.user_id) if store.ready() else []
    out: dict[str, Any] = {"ready": _ready(), "agents": [{"provider": a["provider"], "label": a["label"], "model": a.get("model") or ""} for a in agents],
                           "enabled": False, "reports": _reports(str(task["id"])) if _ready() else []}
    if row:
        out.update({"enabled": bool(row["enabled"]), "provider": row["provider"], "effort": row["effort"], "time": row["run_time"],
                    "completeOnSuccess": bool(row["complete_on_success"]), "threadId": row["thread_id"], "owner": row["user_id"],
                    "nextRun": _local(row["next_run"]).isoformat(timespec="seconds") if row.get("next_run") else None,
                    "lastStatus": row["last_status"], "summary": _describe(task, row)})
    return out


def _task(task_id: str, me: Identity) -> dict:
    from app.modules.todos import router as todos

    return todos._owned_task_or_403(task_id, me)


def _guard(me: Identity) -> None:
    from app.modules.core_chat.router import allowed

    if not allowed(me):
        raise HTTPException(status_code=403, detail="«Ядро» вам не включено")
    if not _ready():
        raise HTTPException(status_code=503, detail="Поручения агенту ещё не включены на сервере: нужна схема (выкладка с -Schema)")


class AgentBody(BaseModel):
    enabled: bool = True
    provider: str = Field(default="", max_length=60)
    effort: str = "medium"
    time: str = "09:00"
    completeOnSuccess: bool = True
    runNow: bool = False


@router.get("/api/todos/{task_id}/agent")
def get_agent(task_id: str, me: Identity = Depends(current_identity)):
    task = _task(task_id, me)
    row = _row(task_id) if _ready() else None
    return _view(task, row, me)


@router.put("/api/todos/{task_id}/agent")
def put_agent(task_id: str, body: AgentBody, me: Identity = Depends(current_identity)):
    task = _task(task_id, me)
    _guard(me)
    existing = _row(task_id)
    if existing and existing["user_id"] != me.user_id and not me.is_admin:
        raise HTTPException(status_code=403, detail="Задачу уже поручил своему агенту другой человек")
    owner = existing["user_id"] if existing else me.user_id
    if not body.enabled:
        if existing:
            db.conn.execute_query("UPDATE task_agent SET enabled = false, next_run = NULL, claimed_at = NULL, updated_at = now() WHERE task_id = %s", (task_id,))
        return _view(task, _row(task_id), me)
    if body.effort not in ("low", "medium", "high"):
        raise HTTPException(status_code=400, detail="effort: low, medium или high")
    if not _TIME.match(body.time):
        raise HTTPException(status_code=400, detail="time — HH:MM, например 09:00")
    agent = dispatch.pick_agent(owner, body.provider, "")
    if agent is None:
        raise HTTPException(status_code=400, detail="Сначала подключите агента в настройках «Ядра»")
    wanted = body.provider or f"{agent['provider']}:{agent['model']}"
    now = datetime.now(timezone.utc)
    nxt = compute_next(task, body.time, now)
    if nxt is None or body.runNow:  # нет срока впереди (или просили «сейчас») — запуск сразу
        nxt = now + timedelta(seconds=2)
    thread_id = (existing or {}).get("thread_id") or ""
    if not thread_id or not db.conn.fetch_one("SELECT 1 FROM core_threads WHERE id = %s", (thread_id,)):
        thread = db.conn.fetch_one("INSERT INTO core_threads (id, user_id, title, peer) VALUES (%s, %s, %s, %s) RETURNING id",
                                   (uuid.uuid4().hex[:24], owner, f"Задача: {(task.get('title') or 'без названия')[:100]}", wanted.split(":")[0]))
        thread_id = thread["id"]
    db.conn.execute_query(
        """INSERT INTO task_agent (task_id, user_id, provider, effort, thread_id, run_time, complete_on_success, enabled, next_run)
           VALUES (%s, %s, %s, %s, %s, %s, %s, true, %s)
           ON CONFLICT (task_id) DO UPDATE SET provider = EXCLUDED.provider, effort = EXCLUDED.effort, thread_id = EXCLUDED.thread_id,
             run_time = EXCLUDED.run_time, complete_on_success = EXCLUDED.complete_on_success, enabled = true, next_run = EXCLUDED.next_run,
             claimed_at = NULL, updated_at = now()""",
        (task_id, owner, wanted[:60], body.effort, thread_id, body.time, body.completeOnSuccess, nxt))
    if body.runNow or (nxt - now) < timedelta(seconds=5):
        deliver_due()
    return _view(task, _row(task_id), me)


@router.post("/api/todos/{task_id}/agent/run")
def run_now(task_id: str, me: Identity = Depends(current_identity)):
    """«Выполнить сейчас»: тем же способом, что и по сроку; расписание дальше не меняется."""
    task = _task(task_id, me)
    _guard(me)
    row = _row(task_id)
    if not row:
        raise HTTPException(status_code=400, detail="Задача не поручена агенту")
    if row["user_id"] != me.user_id and not me.is_admin:
        raise HTTPException(status_code=403, detail="Задачу поручил своему агенту другой человек")
    _deliver({**row, "next_run": datetime.now(timezone.utc), "_manual": True}, task)
    return _view(task, _row(task_id), me)


# ── запуск ───────────────────────────────────────────────────────────────────

def _prompt(task: dict) -> str:
    meta = _meta(task)
    md = meta.get("md") if isinstance(meta.get("md"), str) else str(task.get("description") or "")
    rule = _repeat_of(task)
    kind = f"Регулярная задача ({REPEAT_LABELS[rule]}): запуск повторится в следующий срок, а ваши отчёты копятся в самой задаче." if rule != "none" \
        else "Разовое поручение: после успешного отчёта задача закроется."
    return (f"Поручение из задачи Шара «{task.get('title') or 'без названия'}» (id {task['id']}). "
            f"Выполните её сейчас сами — инструментами Шара (карточка задачи: task_read по id) и подключёнными интеграциями.\n\n{md.strip()}\n\n"
            f"{kind}\nЗакончите коротким отчётом (3–8 строк): первая строка — «ГОТОВО» или «СБОЙ: причина»; дальше что сделано, ключевые цифры, "
            "ссылки на созданные материалы. Если без решения человека не обойтись — задайте один вопрос через ask_user и закончите ответ.")


def _deliver(row: dict, task: Optional[dict] = None) -> None:
    from app.modules.core_chat.router import _announce, _touch, post_agent_message, present_message

    task = task or db.get_task(row["task_id"])
    user_id, thread_id = row["user_id"], row["thread_id"]
    thread = db.conn.fetch_one("SELECT * FROM core_threads WHERE id = %s AND user_id = %s", (thread_id, user_id))
    manual = bool(row.get("_manual"))
    if not task or not thread or task.get("archived") or (task.get("is_completed") and not manual):
        db.conn.execute_query("UPDATE task_agent SET enabled = false, next_run = NULL, claimed_at = NULL WHERE task_id = %s", (row["task_id"],))
        return
    at = _aware(row["next_run"])
    scheduled_at = at.isoformat()
    digest = hashlib.sha256(f"{row['task_id']}:{scheduled_at}:{'m' if manual else 's'}".encode()).hexdigest()[:32]
    message_id = f"taskrun-{digest}"
    user = db.get_user_by_id(user_id) or {}
    props = {"taskRun": {"taskId": row["task_id"], "at": scheduled_at}}
    created = db.conn.fetch_one(
        """INSERT INTO core_messages (id, thread_id, user_id, role, actor, body, props, status)
           VALUES (%s, %s, %s, 'user', %s, %s, %s, 'done') ON CONFLICT (id) DO NOTHING RETURNING *""",
        (message_id, thread_id, user_id, user.get("name") or user.get("username") or "Задача", _prompt(task), Json(props)))
    if created:
        _touch(thread_id)
        message = present_message(created)
        _announce(user_id, message, thread_id)
    else:
        message = db.conn.fetch_one("SELECT * FROM core_messages WHERE id = %s", (message_id,))
        message = present_message(message) if message else None
    job = db.conn.fetch_one("SELECT id FROM core_jobs WHERE kind = 'run' AND payload->>'userMessageId' = %s", (message_id,))
    if message and not job:
        reply = dispatch.dispatch(user_id, thread, message, wanted=row["provider"], effort=row["effort"])
        if reply is None:
            _report(row["task_id"], user_id, "failed", "Запуск не выполнен: нет подключённого агента. Подключите агента в настройках «Ядра».", "", thread_id, at)
    if manual:
        return  # ручной запуск расписание не двигает
    # Разовое поручение отработало — засыпает насовсем (срок задачи не «следующий запуск»); повтор — до следующего раза.
    nxt = compute_next(task, row["run_time"], max(at, datetime.now(timezone.utc))) if _repeat_of(task) != "none" else None
    db.conn.execute_query(
        "UPDATE task_agent SET next_run = %s, enabled = %s, claimed_at = NULL, last_run_at = now(), updated_at = now() WHERE task_id = %s",
        (nxt, nxt is not None, row["task_id"]))


def deliver_due(limit: int = 20) -> int:
    if not _ready():
        return 0
    rows = db.conn.fetch_all(
        """UPDATE task_agent SET claimed_at = now() WHERE task_id IN (
             SELECT task_id FROM task_agent WHERE enabled AND next_run <= now()
               AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes')
             ORDER BY next_run LIMIT %s FOR UPDATE SKIP LOCKED
           ) RETURNING *""", (limit,)) or []
    for row in sorted(rows, key=lambda r: r["next_run"]):
        try:
            _deliver(row)
        except Exception as exc:
            log.warning("[task agent] %s failed, will retry: %s", row.get("task_id"), exc)
    return len(rows)


def reschedule(task: Optional[dict]) -> None:
    """Задачу поправили (срок, повтор): пересчитать следующий запуск у включённого поручения."""
    if not task or not _ready():
        return
    row = _row(str(task["id"]))
    if not row or not row["enabled"]:
        return
    nxt = compute_next(task, row["run_time"], datetime.now(timezone.utc))
    if nxt is not None:
        db.conn.execute_query("UPDATE task_agent SET next_run = %s, updated_at = now() WHERE task_id = %s AND claimed_at IS NULL", (nxt, row["task_id"]))


# ── отчёты ───────────────────────────────────────────────────────────────────

def _report(task_id: str, user_id: str, status: str, text: str, message_id: str, thread_id: str, run_at: datetime) -> None:
    db.conn.execute_query(
        "INSERT INTO task_agent_reports (task_id, run_at, status, text, message_id, thread_id) VALUES (%s, %s, %s, %s, %s, %s)",
        (task_id, run_at, status, text[:MAX_REPORT], message_id, thread_id))
    db.conn.execute_query("DELETE FROM task_agent_reports WHERE task_id = %s AND id NOT IN (SELECT id FROM task_agent_reports WHERE task_id = %s ORDER BY id DESC LIMIT %s)",
                          (task_id, task_id, KEEP_REPORTS))
    db.conn.execute_query("UPDATE task_agent SET last_status = %s WHERE task_id = %s", (status, task_id))
    try:
        from app.core.realtime import sse_manager

        sse_manager.push(user_id, {"type": "task_agent_report", "taskId": task_id})
    except Exception as exc:  # живое обновление не должно ломать запись отчёта
        log.debug("push failed: %s", exc)
    if status == "failed":
        try:
            from app.modules.todos import router as todos

            task = db.get_task(task_id) or {}
            todos._send_task_notice(user_id, "task_updated", task_id, f"⚠ Агент не выполнил задачу\n{task.get('title') or ''}\n{text.strip()[:160]}", "")
        except Exception as exc:
            log.debug("notice failed: %s", exc)


def finished(job: dict, kind: str, body: str) -> None:
    """Ответ агента закончился (core_agents/node.py): если это запуск по задаче — записать отчёт, при успехе закрыть разовую задачу."""
    if not _ready():
        return
    payload = job.get("payload") or {}
    user_msg = db.conn.fetch_one("SELECT props FROM core_messages WHERE id = %s", (payload.get("userMessageId"),))
    run = ((user_msg or {}).get("props") or {}).get("taskRun")
    if not run:
        return
    task_id = str(run["taskId"])
    text = (body or "").strip()
    failed = kind == "failed" or bool(re.match(r"^\W*сбой", text, re.I))
    at = _aware(datetime.fromisoformat(str(run["at"])))
    _report(task_id, job["user_id"], "failed" if failed else "ok", text, job["message_id"], str(payload.get("threadId") or ""), at)
    row = _row(task_id)
    task = db.get_task(task_id)
    if failed or not row or not row["complete_on_success"] or not task or _repeat_of(task) != "none":
        return
    done = db.update_task(task_id, {"isCompleted": True})
    if done:
        from app.modules.todos import router as todos

        todos._push_task_sse(done, event="task_updated")
