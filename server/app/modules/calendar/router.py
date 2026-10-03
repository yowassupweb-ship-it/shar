from __future__ import annotations

import logging
import re
import time as _time
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from dateutil.parser import isoparse as _isoparse
from fastapi import APIRouter, Depends, HTTPException

from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.helpers import _ru_when, _truthy
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity, require_admin
from app.modules.chats.chat_notifications import send_notification_message

router = APIRouter()

logger = logging.getLogger(__name__)


def _to_iso_date_string(value: Any) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, str):
        return value[:10]
    return ''


def _get_event_types_settings() -> List[Dict[str, Any]]:
    settings = db.get_settings() or {}
    types = settings.get('eventTypes') or settings.get('event_types') or []
    if isinstance(types, list):
        return types
    return []


def _save_event_types_settings(types: List[Dict[str, Any]]):
    db.update_settings({"eventTypes": types})


def _event_participants(event: Optional[Dict[str, Any]]) -> List[str]:
    raw = (event or {}).get('participants') or []
    return [str(p).strip() for p in raw if p] if isinstance(raw, list) else []


def _event_owner(event: Optional[Dict[str, Any]]) -> str:
    e = event or {}
    return str(e.get('created_by') or e.get('createdBy') or e.get('user_id') or '').strip()


def _is_new_calendar_event(event: Dict[str, Any]) -> bool:
    """Событие создано новым календарём (или повтором задачи): у них свой тип и
    явное поле «поделиться со всеми». Старые события старого календаря — нет."""
    meta = event.get('metadata') or {}
    kind = str(event.get('event_type') or event.get('type') or meta.get('type') or '')
    return kind in ('personal', 'task') or 'sharedWithAll' in meta or bool(meta.get('taskRepeat'))


def _event_visible_personal(event: Dict[str, Any], user_id: str) -> bool:
    """Календарь нового Шара: у каждого только личный календарь. Событие видят
    автор, те, с кем им поделились (participants), и все — если поделились со
    всеми (sharedWithAll). «Общего календаря» и правила «нет участников —
    видно всем» здесь нет."""
    return (
        _event_owner(event) == user_id
        or user_id in _event_participants(event)
        or _truthy(event.get('sharedWithAll'))
    )


def _notify_calendar(*events: Optional[Dict[str, Any]]) -> None:
    """Сообщить в сокет всем, чей календарь могла изменить запись: автору и
    участникам до и после правки, а если событие было или стало общим для всех —
    всем подключённым. Клиент перечитывает видимый диапазон."""
    try:
        everyone = any(_truthy((e or {}).get('sharedWithAll')) for e in events)
        if everyone:
            with sse_manager._lock:
                targets = set(sse_manager._queues.keys())
        else:
            targets = set()
            for e in events:
                if e:
                    targets.update(_event_participants(e))
                    if _event_owner(e):
                        targets.add(_event_owner(e))
        event_id = next((str(e.get('id')) for e in events if e and e.get('id')), '')
        for uid in targets:
            sse_manager.push(uid, {'type': 'calendar_changed', 'eventId': event_id})
    except Exception as e:
        logger.debug(f"[calendar] notify failed: {e}")


def _announce_shared(before: Optional[Dict[str, Any]], after: Optional[Dict[str, Any]]) -> None:
    """Событием поделились — одно уведомление в чат «Уведомления» тем, кого
    добавили (или всем, если событие стало общим для всех). Автору — нет: он
    сам его создал. Раньше объявления слало каждое открытое приложение."""
    if not after:
        return
    try:
        owner = _event_owner(after)
        was_all = _truthy((before or {}).get('sharedWithAll'))
        if _truthy(after.get('sharedWithAll')) and not was_all:
            targets = {str(u['id']) for u in (db.get_users() or []) if u and u.get('id')}
        else:
            targets = set(_event_participants(after)) - set(_event_participants(before)) - (set() if not was_all else set(_event_participants(after)))
        targets.discard(owner)
        if not targets:
            return
        title = after.get('title') or 'Событие'
        author = after.get('createdByName') or (db.get_user(owner) or {}).get('name') or 'Коллега'
        start = after.get('startDateTime') or ''
        when = _ru_when(start, bool(after.get('allDay'))) if start else ''
        note = str(after.get('description') or '').strip()
        body = f"📅 {author} поделился(-ась) событием\n{title}" + (f"\n{when}" if when else '') + (f"\n{note[:300]}" if note else '')
        event_id = str(after.get('recurrenceMasterId') or after.get('id') or '')
        for uid in targets:
            try:
                send_notification_message(uid, {
                    "content": body,
                    "notificationType": "event_update",
                    "linkedEventId": event_id,
                    "fromUserId": owner,
                    "metadata": {"linkedEventId": event_id, "linkedEventTitle": title},
                })
            except Exception as e:
                logger.debug(f"[calendar] announce {uid} failed: {e}")
    except Exception as e:
        logger.debug(f"[calendar] announce failed: {e}")



