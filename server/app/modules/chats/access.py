"""Доступ к чатам: читать и писать в чат может только его участник.

Раньше сервер проверял лишь то, что userId в запросе совпадает с сессией, а чат
отдавал любому вошедшему по одному chat_id. Теперь каждый маршрут с chat_id
сначала спрашивает require_member().
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

from app.core.security import Identity
from app.modules.chats.cache import _get_chat_cached


def participant_ids(chat: Optional[dict]) -> set[str]:
    raw = (chat or {}).get("participant_ids") or (chat or {}).get("participantIds") or []
    return {str(x) for x in raw if x is not None}


def own_service_chat(chat_id: str, me: Identity) -> bool:
    """«Избранное» и «Уведомления» создаются при первом обращении — свои можно всегда."""
    return chat_id in (f"favorites_{me.user_id}", f"notifications-{me.user_id}")


def is_member(chat: Optional[dict], chat_id: str, me: Identity) -> bool:
    if not chat:
        return own_service_chat(chat_id, me)
    return me.user_id in participant_ids(chat)


def require_member(chat_id: str, me: Identity, *, allow_missing_own: bool = True) -> Optional[dict]:
    """Чат, если вошедший в нём состоит. Нет чата — 404, чужой — 403.

    allow_missing_own: для своих служебных чатов, которых ещё нет, вернуть None
    (вызывающий создаст их)."""
    chat = _get_chat_cached(chat_id)
    if not chat:
        if allow_missing_own and own_service_chat(chat_id, me):
            return None
        raise HTTPException(status_code=404, detail="Chat not found")
    if me.user_id not in participant_ids(chat):
        raise HTTPException(status_code=403, detail="Вы не участник этого чата")
    return chat


def is_creator(chat: dict, me: Identity) -> bool:
    return str(chat.get("creator_id") or chat.get("creatorId") or "") == me.user_id
