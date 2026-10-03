from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException

from app.core.db import db
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity
from app.modules.calls.state import (
    _call_state_lock,
    _load_call_state,
    _prune_call_state,
    _save_call_state,
)
from app.modules.chats.access import is_member
from app.modules.chats.cache import _get_chat_cached

router = APIRouter()

logger = logging.getLogger(__name__)


def _can_see_chat(chat_id: str, me: Identity) -> bool:
    return is_member(_get_chat_cached(chat_id), chat_id, me)


@router.get("/api/calls/status")
def get_call_status(callId: str, me: Identity = Depends(current_identity)):
    """Resync-only fallback — the primary signaling path is instant, pushed
    over the app's existing WebSocket/Redis channel (see POST /api/calls/signal
    below), not polled. A client calls this once after a WS reconnect, or on
    mount, to catch a call that started while the tab/connection was down."""
    if not callId:
        raise HTTPException(status_code=400, detail="callId required")

    with _call_state_lock():
        state, pruned_anything = _prune_call_state(_load_call_state())
        session = state.get("sessions", {}).get(str(callId))
        if pruned_anything:
            _save_call_state(state)

    # Чужой звонок для вошедшего «не существует» — состав комнат не раскрываем посторонним.
    if not session or not _can_see_chat(str(session.get("chatId") or ""), me):
        return {"exists": False, "callId": str(callId)}

    return {
        "exists": True,
        "callId": str(callId),
        "chatId": str(session.get("chatId") or ""),
        "callType": session.get("callType"),
        "isGroup": bool(session.get("isGroup")),
        "initiatorUserId": str(session.get("initiatorUserId") or ""),
        "participantIds": session.get("participantIds") or [],
        "lastActivityAt": int(session.get("lastActivityAt", 0) or 0),
    }


@router.get("/api/calls/active")
def get_active_call(chatId: str, me: Identity = Depends(current_identity)):
    """Every call is a room, not a phone call being placed — anyone can join
    it at any time, 1:1 or group. Before opening/creating one for a chat, the
    client checks here for an already-active room for that chat so a second
    person joins the existing one instead of spinning up a parallel room
    nobody else is in."""
    if not chatId:
        raise HTTPException(status_code=400, detail="chatId required")
    if not _can_see_chat(str(chatId), me):
        return {"active": False}

    with _call_state_lock():
        state, pruned_anything = _prune_call_state(_load_call_state())
        sessions = state.get("sessions", {})
        match = next(
            (s for s in sessions.values() if str(s.get("chatId") or "") == str(chatId)),
            None,
        )
        if pruned_anything:
            _save_call_state(state)

    if not match:
        return {"active": False}

    return {
        "active": True,
        "callId": str(match.get("callId") or ""),
        "callType": match.get("callType"),
        "isGroup": bool(match.get("isGroup")),
        "participantIds": match.get("participantIds") or [],
    }


@router.get("/api/calls/incoming")
def get_incoming_ring(userId: str = "", me: Identity = Depends(current_identity)):
    """Polling fallback for a missed 'call_ring' WS push (see ringTargets in
    post_call_signal's 'join' branch) — a client polls this every few seconds
    while it has no active ring/call of its own. Not the primary path (that's
    still the instant WS push); this only catches the rare case where the
    recipient's socket was mid-reconnect at the exact moment the ring fired,
    which a one-off event has no other way to recover from."""
    uid = me.user_id

    with _call_state_lock():
        state, pruned_anything = _prune_call_state(_load_call_state())
        sessions = state.get("sessions", {})
        match = next(
            (
                s for s in sessions.values()
                if str(s.get("mode") or "") == "ring"
                and uid in (s.get("ringTargets") or [])
                and uid not in (s.get("participantIds") or [])
            ),
            None,
        )
        if pruned_anything:
            _save_call_state(state)

    if not match:
        return {"ringing": False}

    initiator_id = str(match.get("initiatorUserId") or "")
    initiator = db.get_user_by_id(initiator_id) if initiator_id else None
    return {
        "ringing": True,
        "callId": str(match.get("callId") or ""),
        "chatId": str(match.get("chatId") or ""),
        "callType": match.get("callType"),
        "isGroup": bool(match.get("isGroup")),
        "fromUserId": initiator_id,
        "fromUserName": (initiator.get("name") if initiator else None) or initiator_id,
    }


