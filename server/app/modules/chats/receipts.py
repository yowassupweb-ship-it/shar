from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Body, Depends

from app.core.db import db
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity
from app.modules.chats.access import require_member
from app.modules.chats.cache import _update_chat_cache_field

router = APIRouter()

logger = logging.getLogger(__name__)


@router.post("/api/chats/{chat_id}/typing")
def send_typing_indicator(chat_id: str, body: dict = Body(...), me: Identity = Depends(current_identity)):
    """Broadcast typing indicator to other chat participants via SSE."""
    # Кто печатает — из сессии, а не из тела запроса: иначе можно «печатать» за другого.
    user_id = me.user_id
    user_name = me.display_name
    # Defaults true for back-compat; the client sends false the instant the
    # composer goes back to empty, so the receiver can clear it right away
    # instead of waiting out its own timeout.
    is_typing = bool(body.get('isTyping', True))
    # 'text' (default) or 'file' — lets the receiver show a distinct "sending a
    # file" ghost bubble instead of the regular typing dots, reusing the exact
    # same presence-ping plumbing (push, throttle-free here, auto-clear on the
    # real message arriving) rather than a whole separate signal.
    kind = str(body.get('kind') or 'text')
    # Cached lookup — participant list rarely changes, and a live DB hit on
    # every keystroke throttle cycle was adding a full round-trip of latency
    # (or worse over a remote DB) in front of every typing event.
    chat = require_member(chat_id, me, allow_missing_own=False)
    try:
        sse_manager.push_to_chat(chat, user_id, {
            "type": "typing",
            "chatId": chat_id,
            "userId": user_id,
            "userName": user_name,
            "isTyping": is_typing,
            "kind": kind,
        })
    except Exception:
        pass
    return {"ok": True}


@router.post("/api/chats/{chat_id}/mark-read")
def mark_messages_as_read(chat_id: str, data_payload: dict, background_tasks: BackgroundTasks, me: Identity = Depends(current_identity)):
    """Отметить сообщения как прочитанные"""
    user_id = me.user_id  # маркер ставим только себе
    last_message_id = str(data_payload.get('lastMessageId') or '').strip()

    chat = require_member(chat_id, me, allow_missing_own=False)

    # Обновляем маркер последнего прочтения для пользователя
    read_messages_by_user = chat.get('read_messages_by_user') or chat.get('readMessagesByUser') or {}
    # Optimistic value, pushed immediately — this handler fires on every mousemove/
    # scroll/touch while a chat has unread messages (see markChatReadFromActivityRef
    # on the client), far more often than a message send. The previous version ran a
    # synchronous "does this message id exist" SELECT here, before the push below —
    # on this hot a path that made read receipts arrive noticeably slower than typing
    # or new-message pushes (neither of which do DB work before pushing). The
    # existence check now happens only in the deferred persist below, off the
    # request/push path entirely; last_message_id always comes from a message the
    # client already has loaded, so it's correct in the overwhelming majority of
    # pushes and self-corrects (via the persisted, DB-verified value) if not.
    provisional_value = last_message_id or datetime.now(timezone.utc).isoformat()
    read_messages_by_user[user_id] = provisional_value

    # Separate from read_messages_by_user above, which stores a MESSAGE ID (a
    # read-up-to marker for unread counts) rather than a timestamp — the read-detail
    # popup had nothing else to show as "read at" and fell back to that message's
    # own createdAt (its send time), which is why a message that sat unread for a
    # while showed a "read at" matching when it was *sent*. This is always a real
    # wall-clock value. The client already de-dupes against the last-marked message
    # id before ever calling this endpoint (see markChatRead), so in practice this
    # only advances on a genuine new read, not on every idle mousemove ping.
    read_at_by_user = chat.get('read_at_by_user') or chat.get('readAtByUser') or {}
    read_at_now = datetime.now(timezone.utc).isoformat()
    read_at_by_user[user_id] = read_at_now

    # Push instantly — the sender's checkmark must flip without waiting on the
    # chat-row write below. Mirrors send_message's push-then-defer-writes pattern.
    try:
        sse_manager.push_to_chat(chat, user_id, {
            "type": "read_receipt",
            "chatId": chat_id,
            "userId": user_id,
            "lastMessageId": read_messages_by_user.get(user_id, ''),
            "readAt": read_at_now,
        })
    except Exception:
        pass

    # Self-push (not push_to_chat — this targets the reader's *own* other devices/
    # tabs, not other participants) so reading this chat on one device closes any
    # pending OS push notification for it on every other device that's online right
    # now. Devices that are offline simply never receive this — their notification
    # is untouched, exactly as before.
    try:
        sse_manager.push(user_id, {
            "type": "notifications_read",
            "chatId": chat_id,
        })
    except Exception:
        pass

    def _persist_read_marker():
        try:
            final_value = provisional_value
            if last_message_id:
                # Point lookup — one row vs loading all messages. Now runs off the
                # request/push path, so a slow query here no longer delays delivery.
                msg_exists = hasattr(db, 'conn') and db.conn.fetch_one(
                    "SELECT 1 FROM messages WHERE id = %s AND chat_id = %s LIMIT 1",
                    (last_message_id, chat_id)
                )
                if not msg_exists:
                    final_value = datetime.now(timezone.utc).isoformat()
            read_messages_by_user[user_id] = final_value
            db.merge_user_map(chat_id, 'read_messages_by_user', user_id, final_value)
            db.merge_user_map(chat_id, 'read_at_by_user', user_id, read_at_now)
            # Update in place rather than invalidate — mark-read now fires on every
            # scroll/touch/typing tick (not just chat-open), so a hard invalidate here
            # left the cache cold for the *next* call's participant-list lookup right
            # before its own push, reintroducing the DB round-trip the push-first
            # design was meant to avoid. The cached chat's participant_ids didn't
            # change, only read_messages_by_user/read_at_by_user, so patching them in
            # place is safe.
            _update_chat_cache_field(chat_id, 'read_messages_by_user', read_messages_by_user)
            _update_chat_cache_field(chat_id, 'read_at_by_user', read_at_by_user)
        except Exception as e:
            logger.debug(f"Deferred read-marker persist failed: {e}")
    background_tasks.add_task(_persist_read_marker)

    return {"success": True}