def _can_view_event(event: Optional[Dict[str, Any]], me: Identity) -> bool:
    """Видимость одного события — то же правило, что в списке (get_events)."""
    if not event:
        return False
    if _is_new_calendar_event(event):
        return _event_visible_personal(event, me.user_id)
    if me.is_admin:
        return True
    user = db.get_user_by_id(me.user_id) or {}
    if user.get('can_see_all_tasks'):
        return True
    participants = _event_participants(event)
    return _event_owner(event) == me.user_id or me.user_id in participants or not participants


def _event_for_edit(event_id: str, me: Identity, entity: str = 'event') -> Dict[str, Any]:
    """Событие, которое можно менять: его автор или админ. Участники только видят."""
    event = db.get_event(event_id, entity=entity) if entity else db.get_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    if not (me.is_admin or _event_owner(event) == me.user_id):
        raise HTTPException(status_code=403, detail="Событие меняет его автор")
    return event


@router.get("/api/events")
def get_events(
    startDate: Optional[str] = None,
    endDate: Optional[str] = None,
    type: Optional[str] = None,
    tag: Optional[str] = None,
    userId: Optional[str] = None,
    personal: bool = False,
    me: Identity = Depends(current_identity),
):
    # Materialise the next occurrence of recurring task-series before reading, so the
    # calendar always shows exactly one upcoming instance (plus the past ones already
    # stored). This is the calendar's real data source — /api/calendar-events, which
    # also rolls, isn't what the UI fetches. Throttled internally, so cheap here.
    _roll_recurring_calendar_events()
    # Permission filtering runs on masters/plain rows BEFORE recurrence expansion —
    # one check per series, not per occurrence, and correct either way since every
    # expanded occurrence inherits its master's created_by/participants.
    can_see_all = False
    normalized_user_id = me.user_id  # видимость — от вошедшего, а не от присланного userId
    if normalized_user_id:
        user = db.get_user_by_id(normalized_user_id) or db.get_user(normalized_user_id)
        can_see_all = bool(
            (user or {}).get('can_see_all_tasks')
            or (user or {}).get('canSeeAllTasks')
            or (user or {}).get('role') == 'admin'
        )

    def visible_for_user(event: Dict[str, Any]) -> bool:
        if personal and normalized_user_id:
            return _event_visible_personal(event, normalized_user_id)
        # События нового календаря — всегда по его правилу (автор, участники,
        # «со всеми»), даже в старом запросе и для админа. По старому правилу
        # («нет участников — видно всем») личное «Только я» считалось общим, и
        # старые приложения присылали всем «Новое событие».
        if normalized_user_id and _is_new_calendar_event(event):
            return _event_visible_personal(event, normalized_user_id)
        if not normalized_user_id or can_see_all:
            return True
        created_by = str(event.get('created_by') or event.get('createdBy') or event.get('user_id') or '').strip()
        participants = event.get('participants') or []
        participants = [str(p).strip() for p in participants] if isinstance(participants, list) else []
        if created_by == normalized_user_id:
            return True
        if normalized_user_id in participants:
            return True
        return len(participants) == 0

    expanded = bool(startDate and endDate)
    if expanded:
        base = db.get_events(entity='event')
        visible_ids = {e['id'] for e in base if visible_for_user(e)}
        occurrences = db.get_event_occurrences('event', startDate, endDate)
        filtered = [
            occ for occ in occurrences
            if (occ.get('masterId') or occ.get('id')) in visible_ids
        ]
    else:
        filtered = [event for event in db.get_events(entity='event') if visible_for_user(event)]

    if startDate and not expanded:
        filtered = [
            event for event in filtered
            if _to_iso_date_string(event.get('start_date')) >= startDate
            or (_to_iso_date_string(event.get('end_date')) and _to_iso_date_string(event.get('end_date')) >= startDate)
        ]

    if endDate and not expanded:
        filtered = [
            event for event in filtered
            if _to_iso_date_string(event.get('start_date')) <= endDate
        ]

    if type:
        filtered = [
            event for event in filtered
            if str(event.get('event_type') or event.get('type') or '') == type
        ]

    if tag:
        filtered = [
            event for event in filtered
            if tag in (event.get('tags') or [])
        ]

    filtered.sort(key=lambda event: _to_iso_date_string(event.get('start_date')), reverse=True)

    return {
        "success": True,
        "events": [snake_to_camel(event) for event in filtered],
        "types": _get_event_types_settings(),
        "total": len(filtered)
    }


