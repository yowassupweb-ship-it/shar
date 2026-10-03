from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta

import anyio.to_thread

from app.core.db import db
from app.core.helpers import _ru_when, _truthy
from app.modules.chats.chat_notifications import send_notification_message
from app.modules.todos.router import _send_task_notice, _task_assignees

logger = logging.getLogger(__name__)


# ── Server-side event reminders ──────────────────────────────────────────────
# Reminders used to be fired by the client's pollCalendarReminders, so they only
# worked while a tab was open. This loop runs on the server: every minute it finds
# events whose "remind N minutes before" moment just passed and sends each recipient
# a notification (which also web-pushes), so reminders arrive even with the PWA closed.
_fired_reminders: set = set()


def _event_recipients(ev: dict) -> set:
    """Кому напоминать о событии: автору, участникам, а если им поделились со
    всеми — всем сотрудникам."""
    meta = ev.get('metadata') or {}
    if _truthy(ev.get('sharedWithAll') or meta.get('sharedWithAll')):
        try:
            return {str(u['id']) for u in (db.get_users() or []) if u and u.get('id')}
        except Exception:
            pass
    out = set()
    for r in (ev.get('user_id'), meta.get('createdBy'), meta.get('assignedTo')):
        if r:
            out.add(str(r))
    parts = meta.get('participants') or meta.get('attendees') or []
    if isinstance(parts, (list, tuple)):
        out.update(str(p) for p in parts if p)
    return out


def _check_due_reminders() -> None:
    now = datetime.now()
    # Повторения серий разворачиваем: напоминание — о каждом, а не только о
    # первой дате серии. Окно — сутки вперёд (напоминание «за день»).
    try:
        events = db.get_event_occurrences('event', (now - timedelta(hours=1)).isoformat(), (now + timedelta(days=2)).isoformat())
    except Exception as e:
        logger.debug(f"[reminders] occurrences failed: {e}")
        return
    fired = 0
    for ev in (events or []):
        try:
            meta = ev.get('metadata') or {}
            if isinstance(meta, str):
                try: meta = json.loads(meta)
                except Exception: meta = {}
            rmb = ev.get('reminderMinutesBefore', meta.get('reminderMinutesBefore'))
            all_day = bool(ev.get('allDay', meta.get('allDay')))
            if rmb is None or rmb == '':
                continue
            start_iso = ev.get('startDateTime') or meta.get('startDateTime')
            if not start_iso or 'T' not in str(start_iso):
                continue
            start = datetime.fromisoformat(str(start_iso)[:19])
            if all_day:
                start = start.replace(hour=9, minute=0)  # весь день — напоминаем утром
            reminder_time = start - timedelta(minutes=int(rmb))
            # Fire only for the reminder moment we just crossed in this ~minute tick.
            if not (now - timedelta(seconds=80) <= reminder_time <= now + timedelta(seconds=10)):
                continue
            master_id = str(ev.get('masterId') or ev.get('id'))
            key = f"{master_id}|{start.strftime('%Y-%m-%dT%H:%M')}|{reminder_time.strftime('%H:%M')}"
            if key in _fired_reminders:
                continue
            _fired_reminders.add(key)
            title = ev.get('title') or 'Событие'
            when = 'сейчас' if int(rmb) == 0 else _ru_when(str(start_iso), all_day)
            note = str(ev.get('description') or '').strip()
            body = f"🔔 {title}\n{when}" + (f"\n{note[:300]}" if note else '')
            for uid in _event_recipients(ev):
                try:
                    send_notification_message(uid, {
                        "content": body,
                        "notificationType": "event_reminder",
                        "linkedEventId": master_id,
                        "metadata": {"linkedEventId": master_id, "linkedEventTitle": title},
                    })
                    fired += 1
                except Exception as e:
                    logger.debug(f"[reminders] notify {uid} failed: {e}")
        except Exception:
            continue

    # Tasks with a deadline + a reminder time-of-day (set in the task modal).
    try:
        tasks = db.get_tasks() or []
    except Exception:
        tasks = []
    for t in tasks:
        try:
            if t.get('is_completed') or t.get('completed') or t.get('archived'):
                continue
            meta = t.get('metadata') or {}
            if isinstance(meta, str):
                try: meta = json.loads(meta)
                except Exception: meta = {}
            rtime = meta.get('reminderTime')
            due = t.get('due_date') or t.get('dueDate')
            if not rtime or not due:
                continue
            reminder_dt = datetime.fromisoformat(f"{str(due)[:10]}T{str(rtime)[:5]}:00")
            if not (now - timedelta(seconds=80) <= reminder_dt <= now + timedelta(seconds=10)):
                continue
            key = f"task-{t.get('id')}|{reminder_dt.strftime('%Y-%m-%dT%H:%M')}"
            if key in _fired_reminders:
                continue
            _fired_reminders.add(key)
            recipients = set()
            for i in (t.get('assigned_to_ids') or []):
                if i:
                    recipients.add(str(i))
            for r in (t.get('assigned_to'), t.get('author_id'), t.get('assigned_by_id')):
                if r:
                    recipients.add(str(r))
            title = t.get('title') or 'Задача'
            for uid in recipients:
                try:
                    send_notification_message(uid, {
                        "content": f"🔔 Напоминание о задаче\n{title}",
                        "notificationType": "task_updated",
                        "linkedTaskId": t.get('id'),
                        "metadata": {"linkedTaskId": t.get('id')},
                    })
                    fired += 1
                except Exception as e:
                    logger.debug(f"[reminders] task notify {uid} failed: {e}")
        except Exception:
            continue

    # Срок задачи сегодня — утром, раз в день, исполнителям (нет исполнителей —
    # автору). Раньше это слала старая страница задач с каждого устройства.
    if now.hour == 9 and now.minute == 0:
        today = now.strftime('%Y-%m-%d')
        for t in tasks:
            try:
                if t.get('is_completed') or t.get('completed') or t.get('archived'):
                    continue
                due = str(t.get('due_date') or t.get('dueDate') or '')[:10]
                if due != today:
                    continue
                key = f"deadline|{t.get('id')}|{today}"
                if key in _fired_reminders:
                    continue
                _fired_reminders.add(key)
                people = _task_assignees(t) or {str(x) for x in (t.get('author_id'), t.get('assigned_by_id')) if x}
                title = t.get('title') or 'Задача'
                for uid in people:
                    _send_task_notice(uid, 'deadline', str(t.get('id')), f"⏰ Срок сегодня\n{title}", '')
                    fired += 1
            except Exception:
                continue

    if len(_fired_reminders) > 8000:
        _fired_reminders.clear()
    if fired:
        logger.info(f"[reminders] sent {fired} reminder notification(s)")


async def reminder_loop():
    await asyncio.sleep(25)  # let startup settle
    while True:
        try:
            await anyio.to_thread.run_sync(_check_due_reminders)
        except asyncio.CancelledError:
            break
        except Exception:
            pass
        await asyncio.sleep(60)
