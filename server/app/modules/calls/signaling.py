from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.db import db
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity
from app.modules.calls.rooms import _log_room_event, _push_call_signal
from app.modules.calls.schemas import CallSignalBody
from app.modules.calls.state import (
    _call_state_lock,
    _load_call_state,
    _prune_call_state,
    _save_call_state,
)
from app.modules.chats.access import participant_ids, require_member
from app.modules.push import service as push_service

router = APIRouter()

logger = logging.getLogger(__name__)

# Пуш о звонке уходит в сеть: не задерживаем им ответ сигнализации.
_push_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="call-push")


@router.post("/api/calls/signal")
def post_call_signal(body: CallSignalBody, me: Identity = Depends(current_identity)):
    """Unified 1:1 + group call signaling — a call is just a room with 1 or
    more other participants, no distinction in how it's created/joined/left.
    Delivered instantly over the same WebSocket/Redis channel every other
    realtime feature (messages, typing, reactions) already uses
    (sse_manager.push). A small `sessions` dict (keyed by callId) is still
    persisted so /api/calls/status, /api/calls/active and /api/calls/rejoin
    can answer "what's the current truth" after a reconnect — 'offer'/
    'answer'/'ice-candidate' (pure WebRTC negotiation relay for the
    peer-to-peer mesh) don't touch it at all, just forward straight through."""
    # От чьего имени сигнал — решает сессия, а не тело запроса; звонить и слать
    # сигналы можно только внутри своего чата и только его участникам.
    body.fromUserId = me.user_id
    body.fromUserName = me.display_name
    chat_for_access = require_member(str(body.chatId), me, allow_missing_own=False)
    roster = participant_ids(chat_for_access)
    targets = [str(t) for t in (body.toUserIds or []) if t and str(t) in roster and str(t) != me.user_id]
    signal_type = str(body.type)
    logger.debug(f"[calls] type={signal_type} from={body.fromUserId} chatId={body.chatId} callId={body.callId} toUserIds={targets}")
    # 'leave'/'participant_left' must always be allowed through even with an
    # empty toUserIds — their job is removing the sender from participantIds,
    # not delivering a message to anyone. Requiring a target here meant a
    # client with zero currently-connected peers (their own connection never
    # finished negotiating, or the other side already vanished) had no valid
    # way to leave at all: the frontend either skipped sending 'leave'
    # outright to dodge this exact 400, or the request was rejected — either
    # way the user stayed stuck in the room's participantIds forever (until
    # the multi-hour stale-session prune), which looked to everyone else like
    # the room refusing to empty out / a stuck call blocking a real rejoin.
    if not targets and signal_type not in ("leave", "participant_left"):
        raise HTTPException(status_code=400, detail="toUserIds required")
    now = int(time.time() * 1000)
    is_group = bool(body.isGroup) or len(targets) > 1
    call_id = str(body.callId)  # may be overridden below if 'join' finds a race winner

    joined_participant_ids: List[str] = []
    room_mode = "room"  # 'ring' | 'room' of the affected session, for the log wording
    should_log_joined = False  # set below when a join lands in an already-occupied room
    should_log_left = False    # set below when a leave happens while others remain
    # The client-supplied `targets` (body.toUserIds) for 'leave'/'participant_left'
    # is only whoever *that client's* local WebRTC mesh happened to have a peer
    # connection to (see useCallSession.ts's hangup(), which sends
    # Array.from(peersRef.current.keys())) — if the mesh never finished
    # negotiating with someone, or their peer connection had already dropped
    # locally without the room roster being told, that real participant is
    # silently missing from `targets` and never receives the leave broadcast,
    # so their client keeps showing the person who left as still present
    # indefinitely. `authoritative_targets` is filled in below from the
    # server's own roster — the actual source of truth for "who is in this
    # room" — and merged into the broadcast list so every real participant is
    # notified regardless of what the leaving client's local peer bookkeeping
    # thought it knew.
    authoritative_targets: List[str] = []
    # One person, one voice room at a time — but SELF-HEALING. When a user joins
    # a room, first drop them from any OTHER chat's room they're still listed in
    # (a leftover entry from a crashed/closed tab that never sent 'leave'). This
    # used to REJECT the join with "you're already in another room", which meant
    # a single stale entry permanently blocked every new call for that user even
    # though they were long gone and it showed up nowhere in their UI. Auto-
    # leaving instead enforces the same invariant without ever getting stuck.
    other_leave_broadcasts: List[tuple] = []  # (call_id, chat_id, call_type, is_group, remaining, mode)

    if signal_type in ("join", "leave", "participant_joined", "participant_left"):
        with _call_state_lock():
            state, _ = _prune_call_state(_load_call_state())
            sessions = state.setdefault("sessions", {})

            if signal_type == "join":
                # Evict this user from every OTHER chat's room before joining here.
                for other_call_id in list(sessions.keys()):
                    s = sessions.get(other_call_id) or {}
                    if str(s.get("chatId") or "") == str(body.chatId):
                        continue
                    parts = s.get("participantIds") or []
                    if str(body.fromUserId) not in parts:
                        continue
                    remaining = [uid for uid in parts if uid != str(body.fromUserId)]
                    s["participantIds"] = remaining
                    s["lastActivityAt"] = now
                    if remaining:
                        other_leave_broadcasts.append((other_call_id, str(s.get("chatId") or ""), s.get("callType"), bool(s.get("isGroup")), remaining, str(s.get("mode") or "room")))
                    else:
                        sessions.pop(other_call_id, None)
                # Two people opening the same 1:1/group room at nearly the same
                # moment would otherwise each mint their own random callId and
                # end up in two separate rooms nobody else is in — this lock
                # makes "is there already a room for this chat" atomic: look up
                # by chatId first, and if one exists, join THAT one (adopting
                # its callId) instead of creating a second, orphaned room.
                existing_for_chat = next(
                    (s for s in sessions.values() if str(s.get("chatId") or "") == str(body.chatId)),
                    None,
                )
                if existing_for_chat:
                    call_id = str(existing_for_chat.get("callId") or call_id)
                    ids = set(existing_for_chat.get("participantIds") or [])
                    was_already_in = str(body.fromUserId) in ids
                    ids.add(str(body.fromUserId))
                    existing_for_chat["participantIds"] = list(ids)
                    existing_for_chat["lastActivityAt"] = now
                    joined_participant_ids = [uid for uid in existing_for_chat["participantIds"] if uid != str(body.fromUserId)]
                    room_mode = str(existing_for_chat.get("mode") or "room")
                    # Only a genuinely new arrival is worth a log line — a
                    # redundant 'join' from a client that (thought it) was
                    # already in the room (page reload racing the rejoin
                    # flow, a retried request, dev-server hot-reload during
                    # testing) must not re-announce someone who never left.
                    should_log_joined = not was_already_in and len(joined_participant_ids) > 0
                else:
                    # `targets` (body.toUserIds) here is who the creator is inviting/
                    # notifying — NOT who has actually joined. This used to seed
                    # participantIds with them anyway (`[fromUserId, *targets]`), which
                    # meant the instant A called startCall(chatId, [B]), the SERVER
                    # already considered B "in the room" even though B's browser hadn't
                    # done anything at all yet — hadn't seen a notification, hadn't
                    # clicked the room pill, nothing. If A then hung up before B ever
                    # actually joined (exactly what happens in a quick test, or anyone
                    # who cancels fast), A's own 'leave' correctly removed A — but B had
                    # no session of their own to ever send a 'leave' FROM, so B stayed
                    # listed in participantIds permanently: forever "in" a room they
                    # never opened, visible to anyone as a stuck participant, and
                    # silently pulled into it for real on their next page load via the
                    # rejoin flow (/api/calls/rejoin, which just trusts participantIds).
                    # It's also why "joined" log lines never appeared for the real
                    # invitee — should_log_joined checks was_already_in, which was
                    # already true the moment they showed up for real, since they'd
                    # been sitting in participantIds since the invite. Only the
                    # creator is an actual participant at creation time; `targets` are
                    # still pushed the 'call_join' notification below (unchanged) so
                    # their header pill / active-rooms badge can react to a room
                    # existing — they just don't count as "in it" until their own
                    # 'join' request lands here and hits the `existing_for_chat` branch
                    # above.
                    sessions[call_id] = {
                        "callId": call_id,
                        "chatId": str(body.chatId),
                        "callType": body.callType,
                        "isGroup": is_group,
                        "initiatorUserId": str(body.fromUserId),
                        "participantIds": [str(body.fromUserId)],
                        "createdAt": now,
                        "lastActivityAt": now,
                        # 'ring' (Вызов) vs 'room' (Комната) — fixed at creation,
                        # drives whether join/leave system messages say "звонок"
                        # or "голосовая комната", AND whether a hangup ends the
                        # call for the other side (ring) or leaves the room alive
                        # (room). Every later joiner adopts this same mode (via
                        # the join response) so both sides agree.
                        "mode": (body.mode if body.mode in ("ring", "room") else "room"),
                        # Who the creator is ringing — see /api/calls/incoming, a
                        # polling fallback for when the WS push carrying 'call_ring'
                        # (the primary, instant path) is missed because the
                        # recipient's socket happened to be mid-reconnect at that
                        # exact instant. A dropped one-off ring has no other way to
                        # ever reach them (unlike messages, which self-heal via the
                        # next fetch) — this needs the callee still explicitly
                        # accepting/declining, not raw participantIds.
                        "ringTargets": targets,
                    }
                    room_mode = sessions[call_id]["mode"]
            elif signal_type == "leave":
                session = sessions.get(call_id)
                # One participant leaving only drops them from the roster —
                # the room stays alive for whoever's left, 1:1 or group (a
                # 1:1 call is just a 2-person room; the second person leaving
                # naturally empties it via the same path below).
                if session:
                    before = session.get("participantIds") or []
                    room_mode = str(session.get("mode") or "room")
                    # Only log if this user was actually a member AND someone
                    # else was there to notice them leaving — a redundant
                    # 'leave' from a client that already left (double-fire,
                    # retried request) must not spam another log line.
                    should_log_left = str(body.fromUserId) in before and len(before) >= 2
                    remaining = [uid for uid in before if uid != str(body.fromUserId)]
                    authoritative_targets = remaining
                    session["participantIds"] = remaining
                    session["lastActivityAt"] = now
                    if not session["participantIds"]:
                        sessions.pop(call_id, None)
            elif signal_type in ("participant_joined", "participant_left"):
                session = sessions.get(call_id)
                if session:
                    ids = set(session.get("participantIds") or [])
                    if signal_type == "participant_joined":
                        ids.add(str(body.fromUserId))
                    else:
                        ids.discard(str(body.fromUserId))
                    session["participantIds"] = list(ids)
                    session["lastActivityAt"] = now
                    authoritative_targets = [uid for uid in session["participantIds"] if uid != str(body.fromUserId)]
                    if not session["participantIds"]:
                        sessions.pop(call_id, None)

            _save_call_state(state)

    # Notify whoever's left in the rooms this user was auto-evicted from, so
    # their UI drops the departed participant live (same shape a real 'leave').
    for oc_id, oc_chat, oc_type, oc_group, oc_remaining, oc_mode in other_leave_broadcasts:
        _push_call_signal("leave", oc_id, str(body.fromUserId), body.fromUserName, oc_chat, oc_type, oc_group, oc_remaining)
        if len(oc_remaining) >= 1:
            _log_room_event(oc_chat, str(body.fromUserId), body.fromUserName, "left", oc_mode)

    if should_log_joined:
        _log_room_event(str(body.chatId), str(body.fromUserId), body.fromUserName, "joined", room_mode)
    elif should_log_left:
        _log_room_event(str(body.chatId), str(body.fromUserId), body.fromUserName, "left", room_mode)

    payload = {
        "type": f"call_{signal_type}",
        "callId": call_id,
        "fromUserId": str(body.fromUserId),
        "fromUserName": body.fromUserName,
        "chatId": str(body.chatId),
        "callType": body.callType,
        "isGroup": is_group,
        "payload": body.payload,
    }
    broadcast_targets = list(dict.fromkeys([*targets, *authoritative_targets]))  # de-duped, order-preserving
    # 'join' already reaches every chat member — startCall's toUserIds is the
    # WHOLE chat roster minus self, not just whoever's already in the room —
    # so anyone with that chat open sees the "someone's in the room" badge
    # light up immediately. 'leave'/'participant_left' didn't get the same
    # treatment: the client only supplies its own currently-connected mesh
    # peers (see useCallSession.ts's endCall(), Array.from(peersRef.current.keys())),
    # and authoritative_targets is scoped to the room's remaining members —
    # neither includes a chat member who has that chat open but was never in
    # the call themselves. Their badge (roomOccupantsByChat in page.tsx) only
    # refreshes reactively off a received call_ event, so it just never
    # updated: the "Присоединиться" pill kept showing someone present long
    # after they'd actually left, until that viewer's own unrelated action
    # (or the 6h stale prune) happened to trigger a resync. Rounding out
    # 'leave'/'participant_left' to the full chat roster too, same as 'join'
    # already gets, fixes both the stale-looking pill AND the real practical
    # consequence — someone clicking "join" into what the (stale) badge
    # claimed was an occupied room, only to land there alone because the
    # person they thought was still in it had actually left already.
    if signal_type in ("join", "leave", "participant_joined", "participant_left"):
        try:
            chat = db.get_chat(str(body.chatId))
            if chat:
                raw = chat.get("participant_ids") or chat.get("participantIds") or []
                chat_roster = [str(uid) for uid in raw if uid is not None and str(uid) != str(body.fromUserId)]
                broadcast_targets = list(dict.fromkeys([*broadcast_targets, *chat_roster]))
        except Exception as e:
            logger.warning(f"[calls] chat-roster broadcast lookup failed for chat {body.chatId}: {e}")
    for uid in broadcast_targets:
        try:
            sse_manager.push(uid, payload)
        except Exception as e:
            logger.warning(f"[calls] signal push failed for user {uid}: {e}")

    # A 'Вызов' (ring) also sends an OS-level Web Push to the callee(s) so a
    # backgrounded / closed PWA still surfaces the incoming call, not just an
    # in-page ring that only fires while the tab is open. Same fire-and-forget
    # dispatch to the Next.js push route that new messages use. Only 'ring'
    # gets this — accept/reject/cancel are in-session and never need to wake a
    # sleeping device. Best-effort: any failure is swallowed (the live WS ring
    # above is the primary path whenever the app is actually open).
    if signal_type == "ring" and targets:
        try:
            caller_name = me.display_name
            call_word = "видеозвонок" if (body.callType == "video") else "звонок"
            _push_pool.submit(
                push_service.notify, targets,
                title=f"Входящий {call_word}",
                body=f"{caller_name} звонит вам…",
                url=f"/account?tab=messages&chat={body.chatId}",
                tag=f"call-{call_id}",
                chatId=str(body.chatId),
                senderName=caller_name,
                # Помечает пуш как звонок: сервис-воркер может показать его по-звонковому.
                kind="call",
                callId=str(call_id),
            )
        except Exception as push_err:
            logger.debug(f"[calls] ring web-push dispatch skipped: {push_err}")

    # For 'join', the caller needs to know the AUTHORITATIVE callId — if
    # another client won the race to create this chat's room a moment
    # earlier, that's a different id than the one this client proposed, and
    # it must adopt it (same room name) — plus who else is already in the
    # room, so it knows who to initiate a peer connection to (there's no SFU
    # to do this centrally anymore).
    if signal_type == "join":
        logger.debug(f"[calls] join RESULT from={body.fromUserId} callId={call_id} participantIds={joined_participant_ids}")
    return {"ok": True, "callId": call_id, "participantIds": joined_participant_ids, "mode": room_mode}


