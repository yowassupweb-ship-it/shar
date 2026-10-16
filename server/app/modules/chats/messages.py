from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException

from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity
from app.core.telegram import telegram
from app.modules.calls.presence import _call_presence_count
from app.modules.chats.access import (
    is_creator,
    participant_ids,
    require_member,
)
from app.modules.chats.cache import (
    _bumps_chat_list,
    _get_chat_cached,
    _invalidate_chat_cache,
    _update_chat_cache_field,
)
from app.modules.chats.inline import _externalize_message
from app.modules.chats.schemas import MessageCreate
from app.modules.push import service as push_service
from app.modules.realtime.frames import (
    valid_client_message_id as _valid_client_message_id,
)

router = APIRouter()

logger = logging.getLogger(__name__)


@router.get("/api/chats/{chat_id}/messages")
def get_chat_messages(chat_id: str, limit: int = 50, before: Optional[str] = None, me: Identity = Depends(current_identity)):
    """Получить сообщения чата с поддержкой пагинации.

    limit — сколько сообщений вернуть (max 100).
    before — ISO-timestamp: вернуть сообщения СТАРШЕ этого момента (для подгрузки истории).
    Ответ: {messages: [...], hasMore: bool}
    """
    require_member(chat_id, me)
    page_size = min(max(limit, 1), 100)
    chat_messages = db.get_messages(chat_id, limit=page_size, before_timestamp=before or None)
    has_more = len(chat_messages) == page_size
    return {
        "messages": [_externalize_message(snake_to_camel(msg)) for msg in chat_messages],
        "hasMore": has_more,
    }


