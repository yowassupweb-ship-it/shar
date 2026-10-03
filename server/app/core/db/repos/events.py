from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from dateutil.parser import isoparse
from dateutil.rrule import rrulestr

from app.core.db.connection import Json


class EventsRepo:
    """Запросы области «events». Требует self.conn (PostgresConnection)."""

    EVENT_METADATA_FIELDS = [
        'type', 'dateType', 'color', 'url', 'tags', 'impact', 'notes', 'participants',
        'createdBy', 'date', 'time', 'remind', 'recurrence',
        'listId', 'sourceId', 'assignedTo', 'assignedBy', 'createdByName', 'linkUrl', 'linkTitle',
        'startDateTime', 'endDateTime', 'allDay', 'timezone', 'location',
        'reminderMinutesBefore', 'recurrenceRule', 'recurrenceExDates', 'recurrenceId',
        'recurrenceMasterId', 'sharedWithAll', 'taskId', 'taskRepeat',
    ]

    def _hydrate_event_row(self, row: Dict[str, Any]) -> Dict[str, Any]:
        event = dict(row)
        metadata = event.get('metadata')
        if not isinstance(metadata, dict):
            metadata = {}
        event['metadata'] = metadata

        event['entity'] = metadata.get('entity', 'event')
        event['event_type'] = metadata.get('type') or metadata.get('eventType') or event.get('event_type')
        event['date_type'] = metadata.get('dateType') or metadata.get('date_type') or event.get('date_type')
        event['tags'] = metadata.get('tags', [])
        event['participants'] = metadata.get('participants', [])
        event['created_by'] = metadata.get('createdBy') or metadata.get('created_by') or event.get('user_id')

        for field in self.EVENT_METADATA_FIELDS:
            if field in metadata:
                event[field] = metadata[field]

        return event

    def get_events(self, entity: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get all events, optionally filtered by entity type"""
        query = "SELECT * FROM events ORDER BY created_at DESC"
        rows = self.conn.fetch_all(query)
        hydrated = [self._hydrate_event_row(row) for row in rows]
        if entity:
            return [event for event in hydrated if event.get('entity') == entity]
        return hydrated

    def get_event(self, event_id: str, entity: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Get single event by id"""
        query = "SELECT * FROM events WHERE id = %s"
        row = self.conn.fetch_one(query, (event_id,))
        if not row:
            return None
        event = self._hydrate_event_row(row)
        if entity and event.get('entity') != entity:
            return None
        return event

    def add_event(self, event_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Create event"""
        metadata = dict(event_data.get('metadata') or {})
        metadata['entity'] = event_data.get('entity') or metadata.get('entity') or 'event'

        for field in self.EVENT_METADATA_FIELDS:
            if field in event_data and event_data.get(field) is not None:
                metadata[field] = event_data.get(field)

        query = """
            INSERT INTO events (id, title, description, start_date, end_date, user_id, metadata, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
            RETURNING *
        """
        params = (
            event_data.get('id'),
            event_data.get('title'),
            event_data.get('description'),
            event_data.get('start_date') or event_data.get('startDate') or event_data.get('date'),
            event_data.get('end_date') or event_data.get('endDate'),
            event_data.get('user_id') or event_data.get('userId') or event_data.get('created_by') or event_data.get('createdBy'),
            Json(metadata)
        )
        row = self.conn.fetch_one(query, params)
        return self._hydrate_event_row(row) if row else None

    def update_event(self, event_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update event"""
        existing = self.get_event(event_id)
        if not existing:
            return None

        metadata = dict(existing.get('metadata') or {})
        incoming_metadata = updates.get('metadata')
        if isinstance(incoming_metadata, dict):
            metadata.update(incoming_metadata)

        if 'entity' in updates and updates.get('entity'):
            metadata['entity'] = updates.get('entity')

        for field in self.EVENT_METADATA_FIELDS:
            if field in updates:
                metadata[field] = updates.get(field)

        title = updates.get('title', existing.get('title'))
        description = updates.get('description', existing.get('description'))
        start_date = updates.get('start_date') or updates.get('startDate') or updates.get('date') or existing.get('start_date')
        end_date = updates.get('end_date') or updates.get('endDate') or existing.get('end_date')
        user_id = updates.get('user_id') or updates.get('userId') or updates.get('created_by') or updates.get('createdBy') or existing.get('user_id')

        query = """
            UPDATE events
            SET title = %s,
                description = %s,
                start_date = %s,
                end_date = %s,
                user_id = %s,
                metadata = %s,
                updated_at = NOW()
            WHERE id = %s
            RETURNING *
        """
        row = self.conn.fetch_one(query, (title, description, start_date, end_date, user_id, Json(metadata), event_id))
        return self._hydrate_event_row(row) if row else None

    def delete_event(self, event_id: str) -> bool:
        """Delete event"""
        query = "DELETE FROM events WHERE id = %s"
        return self.conn.execute_query(query, (event_id,))

    def migrate_event_metadata_silent(self, event_id: str, metadata_patch: Dict[str, Any]) -> bool:
        """Like update_event, but does NOT touch updated_at/start_date/end_date and only
        merges into metadata. Used for one-time backfills so migrated rows don't look like
        a fresh "update" to clients that key change-notifications off updated_at (bumping it
        for many rows at once caused a mass false "event changed" notification burst)."""
        existing = self.get_event(event_id)
        if not existing:
            return False
        metadata = dict(existing.get('metadata') or {})
        metadata.update(metadata_patch)
        query = "UPDATE events SET metadata = %s WHERE id = %s"
        return self.conn.execute_query(query, (Json(metadata), event_id))

    def get_event_occurrences(self, entity: str, start_date: str, end_date: str) -> List[Dict[str, Any]]:
        """Expand recurring events into concrete occurrences within [start_date, end_date].

        Storage model (iCal-style): a recurring event is one master row
        (recurrenceRule set) plus zero or more override rows (recurrenceMasterId +
        recurrenceId set) representing single-occurrence edits. A pure single-occurrence
        deletion is recorded on the master's recurrenceExDates instead of an override row.
        Non-recurring rows pass through unchanged.
        """
        all_events = self.get_events(entity)
        try:
            range_start = isoparse(start_date)
            range_end = isoparse(end_date)
        except (ValueError, TypeError):
            return all_events

        masters, plain = [], []
        overrides_by_master: Dict[str, Dict[str, Dict[str, Any]]] = {}
        for ev in all_events:
            if ev.get('recurrenceMasterId'):
                try:
                    key = isoparse(ev.get('recurrenceId')).isoformat()
                except (ValueError, TypeError):
                    key = ev.get('recurrenceId')
                overrides_by_master.setdefault(ev['recurrenceMasterId'], {})[key] = ev
            elif ev.get('recurrenceRule'):
                masters.append(ev)
            else:
                plain.append(ev)

        occurrences: List[Dict[str, Any]] = []

        for ev in plain:
            raw_start = ev.get('startDateTime') or ev.get('date')
            if not raw_start:
                occurrences.append(ev)
                continue
            try:
                ev_start = isoparse(raw_start)
            except (ValueError, TypeError):
                occurrences.append(ev)
                continue
            raw_end = ev.get('endDateTime')
            try:
                ev_end = isoparse(raw_end) if raw_end else ev_start
            except (ValueError, TypeError):
                ev_end = ev_start
            if ev_start <= range_end and ev_end >= range_start:
                occurrences.append(ev)

        for master in masters:
            rule_str = master.get('recurrenceRule')
            dtstart_raw = master.get('startDateTime') or master.get('date')
            if not rule_str or not dtstart_raw:
                occurrences.append(master)
                continue
            try:
                dtstart = isoparse(dtstart_raw)
                rule = rrulestr(rule_str, dtstart=dtstart)
            except (ValueError, TypeError):
                occurrences.append(master)
                continue

            duration = timedelta()
            end_raw = master.get('endDateTime')
            if end_raw:
                try:
                    duration = isoparse(end_raw) - dtstart
                except (ValueError, TypeError):
                    duration = timedelta()

            exdates = set()
            for iso in (master.get('recurrenceExDates') or []):
                try:
                    exdates.add(isoparse(iso).isoformat())
                except (ValueError, TypeError):
                    pass

            master_overrides = overrides_by_master.get(master['id'], {})

            try:
                window = rule.between(range_start - duration, range_end, inc=True)
            except (ValueError, TypeError):
                window = []

            for occ_dt in window:
                occ_key = occ_dt.isoformat()
                if occ_key in exdates:
                    continue
                override = master_overrides.get(occ_key)
                if override:
                    occ_override = dict(override)
                    occ_override['masterId'] = master['id']
                    occurrences.append(occ_override)
                    continue
                occ = dict(master)
                occ['startDateTime'] = occ_key
                if end_raw:
                    occ['endDateTime'] = (occ_dt + duration).isoformat()
                occ['recurrenceId'] = occ_key
                occ['masterId'] = master['id']
                occ['id'] = f"{master['id']}::{occ_key}"
                occurrences.append(occ)

        return occurrences

    def add_event_exdate(self, master_id: str, occurrence_iso: str) -> Optional[Dict[str, Any]]:
        """Mark one occurrence of a recurring master event as deleted (iCal EXDATE)."""
        master = self.get_event(master_id)
        if not master:
            return None
        try:
            canonical = isoparse(occurrence_iso).isoformat()
        except (ValueError, TypeError):
            canonical = occurrence_iso
        exdates = list(master.get('recurrenceExDates') or [])
        if canonical not in exdates:
            exdates.append(canonical)
        return self.update_event(master_id, {'recurrenceExDates': exdates})

    def split_recurrence_series(self, master_id: str, split_at_iso: str, new_fields: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Implements 'this and following' edits: truncates the original master's RRULE to
        end right before split_at_iso, then creates a new master starting at split_at_iso
        carrying new_fields, re-parenting any override rows at/after split_at_iso to it."""
        master = self.get_event(master_id)
        if not master:
            return None
        try:
            split_dt = isoparse(split_at_iso)
        except (ValueError, TypeError):
            return None

        rule_str = master.get('recurrenceRule') or ''
        until_dt = split_dt - timedelta(seconds=1)
        parts = [p for p in rule_str.split(';') if p and not p.upper().startswith('UNTIL=') and not p.upper().startswith('COUNT=')]
        until_str = until_dt.strftime('%Y%m%dT%H%M%SZ') if until_dt.tzinfo else until_dt.strftime('%Y%m%dT%H%M%S')
        parts.append(f'UNTIL={until_str}')
        self.update_event(master_id, {'recurrenceRule': ';'.join(parts)})

        new_master_id = new_fields.get('id') or f"{master_id}-split-{int(datetime.utcnow().timestamp())}"
        new_master_data = dict(master)
        new_master_data.update(new_fields)
        new_master_data['id'] = new_master_id
        new_master_data['startDateTime'] = split_at_iso
        new_master_data['recurrenceExDates'] = []
        new_master_data.pop('masterId', None)
        new_master_data.pop('recurrenceMasterId', None)
        new_master = self.add_event(new_master_data)

        for ov in self.get_events(master.get('entity')):
            if ov.get('recurrenceMasterId') != master_id:
                continue
            try:
                ov_dt = isoparse(ov.get('recurrenceId'))
            except (ValueError, TypeError):
                continue
            if ov_dt >= split_dt:
                self.update_event(ov['id'], {'recurrenceMasterId': new_master_id})

        return new_master
