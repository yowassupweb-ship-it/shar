from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException

from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity, ensure_self_or_admin
from app.modules.push import service as push_service

router = APIRouter()

logger = logging.getLogger(__name__)


@router.get("/api/chats/notifications/{user_id}")
def get_notifications_chat_endpoint(user_id: str, me: Identity = Depends(current_identity)):
    """Чат уведомлений — только свой (админ — любой)."""
    ensure_self_or_admin(me, user_id)
    return get_or_create_notifications_chat(user_id)


def get_or_create_notifications_chat(user_id: str):
    """Получить или создать чат уведомлений для пользователя"""
    resolved_user_id = user_id
    try:
        user = db.get_user(user_id)
        if user and user.get('id'):
            resolved_user_id = user['id']
    except Exception as exc:
        logger.warning("[notifications] failed to resolve user id for %s: %s", user_id, exc)

    # Ищем по детерминированному id, а не перебором чатов пользователя с
    # фильтром по флагу is_notifications_chat: если флаг в строке не проставлен
    # (или чат не попал в выборку), поиск не находил существующий чат и код шёл
    # создавать его заново — с тем же самым id. Каждый такой вызов ронял в лог
    # duplicate key ... "chats_pkey" для notifications-<user_id>.
    chat_id = f"notifications-{resolved_user_id}"
    existing = None
    try:
        existing = db.get_chat(chat_id)
    except Exception as exc:
        logger.warning(f"[notifications] get_chat({chat_id}) failed: {exc}")
    if not existing:
        chats = db.get_user_chats(resolved_user_id) or []
        existing = next((c for c in chats if c.get('is_notifications_chat')), None)
    if existing:
        return snake_to_camel(existing)

    # Создаем новый чат уведомлений
    new_chat = {
        "id": chat_id,
        "title": "Уведомления",
        "is_group": False,
        "is_notifications_chat": True,
        "is_system_chat": True,
        "participant_ids": [resolved_user_id],
        "creator_id": resolved_user_id,
        "created_at": datetime.now().isoformat(),
        "read_messages_by_user": {},
        "pinned_by_user": {resolved_user_id: True}  # Автоматически закрепляем
    }
    
    db.create_chat(new_chat)
    
    return snake_to_camel(new_chat)


@router.post("/api/chats/notifications/{user_id}/send")
def send_notification_endpoint(user_id: str, notification_data: dict, me: Identity = Depends(current_identity)):
    """Уведомление в свой чат уведомлений. Чужой чат уведомлений с клиента не пишется:
    раньше любой мог подложить сотруднику «уведомление» с произвольным отправителем."""
    ensure_self_or_admin(me, user_id)
    return send_notification_message(user_id, notification_data)


def send_notification_message(user_id: str, notification_data: dict):
    """Отправить уведомление в чат уведомлений пользователя (для кода сервера)."""
    
    # Получаем или создаем чат уведомлений
    notifications_chat = get_or_create_notifications_chat(user_id)
    
    content = str(notification_data.get('content', '') or '').strip()
    content = re.sub(r'<[^>]*>', '', content)
    content = content.replace('\r\n', '\n')
    content = re.sub(r'[ \t]+', ' ', content)
    content = re.sub(r'\n{3,}', '\n\n', content).strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    notification_type = notification_data.get('notificationType') or notification_data.get('notification_type') or 'info'

    from_user_id = (
        notification_data.get('fromUserId')
        or notification_data.get('from_user_id')
        or notification_data.get('senderId')
        or notification_data.get('sender_id')
    )

    message_author_id = from_user_id or user_id
    try:
        resolved_user = db.get_user(str(message_author_id))
        if resolved_user and resolved_user.get('id'):
            message_author_id = resolved_user['id']
        else:
            fallback_author_id = notifications_chat.get('creator_id') or user_id
            if fallback_author_id and db.get_user(fallback_author_id):
                message_author_id = fallback_author_id
            else:
                users = db.get_users() or []
                first_valid_user = next((u for u in users if u and u.get('id')), None)
                if first_valid_user:
                    message_author_id = first_valid_user['id']
    except Exception as exc:
        logger.warning("[notifications] author resolve failed for %s: %s", user_id, exc)

    new_message = {
        "id": str(uuid.uuid4()),
        "chat_id": notifications_chat['id'],
        "author_id": message_author_id,
        "author_name": "Система",
        "content": content,
        "mentions": [],
        "reply_to_id": None,
        "created_at": datetime.now().isoformat(),
        "updated_at": None,
        "is_edited": False,
        "is_system_message": True,
        "linked_chat_id": notification_data.get('linkedChatId') or notification_data.get('linked_chat_id'),
        "linked_message_id": notification_data.get('linkedMessageId') or notification_data.get('linked_message_id'),
        "linked_task_id": notification_data.get('linkedTaskId') or notification_data.get('linked_task_id'),
        "linked_post_id": notification_data.get('linkedPostId') or notification_data.get('linked_post_id'),
        "linked_event_id": notification_data.get('linkedEventId') or notification_data.get('linked_event_id'),
        "notification_type": notification_type,
        "metadata": {
            "linkedEventId": notification_data.get('linkedEventId') or notification_data.get('linked_event_id'),
            "linkedEventTitle": notification_data.get('linkedEventTitle') or notification_data.get('linked_event_title'),
            "fromUserId": str(from_user_id) if from_user_id is not None else None,
            "fromUserName": notification_data.get('fromUserName') or notification_data.get('from_user_name'),
            # Дополнительные поля от вызывающего (интеграция с менеджеркой кладёт
            # сюда кнопку перехода и реквизиты документа). Разворачиваем последним,
            # но не даём затереть fromUserName пустым значением.
            **{k: v for k, v in (notification_data.get('metadata') or {}).items() if v is not None},
        }
    }

    saved_message = None
    try:
        saved_message = db.add_message(new_message)
    except Exception as exc:
        if new_message.get("linked_event_id"):
            logger.warning("[notifications] add_message failed with linked_event_id, fallback without it: %s", exc)
            fallback_message = dict(new_message)
            fallback_message.pop("linked_event_id", None)
            saved_message = db.add_message(fallback_message)
        else:
            raise

    if not saved_message and new_message.get("linked_event_id"):
        fallback_message = dict(new_message)
        fallback_message.pop("linked_event_id", None)
        saved_message = db.add_message(fallback_message)

    if not saved_message:
        raise HTTPException(status_code=500, detail="Failed to save notification message")

    # SSE push — send full message so recipient sees it immediately
    try:
        sse_manager.push(user_id, {
            "type": "new_message",
            "chatId": notifications_chat['id'],
            "message": snake_to_camel(saved_message),
        })
    except Exception:
        pass

    # Web Push (фоновое системное уведомление). Шлём ВСЕГДА, без проверки «в сети»: у
    # уведомления автор — сам получатель, обычный пуш сообщений его исключает, а скрытая
    # вкладка может держать живой сокет. Браузер/SW гасит пуш, если окно в фокусе.
    try:
        push_service.notify(
            [str(user_id)],
            title="🔔 Колокольчик",
            body=(content or '')[:80] or "Новое уведомление",
            url=f"/account?tab=messages&chat={notifications_chat['id']}",
            tag=f"chat-{notifications_chat['id']}",
            chatId=str(notifications_chat['id']),
        )
    except Exception as _push_err:
        logger.debug(f"Notification web push skipped: {_push_err}")

    return snake_to_camel(saved_message)