@router.get("/api/calls/active-rooms")
def get_all_active_rooms(me: Identity = Depends(current_identity)):
    """All currently-active rooms across every chat, keyed by chatId — used
    to badge the chat list with "voice chat active here" without an N+1 of
    per-chat /api/calls/active calls. Kept live from there via the same
    call_join/call_leave WS pushes every participant already receives."""
    with _call_state_lock():
        state, pruned_anything = _prune_call_state(_load_call_state())
        sessions = state.get("sessions", {})
        if pruned_anything:
            _save_call_state(state)

    return {
        "rooms": {
            str(s.get("chatId") or ""): s.get("participantIds") or []
            for s in sessions.values()
            if s.get("chatId") and _can_see_chat(str(s.get("chatId")), me)
        }
    }


@router.get("/api/calls/rejoin")
def get_rejoinable_call(userId: str = "", me: Identity = Depends(current_identity)):
    """A page reload tears down every in-memory JS object (RTCPeerConnections
    included) the same way as any other client-side state — but the room
    itself (this backend's own bookkeeping, and the other participant(s)'
    still-open connections) is completely unaffected. Checked once on mount so
    a reload reconnects to a still-live room instead of just silently
    dropping out of it."""
    userId = me.user_id

    with _call_state_lock():
        state, pruned_anything = _prune_call_state(_load_call_state())
        sessions = state.get("sessions", {})
        match = next(
            (
                s for s in sessions.values()
                if str(userId) in [str(p) for p in (s.get("participantIds") or [])]
            ),
            None,
        )
        if pruned_anything:
            _save_call_state(state)

    if not match:
        return {"rejoin": False}

    return {
        "rejoin": True,
        "callId": str(match.get("callId") or ""),
        "chatId": str(match.get("chatId") or ""),
        "callType": match.get("callType"),
        "isGroup": bool(match.get("isGroup")),
        "initiatorUserId": str(match.get("initiatorUserId") or ""),
        "participantIds": match.get("participantIds") or [],
        "mode": match.get("mode") or "room",
    }


def _push_call_signal(signal_type: str, call_id: str, from_user_id: str, from_user_name: Optional[str],
                       chat_id: str, call_type: Optional[str], is_group: bool, target_ids: List[str]) -> None:
    """Same wire shape POST /api/calls/signal pushes, factored out so the
    WS-disconnect cleanup below (which has no HTTP request to respond to) can
    still broadcast a 'leave' the exact way a normal hangup does."""
    payload = {
        "type": f"call_{signal_type}",
        "callId": call_id,
        "fromUserId": str(from_user_id),
        "fromUserName": from_user_name,
        "chatId": str(chat_id),
        "callType": call_type,
        "isGroup": is_group,
        "payload": None,
    }
    for uid in target_ids:
        try:
            sse_manager.push(uid, payload)
        except Exception as e:
            logger.warning(f"[calls] disconnect-leave push failed for user {uid}: {e}")


def _force_leave_all_calls(user_id: str, user_name: Optional[str]) -> None:
    """Drops user_id from every call room it's still listed in — the same
    roster surgery POST /api/calls/signal's 'leave' branch does, just without
    a client-initiated request behind it. Fired only after
    CALL_DISCONNECT_GRACE_SEC of the user having zero live WS connections (see
    _schedule_call_disconnect_cleanup), so an ordinary reconnect blip never
    trips this. Without this, a tab closed/killed/network-dropped without a
    chance to send 'leave' left the user in the room's participantIds until
    the 6h stale prune (CALL_SESSION_STALE_MS) — which is what made a call
    look like it had a permanently stuck participant even after everyone had
    actually left."""
    user_id = str(user_id)
    now = int(time.time() * 1000)
    to_broadcast: List[tuple] = []  # (call_id, chat_id, call_type, is_group, remaining_ids, should_log, mode)

    with _call_state_lock():
        state, _ = _prune_call_state(_load_call_state())
        sessions = state.get("sessions", {})
        changed = False
        for call_id in list(sessions.keys()):
            session = sessions.get(call_id)
            before = session.get("participantIds") or []
            if user_id not in before:
                continue
            should_log = len(before) >= 2
            remaining = [uid for uid in before if uid != user_id]
            session["participantIds"] = remaining
            session["lastActivityAt"] = now
            changed = True
            if remaining:
                to_broadcast.append((call_id, str(session.get("chatId") or ""), session.get("callType"), bool(session.get("isGroup")), remaining, should_log, str(session.get("mode") or "room")))
            else:
                sessions.pop(call_id, None)
        if changed:
            _save_call_state(state)

    for call_id, chat_id, call_type, is_group, remaining, should_log, room_mode in to_broadcast:
        _push_call_signal("leave", call_id, user_id, user_name, chat_id, call_type, is_group, remaining)
        if should_log:
            _log_room_event(chat_id, user_id, user_name, "left", room_mode)