class CallLogBody(BaseModel):
    callId: str
    chatId: str
    authorId: str
    authorName: Optional[str] = None
    remoteUserId: Optional[str] = None
    callType: str = "voice"   # 'voice' | 'video'
    duration: int = 0         # seconds — always set; see log_call for when this fires
    status: str = "completed" # 'completed' | 'missed' — a 'Вызов' nobody answered


@router.post("/api/calls/log")
def log_call(body: CallLogBody, me: Identity = Depends(current_identity)):
    """Save a call's outcome as a system message in the chat. Idempotent by
    callId. Only ever called when at least one other person actually joined
    the room with the opener — a room opened and left alone, with nobody else
    ever showing up, logs nothing at all (matches Telegram's own voice-chat
    start/end system messages; there's no "missed"/"declined"/"cancelled"
    concept anymore now that joining a call isn't answering a ring)."""
    import uuid as _uuid

    body.authorId = me.user_id
    body.authorName = me.display_name
    chat = require_member(body.chatId, me, allow_missing_own=False)

    # Deduplication – skip if this callId was already logged in this chat.
    if hasattr(db, 'conn'):
        existing = db.conn.fetch_one(
            "SELECT id FROM messages WHERE chat_id = %s AND notification_type = 'call' AND metadata->>'callId' = %s",
            (body.chatId, body.callId),
        )
        if existing:
            return {"ok": True, "duplicate": True}

    # Plain text — no emoji. In-app this notificationType renders as a fully
    # custom icon pill (ChatTimelineV3.tsx), and the sidebar/push fallback text
    # below is matched by a regex there to show the same lucide icon inline
    # instead of an emoji glyph.
    is_missed = body.status == "missed"
    if is_missed:
        content = "Пропущенный звонок"
    else:
        mins = body.duration // 60
        secs = body.duration % 60
        content = f"Звонок {mins}:{secs:02d}"

    author = db.get_user_by_id(body.authorId)
    author_name: Optional[str] = None
    if author:
        author_name = author.get("name") or author.get("username")
    author_name = author_name or body.authorName or body.authorId

    new_message: Dict[str, Any] = {
        "id": str(_uuid.uuid4()),
        "chat_id": body.chatId,
        "author_id": body.authorId,
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
        "metadata": {
            "callId": body.callId,
            "callType": body.callType,
            "callStatus": "missed" if is_missed else "completed",
            "duration": body.duration,
            "initiatorId": body.authorId,
            "remoteUserId": body.remoteUserId,
        },
    }
    saved = db.add_message(new_message)
    if not saved:
        logger.warning("[calls] failed to persist call-status message for chat %s", body.chatId)
        return {"ok": False, "duplicate": False}

    # Only the caller ever calls this endpoint (see the "caller-only logs" contract
    # in useCallSession.ts/page.tsx) and used to just refresh their OWN chat view —
    # the other side never got pushed anything, so a missed/completed call card only
    # ever appeared for them after manually reopening the chat, not live.
    try:
        sse_manager.push_to_chat(chat, str(body.authorId), {
            "type": "new_message",
            "chatId": body.chatId,
            "messageId": new_message["id"],
            "message": {
                "id": new_message["id"],
                "chatId": body.chatId,
                "authorId": str(body.authorId),
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
    except Exception as sse_err:
        logger.warning(f"[calls] SSE push failed for chat {body.chatId}: {sse_err}")

    return {"ok": True, "duplicate": False}