@router.post("/api/chats/{chat_id}/messages")
def send_message(chat_id: str, message_data: MessageCreate, background_tasks: BackgroundTasks, me: Identity = Depends(current_identity)):
    """Отправить сообщение в чат. Автор — всегда вошедший: authorId/authorName из тела игнорируются."""
    message_data.authorId = me.user_id
    message_data.authorName = me.display_name

    # Проверяем существование чата и членство
    chat = require_member(chat_id, me)

    # Если чат не найден, а это свой «Избранный» чат — создаём его автоматически
    if not chat and chat_id == f"favorites_{me.user_id}":
        user_id = me.user_id
        new_chat = {
            "id": chat_id,
            "title": "Избранное",
            "is_group": False,
            "is_favorites_chat": True,
            "participant_ids": [user_id],
            "creator_id": user_id,
            "created_at": datetime.now().isoformat(),
            "read_messages_by_user": {},
            "pinned_by_user": {user_id: True}
        }
        chat = db.create_chat(new_chat)

    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")

    # Имя автора берём из сессии (она уже в кэше — лишнего запроса в базу нет):
    # присланному клиентом имени верить нельзя, иначе можно писать «от имени» коллеги.
    author_name = me.display_name

    message_created_at = datetime.now(timezone.utc)

    metadata_payload: Dict[str, Any] = dict(message_data.metadata or {})
    forwarded_from_message_id = message_data.forwardedFrom or metadata_payload.get('forwardedFromMessageId')
    forwarded_from_user_id = message_data.forwardedFromUserId or metadata_payload.get('forwardedFromUserId')
    forwarded_from_username = message_data.forwardedFromUsername or metadata_payload.get('forwardedFromUsername') or metadata_payload.get('fromUserName')

    if forwarded_from_message_id and (not forwarded_from_user_id or not forwarded_from_username):
      try:
        original_row = None
        if hasattr(db, 'conn'):
            original_row = db.conn.fetch_one(
                "SELECT author_id, author_name, metadata FROM messages WHERE id = %s",
                (forwarded_from_message_id,)
            )
        if original_row:
            original_message = dict(original_row)
            if not forwarded_from_user_id:
                forwarded_from_user_id = original_message.get('author_id')
            if not forwarded_from_username:
                forwarded_from_username = original_message.get('author_name')
                original_meta = original_message.get('metadata')
                if isinstance(original_meta, dict):
                    forwarded_from_username = (
                        forwarded_from_username
                        or original_meta.get('forwardedFromUsername')
                        or original_meta.get('fromUserName')
                    )
      except Exception as forward_meta_error:
        logger.warning(f"Failed to resolve forwarded metadata for message {forwarded_from_message_id}: {forward_meta_error}")

        if forwarded_from_user_id and not forwarded_from_username:
            try:
                forwarded_user = db.get_user(str(forwarded_from_user_id))
                if forwarded_user:
                        forwarded_from_username = (
                                forwarded_user.get('name')
                                or forwarded_user.get('username')
                                or forwarded_user.get('email')
                        )
            except Exception as forward_user_error:
                logger.warning(f"Failed to resolve forwarded user {forwarded_from_user_id}: {forward_user_error}")

    if forwarded_from_message_id:
        metadata_payload.update({
            'forwardedFromMessageId': forwarded_from_message_id,
            'forwardedFromUserId': str(forwarded_from_user_id) if forwarded_from_user_id is not None else None,
            'forwardedFromUsername': forwarded_from_username,
            'fromUserName': forwarded_from_username,
        })

    # Idempotency guard against duplicate sends on a flaky connection. The client's
    # fetchWithRetry re-POSTs when the first attempt times out — but on a slow link the
    # first attempt often DID reach the server and commit a row; only its response was
    # lost. Both attempts carry the same metadata.clientNonce, so if a row for this
    # (chat, author, nonce) already exists, return it verbatim instead of writing a second
    # copy. Retries are sequential (fetchWithRetry awaits + backs off between attempts),
    # so by the time the retry lands the original row is committed and this lookup finds it.
    client_id = _valid_client_message_id(message_data.id)
    client_nonce = metadata_payload.get('clientNonce')
    existing = None
    # С клиентским id повтор узнаём самой вставкой (ON CONFLICT ниже) — без
    # лишнего SELECT перед каждым сообщением. Поиск по nonce — для старых клиентов.
    if not client_id and client_nonce:
        try:
            existing = db.find_message_by_client_nonce(chat_id, str(message_data.authorId), str(client_nonce))
        except Exception as nonce_err:
            logger.debug(f"clientNonce lookup failed for chat {chat_id}: {nonce_err}")
            existing = None
    def _duplicate(existing):
        ex_created = existing.get('created_at')
        ex_created_iso = ex_created.isoformat() if hasattr(ex_created, 'isoformat') else str(ex_created)
        ex_updated = existing.get('updated_at')
        ex_meta = existing.get('metadata') if isinstance(existing.get('metadata'), dict) else {}
        dup_msg = {
            "id": str(existing.get('id')),
            "chatId": chat_id,
            "authorId": str(existing.get('author_id')),
            "authorName": existing.get('author_name') or author_name,
            "content": existing.get('content') or "",
            "createdAt": ex_created_iso,
            "updatedAt": ex_updated.isoformat() if hasattr(ex_updated, 'isoformat') else ex_updated,
            "isEdited": bool(existing.get('is_edited')),
            "isDeleted": bool(existing.get('is_deleted')),
            "isSystemMessage": bool(existing.get('is_system_message')),
            "attachments": existing.get('attachments') or [],
            "mentions": existing.get('mentions') or [],
            "replyToId": existing.get('reply_to_id'),
            "metadata": ex_meta,
        }
        if existing.get('forwarded_from_message_id'):
            dup_msg["forwardedFromMessageId"] = existing.get('forwarded_from_message_id')
            dup_msg["forwardedFromUserId"] = str(existing.get('forwarded_from_user_id')) if existing.get('forwarded_from_user_id') else None
            dup_msg["forwardedFromUsername"] = existing.get('forwarded_from_username')
        logger.info(f"Idempotent send: returning existing message {dup_msg['id']} for clientNonce {client_nonce}")
        # No SSE/push/deferred writes here — the original insert already fired them.
        return dup_msg

    if existing:
        return _duplicate(existing)

    new_message = {
        "id": client_id or str(uuid.uuid4()),
        "chat_id": chat_id,
        "author_id": message_data.authorId,
        "author_name": author_name,
        "content": message_data.content,
        "mentions": message_data.mentions or [],
        "reply_to_id": message_data.replyToId,
        "created_at": message_created_at.isoformat(),
        "updated_at": None,
        "is_edited": False,
        "attachments": message_data.attachments or [],
        "metadata": metadata_payload,
        "forwarded_from_user_id": str(forwarded_from_user_id) if forwarded_from_user_id is not None else None,
        "forwarded_from_username": forwarded_from_username,
        "forwarded_from_message_id": forwarded_from_message_id,
    }
    
    result = db.add_message(new_message, if_new=bool(client_id))
    if not result and client_id:
        # Пусто — либо id уже занят (повтор отправки), либо запись не удалась.
        try:
            existing = db.conn.fetch_one("SELECT * FROM messages WHERE id = %s", (client_id,)) if hasattr(db, 'conn') else None
        except Exception as id_err:
            logger.debug(f"client id lookup failed for {client_id}: {id_err}")
            existing = None
        if existing:
            if str(existing.get('author_id')) != str(message_data.authorId):
                raise HTTPException(status_code=409, detail="Message id already used")
            return _duplicate(existing)
    if not result:
        # add_message/fetch_one swallow the real DB exception and return None on any
        # failure (broken connection, constraint violation, timeout) — this is an
        # INSERT ... RETURNING *, so None here always means the row was never written,
        # never a legitimate empty result. Without this check, everything below still
        # ran: the sender and every participant saw the message "sent" and delivered
        # live via SSE even though it silently never made it into the database, and it
        # vanished the next time anyone reloaded the chat.
        raise HTTPException(status_code=500, detail="Failed to save message")

    # Pre-build camelCase response from new_message (avoid recursive snake_to_camel on full row)
    msg_id = new_message["id"]
    camel_msg = {
        "id": msg_id,
        "chatId": chat_id,
        "authorId": str(message_data.authorId),
        "authorName": author_name,
        "content": message_data.content or "",
        "createdAt": message_created_at.isoformat(),
        "updatedAt": None,
        "isEdited": False,
        "isDeleted": False,
        "isSystemMessage": False,
        "attachments": message_data.attachments or [],
        "mentions": message_data.mentions or [],
        "replyToId": message_data.replyToId,
        "metadata": metadata_payload or {},
    }
    if forwarded_from_message_id:
        camel_msg["forwardedFromMessageId"] = forwarded_from_message_id
        camel_msg["forwardedFromUserId"] = str(forwarded_from_user_id) if forwarded_from_user_id else None
        camel_msg["forwardedFromUsername"] = forwarded_from_username

    # SSE push — send instantly after DB write, before deferred operations
    try:
        sse_manager.push_to_chat(chat, str(message_data.authorId), {
            "type": "new_message",
            "chatId": chat_id,
            "messageId": msg_id,
            "message": camel_msg,
        })
    except Exception as sse_err:
        logger.warning(f"SSE push failed for chat {chat_id}: {sse_err}")

    # Defer non-critical DB writes via BackgroundTasks — response returns first
    def _deferred_writes():
        try:
            rmu = dict(chat.get('read_messages_by_user') or chat.get('readMessagesByUser') or {})
            rmu[str(message_data.authorId)] = msg_id
            db.merge_user_map(chat_id, 'read_messages_by_user', str(message_data.authorId), msg_id)
            # In-place update (not invalidate) — same reasoning as mark-read's deferred
            # persist: keeps participant_ids warm for the next push_to_chat lookup.
            _update_chat_cache_field(chat_id, 'read_messages_by_user', rmu)
        except Exception as e:
            logger.debug(f"Deferred read-marker update failed: {e}")
        try:
            db.update_user(str(message_data.authorId), {
                "isOnline": True,
                "lastSeen": message_created_at.isoformat(),
            })
        except Exception as e:
            logger.debug(f"Deferred online-status update failed: {e}")

    def _dispatch_web_push():
        _send_message_web_push(chat, chat_id, message_data, author_name, msg_id)

    # Web Push — после ответа: отбор получателей ходит в Redis по разу на
    # каждого участника (кто в сети), в общем чате это десятки запросов, и
    # автор ждал их до подтверждения отправки. Собеседники к этому моменту
    # уже получили сообщение по сокету — пуш только для тех, кто не в сети.
    background_tasks.add_task(_dispatch_web_push)
    background_tasks.add_task(_deferred_writes)

    # Return the pre-built camelCase object — no additional conversion needed
    return camel_msg