def evict_disabled_users_from_calls() -> None:
    """Drop every disabled or deleted user from all active call/room sessions.
    Called on startup so users disabled/removed while a session outlived the
    change (typically across a backend restart) don't linger in participantIds
    until the 6h stale prune — and can also be called ad-hoc. Reuses
    _force_leave_all_calls per user so the same roster surgery + 'leave'
    broadcast + room-log happens as for a normal leave."""
    try:
        state, _ = _prune_call_state(_load_call_state())
        sessions = state.get("sessions", {})
        in_call: set = set()
        for s in sessions.values():
            for uid in (s.get("participantIds") or []):
                in_call.add(str(uid))
        if not in_call:
            return
        try:
            all_users = db.get_users(include_disabled=True) or []
        except TypeError:
            all_users = db.get_users() or []
        by_id = {str(u.get("id")): u for u in all_users}
        for uid in in_call:
            u = by_id.get(uid)
            # Missing from the (disabled-inclusive) roster ⇒ deleted; present but
            # flagged ⇒ disabled. Either way they must not stay in a call.
            is_gone = (u is None) or bool(u.get("is_disabled") or u.get("isDisabled"))
            if is_gone:
                _force_leave_all_calls(uid, (u or {}).get("name") if u else None)
                logger.info(f"[calls] evicted disabled/deleted user {uid} from active call(s)")
    except Exception as e:
        logger.warning(f"[calls] evict disabled/deleted users from calls failed: {e}")


def _log_room_event(chat_id: str, user_id: str, user_name: Optional[str], action: str, mode: str = "room") -> None:
    """Discord-style voice activity log, posted live as a chat message. The
    wording distinguishes a 'Вызов' (ring) from a 'Комната' (silent room) so
    the two read differently in the chat — a ring says 'к звонку', a room says
    'в голосовую комнату'. Best-effort: swallows its own errors since it's a
    side effect of signaling, not the signal response itself."""
    import uuid as _uuid
    try:
        chat = db.get_chat(chat_id)
        if not chat:
            return
        author = db.get_user_by_id(user_id)
        author_name: Optional[str] = None
        if author:
            author_name = author.get("name") or author.get("username")
        author_name = author_name or user_name or user_id

        if mode == "ring":
            content = f"{author_name} присоединил(ся/ась) к звонку" if action == "joined" else f"{author_name} покинул(а) звонок"
        else:
            content = f"{author_name} вошёл(-ла) в голосовую комнату" if action == "joined" else f"{author_name} вышел(-ла) из комнаты"
        new_message: Dict[str, Any] = {
            "id": str(_uuid.uuid4()),
            "chat_id": chat_id,
            "author_id": user_id,
            "author_name": author_name,
            "content": content,
            "mentions": [],
            "reply_to_id": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": None,
            "is_edited": False,
            "attachments": [],
            "is_system_message": True,
            "notification_type": "call",
            "metadata": {"callAction": action, "callMode": mode},
        }
        saved = db.add_message(new_message)
        if not saved:
            return
        sse_manager.push_to_chat(chat, '', {
            "type": "new_message",
            "chatId": chat_id,
            "messageId": new_message["id"],
            "message": {
                "id": new_message["id"],
                "chatId": chat_id,
                "authorId": user_id,
                "authorName": author_name,
                "content": content,
                "createdAt": new_message["created_at"],
                "updatedAt": None,
                "isEdited": False,
                "isDeleted": False,
                "isSystemMessage": True,
                "notificationType": "call",
                "attachments": [],
                "mentions": [],
                "replyToId": None,
                "metadata": new_message["metadata"],
            },
        })
    except Exception as e:
        logger.warning(f"[calls] room-event log failed for chat {chat_id}: {e}")