@router.post("/api/events")
def create_event(event_data: Dict[str, Any], me: Identity = Depends(current_identity)):
    start_value = event_data.get('startDate') or event_data.get('startDateTime')
    if not event_data.get('title') or not start_value:
        raise HTTPException(status_code=400, detail="Missing required fields: title, startDate")

    payload = {
        **event_data,
        'id': event_data.get('id') or f"event_{int(datetime.now().timestamp() * 1000)}",
        'entity': 'event',
        'start_date': event_data.get('startDate') or event_data.get('start_date') or event_data.get('startDateTime'),
        'end_date': event_data.get('endDate') or event_data.get('end_date') or event_data.get('endDateTime'),
        'user_id': me.user_id,
        'createdBy': me.user_id,
        'created_by': me.user_id,
    }
    created = db.add_event(payload)
    if not created:
        raise HTTPException(status_code=500, detail="Failed to create event")
    _notify_calendar(created)
    _announce_shared(None, created)
    return snake_to_camel(created)


def _apply_event_edit(event_id: str, event_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Applies an update honoring editScope ('this'|'following'|'all', default 'all')
    for recurring events. 'this'/'following' require recurrenceId (the ISO start of the
    occurrence being edited)."""
    edit_scope = event_data.get('editScope') or 'all'
    recurrence_id = event_data.get('recurrenceId')
    fields = {k: v for k, v in event_data.items() if k not in ('id', 'editScope')}

    if edit_scope == 'all' or not recurrence_id:
        return db.update_event(event_id, fields)

    if edit_scope == 'following':
        return db.split_recurrence_series(event_id, recurrence_id, fields)

    # edit_scope == 'this': find-or-create an override row for this single occurrence
    master = db.get_event(event_id)
    if not master:
        return None
    existing_override = next(
        (e for e in db.get_events(master.get('entity'))
         if e.get('recurrenceMasterId') == event_id and e.get('recurrenceId') == recurrence_id),
        None
    )
    if existing_override:
        return db.update_event(existing_override['id'], fields)

    override_data = dict(master)
    override_data.update(fields)
    override_data['id'] = f"{event_id}-occ-{int(datetime.now().timestamp() * 1000)}"
    override_data['recurrenceMasterId'] = event_id
    override_data['recurrenceId'] = recurrence_id
    override_data['recurrenceRule'] = None
    override_data['startDateTime'] = fields.get('startDateTime') or recurrence_id
    return db.add_event(override_data)


def _apply_event_delete(event_id: str, delete_scope: str, recurrence_id: Optional[str]) -> bool:
    """Applies a delete honoring deleteScope ('this'|'all', default 'all')."""
    if delete_scope == 'this' and recurrence_id:
        db.add_event_exdate(event_id, recurrence_id)
        existing_override = next(
            (e for e in db.get_events('event')
             if e.get('recurrenceMasterId') == event_id and e.get('recurrenceId') == recurrence_id),
            None
        )
        if existing_override:
            db.delete_event(existing_override['id'])
        return True

    # 'all': delete the row itself, plus any override rows if it's a recurring master
    for ov in db.get_events('event'):
        if ov.get('recurrenceMasterId') == event_id:
            db.delete_event(ov['id'])
    return db.delete_event(event_id)


@router.put("/api/events")
def update_event(event_data: Dict[str, Any], me: Identity = Depends(current_identity)):
    event_id = event_data.get('id')
    if not event_id:
        raise HTTPException(status_code=400, detail="Event ID is required")

    before = _event_for_edit(event_id, me, entity=None)
    event_data = {k: v for k, v in event_data.items() if k not in ('createdBy', 'created_by', 'user_id')}
    updated = _apply_event_edit(event_id, event_data)
    if not updated:
        raise HTTPException(status_code=404, detail="Event not found")
    _notify_calendar(before, updated)
    _announce_shared(before, updated)
    return {"success": True, "event": snake_to_camel(updated)}


@router.delete("/api/events")
def delete_event(id: Optional[str] = None, deleteScope: str = 'all', recurrenceId: Optional[str] = None, me: Identity = Depends(current_identity)):
    if not id:
        raise HTTPException(status_code=400, detail="Event ID is required")

    event = _event_for_edit(id, me)

    if not _apply_event_delete(id, deleteScope, recurrenceId):
        raise HTTPException(status_code=500, detail="Failed to delete event")
    _notify_calendar(event)

    return {"success": True, "event": snake_to_camel(event)}


@router.get("/api/events/{event_id}")
def get_event_by_id(event_id: str, me: Identity = Depends(current_identity)):
    event = db.get_event(event_id, entity='event')
    if not event or not _can_view_event(event, me):
        raise HTTPException(status_code=404, detail="Event not found")
    return snake_to_camel(event)


@router.put("/api/events/{event_id}")
def update_event_by_id(event_id: str, updates: Dict[str, Any], me: Identity = Depends(current_identity)):
    before = _event_for_edit(event_id, me, entity=None)
    updates = {k: v for k, v in updates.items() if k not in ('createdBy', 'created_by', 'user_id')}
    updated = _apply_event_edit(event_id, {**updates, 'id': event_id})
    if not updated or updated.get('entity') != 'event':
        raise HTTPException(status_code=404, detail="Event not found")
    _notify_calendar(before, updated)
    _announce_shared(before, updated)
    return snake_to_camel(updated)


@router.delete("/api/events/{event_id}")
def delete_event_by_id(event_id: str, deleteScope: str = 'all', recurrenceId: Optional[str] = None, me: Identity = Depends(current_identity)):
    event = _event_for_edit(event_id, me)
    if not _apply_event_delete(event_id, deleteScope, recurrenceId):
        raise HTTPException(status_code=500, detail="Failed to delete event")
    _notify_calendar(event)
    return {"success": True}


@router.get("/api/event-types")
def get_event_types(me: Identity = Depends(current_identity)):
    return {"success": True, "types": _get_event_types_settings()}


@router.post("/api/event-types")
def create_event_type(event_type_data: Dict[str, Any], me: Identity = Depends(require_admin)):
    type_id = event_type_data.get('id')
    if not type_id or not event_type_data.get('name') or not event_type_data.get('color') or not event_type_data.get('icon'):
        raise HTTPException(status_code=400, detail="Missing required fields: id, name, color, icon")

    types = _get_event_types_settings()
    if any(str(item.get('id')) == str(type_id) for item in types):
        raise HTTPException(status_code=400, detail="Type with this ID already exists")

    new_type = {
        "id": type_id,
        "name": event_type_data.get('name'),
        "color": event_type_data.get('color'),
        "icon": event_type_data.get('icon')
    }
    types.append(new_type)
    _save_event_types_settings(types)
    return {"success": True, "type": new_type}


@router.delete("/api/event-types")
def delete_event_type(id: Optional[str] = None, me: Identity = Depends(require_admin)):
    if not id:
        raise HTTPException(status_code=400, detail="Type ID is required")

    types = _get_event_types_settings()
    next_types = [item for item in types if str(item.get('id')) != str(id)]
    if len(next_types) == len(types):
        raise HTTPException(status_code=404, detail="Type not found")

    _save_event_types_settings(next_types)
    return {"success": True}


# DEPRECATED shim — /api/calendar-events used to be a second, unrelated event store.
# It now routes to the same unified `entity='event'` rows as /api/events (one physical
# dataset, one permission model), translating the old flat shape (date/time/remind:bool)
# at the edges so existing callers (Todos, chat's EventCalendarSelector, ContentPlan,
# browserPushService reminders) keep working unmodified. New code should call /api/events.
def _legacy_calendar_payload_in(data: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(data)
    date_str = payload.get('date')
    time_str = payload.get('time')
    if date_str and 'startDateTime' not in payload:
        payload['startDateTime'] = f"{date_str}T{time_str}:00" if time_str else f"{date_str}T00:00:00"
        payload['allDay'] = not bool(time_str)
    if 'remind' in payload and 'reminderMinutesBefore' not in payload:
        payload['reminderMinutesBefore'] = 15 if payload.get('remind') else None
    return payload


def _legacy_calendar_event_out(event: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(event)
    start_dt = out.get('startDateTime')
    if start_dt and not out.get('date'):
        out['date'] = start_dt[:10]
        out['time'] = None if out.get('allDay') else start_dt[11:16]
    if 'remind' not in out:
        # 0 — «в момент начала», это тоже напоминание.
        out['remind'] = out.get('reminderMinutesBefore') not in (None, '')
    return out


_RECURRENCE_STEPS = {'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'}


def _next_recurrence_date(current: datetime, recurrence: str) -> Optional[datetime]:
    if recurrence == 'daily':
        return current + timedelta(days=1)
    if recurrence == 'weekdays':
        # Рабочая неделя — каждый будний день, выходные пропускаем.
        nxt = current + timedelta(days=1)
        while nxt.weekday() >= 5:  # 5=Sat, 6=Sun
            nxt += timedelta(days=1)
        return nxt
    if recurrence == 'weekly':
        return current + timedelta(days=7)
    if recurrence == 'biweekly':
        return current + timedelta(days=14)
    if recurrence == 'yearly':
        return current.replace(year=current.year + 1)
    if recurrence in ('monthly', 'quarterly'):
        step = 1 if recurrence == 'monthly' else 3
        month = current.month - 1 + step
        year = current.year + month // 12
        month = month % 12 + 1
        # 31-е число в коротком месяце: прижимаем к последнему дню, как это
        # делает большинство календарей, вместо переноса на следующий месяц.
        import calendar as _cal
        day = min(current.day, _cal.monthrange(year, month)[1])
        return current.replace(year=year, month=month, day=day)
    return None


_last_recurring_roll_at = 0.0


def _roll_recurring_calendar_events(force: bool = False) -> int:
    """Догоняет серии повторяющихся задач до «ровно один будущий срок».

    Возвращает число созданных занятий. Ошибки не пробрасывает: календарь
    важнее, чем докатка, и не должен падать целиком из-за одной кривой серии.
    Throttled so it's cheap to call on every calendar/task read — it actually does
    the work at most once per ~20s (pass force=True for the manual endpoint)."""
    global _last_recurring_roll_at
    now = _time.monotonic()
    if not force and (now - _last_recurring_roll_at) < 20:
        return 0
    _last_recurring_roll_at = now
    created_total = 0
    try:
        events = db.get_events(entity='event') or []
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

        # Серия — это все занятия одной задачи. Ключом служит sourceId (id
        # задачи); если его нет, серию не трогаем: без общего ключа занятия
        # неотличимы от одиночных событий.
        series: Dict[str, List[Dict[str, Any]]] = {}
        for ev in events:
            meta = ev.get('metadata') or {}
            recurrence = str(meta.get('recurrence') or '').strip()
            source_id = str(meta.get('sourceId') or meta.get('source_id') or '').strip()
            if recurrence in _RECURRENCE_STEPS and source_id:
                series.setdefault(source_id, []).append(ev)

        for source_id, items in series.items():
            dated = []
            for ev in items:
                raw = ev.get('start_date') or (ev.get('metadata') or {}).get('date')
                if not raw:
                    continue
                try:
                    dated.append((_isoparse(str(raw)).replace(tzinfo=None), ev))
                except (ValueError, TypeError):
                    continue
            if not dated:
                continue
            dated.sort(key=lambda pair: pair[0])
            last_date, last_event = dated[-1]

            # Будущий срок уже есть — серия в порядке.
            if last_date >= today:
                continue

            meta = last_event.get('metadata') or {}
            recurrence = str(meta.get('recurrence') or '').strip()
            cursor = last_date
            guard = 0
            # Заполняем пропущенные сроки и останавливаемся на первом будущем,
            # чтобы вперёд всегда стоял ровно один.
            while guard < 500:
                guard += 1
                nxt = _next_recurrence_date(cursor, recurrence)
                if not nxt or nxt <= cursor:
                    break
                cursor = nxt
                payload = {
                    'id': str(uuid.uuid4()),
                    'title': last_event.get('title') or 'Без названия',
                    'description': last_event.get('description') or '',
                    'entity': 'event',
                    'start_date': cursor.date().isoformat(),
                    'end_date': None,
                    'user_id': last_event.get('user_id'),
                    'metadata': {**meta, 'date': cursor.date().isoformat()},
                }
                try:
                    if db.add_event(payload):
                        created_total += 1
                except Exception as e:
                    logger.warning(f"[recurring] failed to add occurrence for {source_id}: {e}")
                    break
                if cursor >= today:
                    break

        # Повтор задачи из нового Шара: серия с UNTIL — в календаре всегда месяц
        # вперёд. Горизонт сдвигаем здесь, при чтении календаря.
        horizon = (today + timedelta(days=31)).strftime('%Y%m%dT235959')
        refresh_before = (today + timedelta(days=24)).strftime('%Y%m%d')
        for ev in events:
            rule = str(ev.get('recurrenceRule') or '')
            if not ev.get('taskRepeat') or 'UNTIL=' not in rule:
                continue
            until = rule.split('UNTIL=', 1)[1][:8]
            if until < refresh_before:
                new_rule = re.sub(r'UNTIL=[0-9TZ]+', f'UNTIL={horizon}', rule)
                try:
                    db.update_event(ev['id'], {'recurrenceRule': new_rule})
                except Exception as e:
                    logger.warning(f"[recurring] не продлил повтор задачи {ev.get('id')}: {e}")

        if created_total:
            logger.info(f"[recurring] materialised {created_total} upcoming occurrence(s)")
    except Exception as e:
        logger.error(f"[recurring] roll failed: {e}")
    return created_total


@router.get("/api/calendar-events")
def get_calendar_events(me: Identity = Depends(current_identity)):
    # Докатываем серии при чтении: отдельного планировщика не нужно, а календарь
    # открывают достаточно часто, чтобы следующий срок появлялся вовремя.
    _roll_recurring_calendar_events()
    events = db.get_events(entity='event')
    # Личные события нового календаря — только тем, кому они видны: этот старый
    # адрес отдавал всё всем (старый календарь показывал чужие «Только я»).
    events = [e for e in events if _can_view_event(e, me)]
    return [snake_to_camel(_legacy_calendar_event_out(event)) for event in events]


@router.post("/api/calendar-events/roll-recurring")
def roll_recurring_now(me: Identity = Depends(require_admin)):
    """Ручной прогон докатки — для проверки и разовых починок."""
    return {"created": _roll_recurring_calendar_events(force=True)}


@router.post("/api/calendar-events")
def create_calendar_event(event_data: Dict[str, Any], me: Identity = Depends(current_identity)):
    payload = {
        **_legacy_calendar_payload_in(event_data),
        'id': event_data.get('id') or str(uuid.uuid4()),
        'title': event_data.get('title') or 'Без названия',
        'description': event_data.get('description') or '',
        'entity': 'event',
        'start_date': event_data.get('date') or event_data.get('startDate') or datetime.now().date().isoformat(),
        'end_date': event_data.get('endDate') or event_data.get('end_date'),
        'user_id': me.user_id,
        'createdBy': me.user_id,
        'created_by': me.user_id,
    }
    created = db.add_event(payload)
    if not created:
        raise HTTPException(status_code=500, detail="Failed to create calendar event")
    return snake_to_camel(_legacy_calendar_event_out(created))


@router.delete("/api/calendar-events")
def delete_calendar_event(id: Optional[str] = None, me: Identity = Depends(current_identity)):
    if not id:
        raise HTTPException(status_code=400, detail="Event ID required")
    _event_for_edit(id, me)
    if not db.delete_event(id):
        raise HTTPException(status_code=500, detail="Failed to delete event")
    return {"success": True}


@router.get("/api/calendar-events/{event_id}")
def get_calendar_event_by_id(event_id: str, me: Identity = Depends(current_identity)):
    event = db.get_event(event_id, entity='event')
    if not event or not _can_view_event(event, me):
        raise HTTPException(status_code=404, detail="Event not found")
    return snake_to_camel(_legacy_calendar_event_out(event))


@router.put("/api/calendar-events/{event_id}")
def update_calendar_event(event_id: str, updates: Dict[str, Any], me: Identity = Depends(current_identity)):
    _event_for_edit(event_id, me)
    updates = {k: v for k, v in updates.items() if k not in ('createdBy', 'created_by', 'user_id')}
    payload = {
        **_legacy_calendar_payload_in(updates),
        'entity': 'event',
        'start_date': updates.get('date') or updates.get('startDate') or updates.get('start_date'),
        'end_date': updates.get('endDate') or updates.get('end_date')
    }
    updated = db.update_event(event_id, payload)
    if not updated:
        raise HTTPException(status_code=404, detail="Event not found")
    return snake_to_camel(_legacy_calendar_event_out(updated))


@router.delete("/api/calendar-events/{event_id}")
def delete_calendar_event_by_id(event_id: str, me: Identity = Depends(current_identity)):
    if not db.get_event(event_id, entity='event'):
        return {"success": True, "message": "Event already deleted or not found"}
    _event_for_edit(event_id, me)
    if not db.delete_event(event_id):
        raise HTTPException(status_code=500, detail="Failed to delete event")
    return {"success": True}