def _send_message_web_push(chat: dict, chat_id: str, message_data, author_name: str, msg_id: str) -> None:
    """Web Push для не подключённых получателей (фон, после ответа отправителю)."""
    try:
        recipient_ids = [
            str(uid) for uid in (chat.get('participant_ids') or chat.get('participantIds') or [])
            if str(uid) != str(message_data.authorId)
        ]
        # Filter out recipients who muted this chat — UNLESS the message is marked
        # important with a leading '!': such messages must reach everyone, including
        # those who muted the chat (mirrors the chat-header mute toggle / SW / client).
        is_important = (message_data.content or '').lstrip().startswith('!')
        if not is_important:
            muted_by_user = chat.get('muted_by_user') or chat.get('mutedByUser') or {}
            recipient_ids = [uid for uid in recipient_ids if not muted_by_user.get(uid)]
        # Skip web push to recipients who are currently online (have a live WS
        # connection on any device, tracked in Redis presence): they receive the
        # message live over WS, so an extra OS push is redundant — this is what
        # was buzzing someone's desktop while they were actively chatting on their
        # phone. Only genuinely-offline recipients get a background push.
        recipient_ids = [uid for uid in recipient_ids if _call_presence_count(uid) <= 0]
        if not recipient_ids:
            return
        chat_title = chat.get('title') or chat.get('name') or 'Новое сообщение'
        result = push_service.notify(
            recipient_ids,
            title=f"{author_name} в {chat_title}" if chat.get('isGroup') or chat.get('is_group') else author_name,
            body=(message_data.content or '')[:80] or "Вложение",
            url=f"/account?tab=messages&chat={chat_id}",
            tag=f"chat-{chat_id}",
            chatId=str(chat_id),
            senderName=author_name,
        )
        # Tell the SENDER (not the recipients — they get the OS notification itself)
        # that at least one recipient's device actually received a push for this
        # message, distinct from them having read it.
        if result.get('sent', 0) > 0:
            sse_manager.push(str(message_data.authorId), {
                "type": "push_delivered",
                "chatId": chat_id,
                "messageId": msg_id,
            })
    except Exception as push_err:
        logger.debug(f"Web push dispatch skipped: {push_err}")


