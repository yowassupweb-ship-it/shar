from __future__ import annotations

import time as _time

from app.core.db import db
from app.modules.chats import list_cache as chat_list_cache

_chat_cache: dict[str, tuple[dict, float]] = {}


_CHAT_CACHE_TTL = 30.0  # seconds


def _get_chat_cached(chat_id: str) -> dict | None:
    entry = _chat_cache.get(chat_id)
    if entry:
        data, ts = entry
        if _time.monotonic() - ts < _CHAT_CACHE_TTL:
            return data
    data = db.get_chat(chat_id)
    if data:
        _chat_cache[chat_id] = (data, _time.monotonic())
    return data


def _invalidate_chat_cache(chat_id: str) -> None:
    _chat_cache.pop(chat_id, None)


def _chat_participant_ids(chat_id: str) -> list:
    chat = _get_chat_cached(chat_id) or {}
    return [str(x) for x in (chat.get('participant_ids') or chat.get('participantIds') or []) if x is not None]


chat_list_cache.configure(_chat_participant_ids)


chat_list_cache.wrap_db(getattr(db, 'db', db))


def _bumps_chat_list(fn):
    """Для эндпоинтов, которые пишут сырым SQL мимо обёрнутых методов db:
    после ответа сбрасываем списки участников чата (превью, закрепы)."""
    import functools

    @functools.wraps(fn)
    def inner(chat_id: str, *args, **kwargs):
        try:
            return fn(chat_id, *args, **kwargs)
        finally:
            chat_list_cache.bump_chat(chat_id)
    return inner


def _update_chat_cache_field(chat_id: str, field: str, value) -> None:
    """Patch one field of an already-cached chat instead of dropping the whole entry —
    keeps participant_ids (what push_to_chat needs) warm across frequent field-only
    updates like read markers, refreshing the entry's TTL clock in the process."""
    entry = _chat_cache.get(chat_id)
    if not entry:
        return
    data, _ts = entry
    data = {**data, field: value}
    _chat_cache[chat_id] = (data, _time.monotonic())
