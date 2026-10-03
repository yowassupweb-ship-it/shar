"""Разовые миграции данных календаря, запускаются при старте."""

from __future__ import annotations

import logging
from typing import Any, Dict

from app.core.db import db

log = logging.getLogger(__name__)


def migrate_legacy_calendar_rows() -> int:
    """Редизайн календаря слил отдельные строки entity='calendar_event' в
    entity='event' (оба вида всегда лежали в одной таблице events, различаясь по
    metadata.entity). После первого успешного запуска это no-op: оставшихся
    calendar_event-строк больше нет."""
    legacy_rows = db.get_events(entity='calendar_event')
    if not legacy_rows:
        return 0
    log.info("[Calendar migration] Migrating %d legacy calendar_event rows -> event", len(legacy_rows))
    migrated = 0
    for row in legacy_rows:
        fields: Dict[str, Any] = {'entity': 'event'}
        date_str = row.get('date')
        time_str = row.get('time')
        if date_str:
            fields['startDateTime'] = f"{date_str}T{time_str}:00" if time_str else f"{date_str}T00:00:00"
            fields['allDay'] = not bool(time_str)
        if 'remind' in row:
            fields['reminderMinutesBefore'] = 15 if row.get('remind') else None
        # migrate_event_metadata_silent намеренно не трогает updated_at: иначе все
        # клиенты (детект изменений по updatedAt) приняли бы строки за «только что
        # обновлённые» и разослали лавину уведомлений (инцидент 2026-07-20).
        if db.migrate_event_metadata_silent(row['id'], fields):
            migrated += 1
    log.info("[Calendar migration] Done: %d/%d rows migrated", migrated, len(legacy_rows))
    return migrated