def post_system_message(chat_id: str, data_payload: dict) -> dict:
    """Добавить системное сообщение в чат (центрированная плашка-уведомление).

    Только для кода сервера (HTTP-маршрута нет: с клиента «Система» писать нельзя).

    Используется потоком заявок для событий «Заявка закрыта…» / «Заявка
    возобновлена». Помечается is_system_message=True, поэтому не участвует в
    подсчёте непрочитанных и рендерится как системная плашка у всех участников."""
    content = str(data_payload.get('content') or '').strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    chat = _get_chat_cached(chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")

    system_event = data_payload.get('systemEvent') or 'request_event'
    created_at = datetime.now(timezone.utc)
    sys_msg = {
        'id': str(uuid.uuid4()),
        'chat_id': chat_id,
        'author_id': None,  # у системного сообщения нет пользователя-автора (колонка допускает NULL)
        'author_name': 'Система',
        'content': content,
        'is_system_message': True,
        'metadata': {'systemEvent': system_event},
        'created_at': created_at.isoformat(),
    }

    if not db.add_message(sys_msg):
        raise HTTPException(status_code=500, detail="Failed to save system message")

    try:
        db.update_chat(chat_id, {'last_message_id': sys_msg['id'], 'updated_at': created_at.isoformat()})
        _update_chat_cache_field(chat_id, 'last_message_id', sys_msg['id'])
    except Exception as e:
        logger.debug(f"system-message last_message update failed: {e}")

    camel_msg = {
        'id': sys_msg['id'],
        'chatId': chat_id,
        'authorId': 'system',
        'authorName': 'Система',
        'content': content,
        'createdAt': created_at.isoformat(),
        'isSystemMessage': True,
        'metadata': {'systemEvent': system_event},
        'attachments': [],
        'mentions': [],
    }
    try:
        sse_manager.push_to_chat(chat, '', {
            'type': 'new_message',
            'chatId': chat_id,
            'messageId': sys_msg['id'],
            'message': camel_msg,
        })
    except Exception as sse_err:
        logger.warning(f"SSE push failed for system message in chat {chat_id}: {sse_err}")

    return camel_msg


# Что можно менять PATCH-ом в metadata. Всё остальное (в том числе системные ключи
# вроде systemEvent, authorId, isPinned) сюда не пускаем: раньше metadata сливалась
# в строку сообщения как есть.
_PATCHABLE_META = {"reactionToggle", "poll", "voiceListened"}


def _push_chat_event(chat: dict, actor_id: str, event: dict) -> None:
    # Автора не исключаем: его второе устройство (телефон при правке с компьютера) иначе
    # не узнает о правке/удалении/реакции до перезагрузки. Клиент применяет события
    # идемпотентно — на устройстве, где действие сделано, это то же самое состояние.
    try:
        sse_manager.push_to_chat(chat, '', event)
    except Exception as e:
        logger.error(f"Failed to push {event.get('type')} SSE: {e}")


def _apply_poll_change(old_poll: dict, new_poll: dict, uid: str, is_author: bool) -> dict:
    """Серверная проверка опроса.

    Автор может пересоздать опрос (голоса сбрасываются). Остальные — только голосовать:
    из присланного состояния берём единственное, что им позволено, — своё присутствие
    в списках голосов; всё прочее (текст, варианты, чужие голоса) остаётся как было."""
    if is_author and not any((o or {}).get('voters') for o in (new_poll.get('options') or [])):
        options = [
            {"id": str(o.get('id') or uuid.uuid4().hex[:9]), "text": str(o.get('text') or '')[:300], "voters": []}
            for o in (new_poll.get('options') or []) if isinstance(o, dict)
        ][:20]
        if len(options) < 2:
            raise HTTPException(status_code=400, detail="В опросе должно быть минимум два варианта")
        return {**{k: new_poll[k] for k in ("question", "multipleChoice", "allowRevote", "isAnonymous") if k in new_poll},
                "question": str(new_poll.get('question') or '')[:500], "options": options}
    if not isinstance(old_poll, dict) or not old_poll.get('options'):
        raise HTTPException(status_code=400, detail="В сообщении нет опроса")
    wanted = {str(o.get('id')): uid in [str(v) for v in (o.get('voters') or [])] for o in (new_poll.get('options') or []) if isinstance(o, dict)}
    voted_before = any(uid in [str(v) for v in (o.get('voters') or [])] for o in old_poll['options'])
    chosen = [oid for oid, on in wanted.items() if on]
    if not old_poll.get('multipleChoice') and len(chosen) > 1:
        raise HTTPException(status_code=400, detail="В этом опросе можно выбрать один вариант")
    if voted_before and not old_poll.get('allowRevote'):
        raise HTTPException(status_code=409, detail="Переголосовать нельзя")
    result = dict(old_poll)
    result['options'] = []
    for o in old_poll['options']:
        voters = [str(v) for v in (o.get('voters') or []) if str(v) != uid]
        if wanted.get(str(o.get('id'))):
            voters.append(uid)
        result['options'].append({**o, 'voters': voters})
    return result


@router.patch("/api/chats/{chat_id}/messages/{message_id}")
@_bumps_chat_list
def update_message(chat_id: str, message_id: str, update_data: dict, me: Identity = Depends(current_identity)):
    """Изменить сообщение: текст (автор), реакция, голос в опросе, «прослушано».

    Каждое действие — от вошедшего: userId из тела не читается, а сообщение должно быть
    именно из этого чата. Раньше любой мог переписать любое сообщение по одному id."""
    chat = require_member(chat_id, me, allow_missing_own=False)
    row = db.conn.fetch_one("SELECT * FROM messages WHERE id = %s AND chat_id = %s", (message_id, chat_id))
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")
    old = dict(row)
    if old.get('is_deleted'):
        raise HTTPException(status_code=404, detail="Message not found")
    is_author = str(old.get('author_id')) == me.user_id

    meta_in = update_data.get('metadata') if isinstance(update_data.get('metadata'), dict) else {}
    unknown = set(meta_in) - _PATCHABLE_META
    if unknown or 'isPinned' in update_data or ('content' not in update_data and not meta_in):
        raise HTTPException(status_code=400, detail="Nothing to update" if not unknown else "Unsupported fields")

    # ── Правка текста: только автор ─────────────────────────────────────────────
    if 'content' in update_data:
        if not is_author or old.get('is_system_message'):
            raise HTTPException(status_code=403, detail="Редактировать можно только своё сообщение")
        content = str(update_data['content'])
        if not content.strip():
            raise HTTPException(status_code=400, detail="Пустое сообщение")
        updated = db.conn.fetch_one(
            "UPDATE messages SET content = %s, is_edited = true, updated_at = NOW() WHERE id = %s AND chat_id = %s RETURNING *",
            (content, message_id, chat_id),
        )
        if not updated:
            raise HTTPException(status_code=404, detail="Message not found")
        _push_chat_event(chat, me.user_id, {"type": "message_edited", "chatId": chat_id, "messageId": message_id, "content": content})
        return snake_to_camel(dict(updated))

    # ── Реакция: переключаем только СВОЮ, атомарно (два реагирующих не затирают друг друга) ──
    toggle = meta_in.get('reactionToggle')
    if toggle is not None:
        if not isinstance(toggle, dict) or not toggle.get('emoji'):
            raise HTTPException(status_code=400, detail="emoji required")
        emoji = str(toggle['emoji'])[:32]
        updated_row = db.toggle_message_reaction(message_id, emoji, me.user_id)
        if not updated_row:
            raise HTTPException(status_code=404, detail="Message not found")
        new_reactions = (updated_row.get('metadata') or {}).get('reactions') or {}
        _push_chat_event(chat, me.user_id, {
            "type": "reaction", "chatId": chat_id, "messageId": message_id,
            "reactions": new_reactions, "actorUserId": me.user_id,
        })
        # Уведомление в Telegram — только когда реакцию ДОБАВИЛИ и поставил не автор.
        try:
            added = me.user_id in [str(u) for u in (new_reactions.get(emoji) or [])]
            if added and not is_author:
                telegram.notify_reaction(me.display_name, emoji, updated_row.get('content', ''), chat.get('title') or chat.get('name'))
        except Exception as e:
            logger.error(f"Failed to send reaction notification: {e}")
        return snake_to_camel(updated_row)

    # ── Опрос ───────────────────────────────────────────────────────────────────
    patch: Dict[str, Any] = {}
    if 'poll' in meta_in:
        if not isinstance(meta_in['poll'], dict):
            raise HTTPException(status_code=400, detail="poll must be an object")
        old_poll = (old.get('metadata') or {}).get('poll') or {}
        patch['poll'] = _apply_poll_change(old_poll, meta_in['poll'], me.user_id, is_author)
    # ── «Прослушано» (голосовое): отмечает получатель, не автор ──────────────────
    if 'voiceListened' in meta_in:
        if is_author:
            raise HTTPException(status_code=400, detail="Автор не может отметить своё голосовое прослушанным")
        patch['voiceListened'] = True

    row = db.conn.fetch_one(
        "UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb, updated_at = NOW() "
        "WHERE id = %s AND chat_id = %s RETURNING *",
        (json.dumps(patch, ensure_ascii=False), message_id, chat_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")
    if 'poll' in patch:
        _push_chat_event(chat, me.user_id, {"type": "poll_vote", "chatId": chat_id, "messageId": message_id, "poll": patch['poll']})
    if 'voiceListened' in patch:
        _push_chat_event(chat, me.user_id, {"type": "voice_listened", "chatId": chat_id, "messageId": message_id})
    return snake_to_camel(dict(row))


def _push_participant_system_message(chat_for_push: dict, chat_id: str, actor_user_id: str, actor_name: str, text: str, action: str, target_user_id: str):
    """Create + live-push a centered system message for a participant add/remove."""
    import uuid as _uuid
    sys_msg = {
        "id": str(_uuid.uuid4()),
        "chat_id": chat_id,
        "author_id": actor_user_id,
        "author_name": actor_name,
        "content": text,
        "mentions": [],
        "reply_to_id": None,
        "created_at": datetime.now().isoformat(),
        "updated_at": None,
        "is_edited": False,
        "is_system_message": True,
        "notification_type": action,
        "attachments": [],
        "metadata": {"action": action, "userId": str(target_user_id)},
    }
    created = db.add_message(sys_msg)
    try:
        camel = snake_to_camel(created) if created else snake_to_camel(sys_msg)
        sse_manager.push_to_chat(chat_for_push, '', {
            "type": "new_message", "chatId": chat_id, "messageId": sys_msg["id"], "message": camel,
        })
    except Exception as e:
        logger.warning(f"[participants] system-message push failed for {chat_id}: {e}")
    return created


def _group_chat_or_400(chat: dict) -> None:
    if not (chat.get('is_group') or chat.get('isGroup')) or chat.get('is_system_chat') or chat.get('is_favorites_chat'):
        raise HTTPException(status_code=400, detail="Состав меняется только у групповых чатов")


@router.post("/api/chats/{chat_id}/participants")
def add_chat_participant_endpoint(chat_id: str, payload: dict = Body(...), me: Identity = Depends(current_identity)):
    """Добавить участника в групповой чат (может любой участник группы)."""
    chat = require_member(chat_id, me, allow_missing_own=False)
    _group_chat_or_400(chat)
    user_id = str(payload.get('userId') or '').strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="userId is required")
    added = db.get_user_by_id(user_id)
    if not added or added.get('isDisabled') or added.get('is_disabled'):
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if user_id in participant_ids(chat):
        return {"success": True, "notification": None}
    db.add_chat_participant(chat_id, user_id)
    _invalidate_chat_cache(chat_id)
    added_name = added.get('name') or added.get('username') or 'Пользователь'
    fresh = db.get_chat(chat_id) or chat
    created = _push_participant_system_message(fresh, chat_id, me.user_id, me.display_name, f"{added_name} добавлен(а) в чат", "participant_added", user_id)
    # Новый участник получит чат в списке при следующей загрузке; подтолкнём его.
    try:
        sse_manager.push(user_id, {"type": "new_message", "chatId": chat_id})
    except Exception:
        pass
    return {"success": True, "notification": snake_to_camel(created) if created else None}


@router.delete("/api/chats/{chat_id}/participants/{user_id}")
def remove_chat_participant_endpoint(chat_id: str, user_id: str, me: Identity = Depends(current_identity)):
    """Удалить участника из группы: создатель или админ — любого, остальные — только себя (выйти)."""
    chat = require_member(chat_id, me, allow_missing_own=False)
    _group_chat_or_400(chat)
    if str(user_id) != me.user_id and not (is_creator(chat, me) or me.is_admin):
        raise HTTPException(status_code=403, detail="Удалять других участников может создатель группы")
    if str(user_id) not in participant_ids(chat):
        return {"success": True}
    removed = db.get_user_by_id(str(user_id)) or {}
    removed_name = removed.get('name') or removed.get('username') or 'Пользователь'
    # Push по chat ДО удаления — удаляемый тоже получит «удалён(а) из чата».
    _push_participant_system_message(chat, chat_id, me.user_id, me.display_name, f"{removed_name} удалён(а) из чата", "participant_removed", user_id)
    db.remove_chat_participant(chat_id, str(user_id))
    _invalidate_chat_cache(chat_id)
    return {"success": True}


@router.post("/api/chats/{chat_id}/messages/{message_id}/pin")
@_bumps_chat_list
def pin_message(chat_id: str, message_id: str, payload: dict = Body(...), me: Identity = Depends(current_identity)):
    """Закрепить или открепить сообщение в чате (любой участник — от своего имени)"""

    user_id = me.user_id
    require_member(chat_id, me, allow_missing_own=False)

    raw_is_pinned = payload.get('isPinned', True)
    if isinstance(raw_is_pinned, str):
        is_pinned = raw_is_pinned.strip().lower() in ('1', 'true', 'yes', 'on')
    else:
        is_pinned = bool(raw_is_pinned)

    actor_name = me.display_name

    chat = db.get_chat(chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")

    if hasattr(db, 'conn'):
        target_message = db.conn.fetch_one(
            "SELECT * FROM messages WHERE id = %s AND chat_id = %s AND is_deleted = false",
            (message_id, chat_id)
        )
        if not target_message:
            raise HTTPException(status_code=404, detail="Message not found")

        pinned_message_row = None
        if is_pinned:
            pinned_message_row = db.conn.fetch_one(
                """
                UPDATE messages
                SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'isPinned', true,
                    'pinnedBy', %s,
                    'pinnedAt', %s
                ),
                updated_at = NOW()
                WHERE id = %s
                RETURNING *
                """,
                (user_id, datetime.now().isoformat(), message_id)
            )
        else:
            pinned_message_row = db.conn.fetch_one(
                """
                UPDATE messages
                SET metadata = COALESCE(metadata, '{}'::jsonb) - 'isPinned' - 'pinnedBy' - 'pinnedAt',
                    updated_at = NOW()
                WHERE id = %s AND chat_id = %s
                RETURNING *
                """,
                (message_id, chat_id)
            )

        target_message_dict = dict(target_message)
        preview = (target_message_dict.get('content') or '').strip()
        if len(preview) > 100:
            preview = preview[:100] + '...'

        notification_message = {
            "id": str(uuid.uuid4()),
            "chat_id": chat_id,
            "author_id": user_id,
            "author_name": actor_name,
            "content": f"{actor_name} {'закрепил(а)' if is_pinned else 'открепил(а)'} сообщение",
            "mentions": [],
            "reply_to_id": None,
            "created_at": datetime.now().isoformat(),
            "updated_at": None,
            "is_edited": False,
            "is_system_message": True,
            "notification_type": "message_pin",
            "linked_message_id": message_id,
            "attachments": [],
            "metadata": {
                "action": "pin_message",
                # NB: intentionally NOT "isPinned" — that key is what the pinned-messages
                # bar filters on, so putting it here made this notification itself show up
                # as a pinned message. Record the direction under a distinct key.
                "pinDirection": "pinned" if is_pinned else "unpinned",
                "pinnedMessageId": message_id,
                "preview": preview,
            },
        }
        created_notification = db.add_message(notification_message)

        return {
            "success": True,
            "isPinned": is_pinned,
            "pinnedMessage": snake_to_camel(dict(pinned_message_row)) if pinned_message_row else None,
            "notification": snake_to_camel(created_notification) if created_notification else None,
        }

    raise HTTPException(status_code=500, detail="Pinning messages is only available in PostgreSQL mode")



@router.delete("/api/chats/{chat_id}/messages/{message_id}")
def delete_message(chat_id: str, message_id: str, me: Identity = Depends(current_identity)):
    """Мягкое удаление сообщения: автор (или админ) — своё, чужое нельзя."""
    chat = require_member(chat_id, me, allow_missing_own=False)
    row = db.conn.fetch_one("SELECT id, author_id, is_system_message FROM messages WHERE id = %s AND chat_id = %s", (message_id, chat_id))
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")
    if str(row.get('author_id')) != me.user_id and not me.is_admin:
        raise HTTPException(status_code=403, detail="Удалять можно только свои сообщения")

    if not db.delete_message(message_id):
        raise HTTPException(status_code=404, detail="Message not found")

    # Остальные участники узнают об удалении сразу, не после перезагрузки.
    _push_chat_event(chat, me.user_id, {"type": "message_deleted", "chatId": chat_id, "messageId": message_id})
    return {"success": True}
