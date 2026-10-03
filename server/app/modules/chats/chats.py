from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity
from app.modules.chats import list_cache as chat_list_cache
from app.modules.chats.access import is_creator, require_member
from app.modules.chats.cache import _invalidate_chat_cache
from app.modules.chats.schemas import ChatCreate

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/api/chats")
def get_chats(user_id: Optional[str] = None, include_archived: bool = False, me: Identity = Depends(current_identity)):
    """Получить список всех чатов пользователя.

    Ответ берётся из кэша, пока ни один чат пользователя не менялся
    (chat_list_cache): старые клиенты запрашивают список на каждое событие
    сокета, и одинаковые расчёты забивали единственное ядро сервера — за ними
    стояла в очереди отправка сообщений."""
    uid = str(user_id or me.user_id).strip()
    if uid != me.user_id and not me.is_admin:
        raise HTTPException(status_code=403, detail="Нет доступа к чатам другого пользователя")
    return chat_list_cache.get_or_compute(
        uid, 'all' if include_archived else 'active', lambda: _compute_user_chats(uid, include_archived),
    )


def _compute_user_chats(user_id: str, include_archived: bool) -> list:

    chats = db.get_user_chats(user_id)
    created_system = False

    # Автоматически создаем служебные чаты при первом запросе.
    # Существование проверяем по id, а не по паре «флаг + участник»: если в
    # выборке не оказалось participant_ids (ARRAY_AGG отдаёт пусто, когда
    # chat_participants не заполнен), условие не выполнялось, и код пытался
    # создать чат с уже существующим id. На каждый запрос /api/chats в лог
    # падало duplicate key ... "chats_pkey".
    existing_ids = {str(c.get('id')) for c in chats}

    notifications_chat = next(
        (c for c in chats if str(c.get('id')) == f"notifications-{user_id}"
         or (c.get('is_notifications_chat') and user_id in (c.get('participant_ids') or []))),
        None,
    )
    if not notifications_chat and f"notifications-{user_id}" not in existing_ids:
        notifications_chat = {
            "id": f"notifications-{user_id}",
            "title": "Уведомления",
            "is_group": False,
            "is_notifications_chat": True,
            "is_system_chat": True,
            "participant_ids": [user_id],
            "creator_id": user_id,
            "created_at": datetime.now().isoformat(),
            "read_messages_by_user": {}
        }
        db.create_chat(notifications_chat)
        chats.append(notifications_chat)
        created_system = True

    favorites_chat = next(
        (c for c in chats if str(c.get('id')) == f"favorites_{user_id}"
         or (c.get('is_favorites_chat') and user_id in (c.get('participant_ids') or []))),
        None,
    )
    if not favorites_chat and f"favorites_{user_id}" not in existing_ids:
        favorites_chat = {
            "id": f"favorites_{user_id}",
            "title": "Избранное",
            "is_group": False,
            "is_favorites_chat": True,
            "is_system_chat": True,
            "participant_ids": [user_id],
            "creator_id": user_id,
            "created_at": datetime.now().isoformat(),
            "read_messages_by_user": {}
        }
        db.create_chat(favorites_chat)
        chats.append(favorites_chat)
        created_system = True

    # Перезагружаем только если создали новые чаты (чтобы получить сгенерированные поля из БД)
    if created_system:
        chats = db.get_user_chats(user_id)

    user_chats = chats

    def get_bool_from_map(raw_map: Any, key: str) -> bool:
        if not isinstance(raw_map, dict):
            return False
        value = raw_map.get(key)
        if isinstance(value, str):
            return value.strip().lower() in ('1', 'true', 'yes', 'on')
        return value is True

    # Bulk-загрузка задач для синхронизации статуса обсуждения (1 запрос вместо N)
    todo_ids = [
        str(c.get('todo_id') or c.get('todoId'))
        for c in user_chats
        if c.get('todo_id') or c.get('todoId')
    ]
    tasks_by_id: dict = db.get_tasks_by_ids(todo_ids) if todo_ids and hasattr(db, 'get_tasks_by_ids') else {}

    # Синхронизируем статус обсуждения с задачей + фильтруем архив чатов
    prepared_chats = []
    for chat in user_chats:
        chat_copy = dict(chat)
        todo_id = chat_copy.get('todo_id') or chat_copy.get('todoId')

        auto_archived_by_task = False
        if todo_id:
            task = tasks_by_id.get(str(todo_id))
            if task:
                task_status = task.get('status') or ('review' if task.get('is_completed') or task.get('completed') else 'pending')
                discussion_status = chat_copy.get('discussion_status') or chat_copy.get('discussionStatus')

                if discussion_status != task_status:
                    try:
                        db.update_chat(chat_copy.get('id'), {'discussion_status': task_status})
                    except Exception as sync_err:
                        logger.warning("[GET /api/chats] failed to sync discussion status for chat %s: %s", chat_copy.get("id"), sync_err)

                chat_copy['discussion_status'] = task_status
                chat_copy['todo_status'] = task_status
                auto_archived_by_task = bool(
                    task.get('archived')
                    or task.get('completed')
                    or task.get('is_completed')
                    or str(task_status).strip().lower() == 'completed'
                )

        archived_by_user_map = chat_copy.get('archived_by_user') or chat_copy.get('archivedByUser') or {}
        archived_by_user = get_bool_from_map(archived_by_user_map, user_id)
        is_archived_for_user = archived_by_user or auto_archived_by_task
        chat_copy['is_archived_for_user'] = is_archived_for_user

        if not include_archived and is_archived_for_user:
            continue

        prepared_chats.append(chat_copy)

    user_chats = prepared_chats

    # ------------------------------------------------------------------ #
    # Bulk-загрузка: последнее сообщение + счётчик непрочитанных           #
    # Два SQL-запроса на ВСЕ чаты вместо N отдельных SELECT на каждый чат  #
    # ------------------------------------------------------------------ #
    chat_ids = [str(c['id']) for c in user_chats]

    last_messages = db.get_last_messages_bulk(chat_ids) if hasattr(db, 'get_last_messages_bulk') else {}

    # Собираем read-маркеры {chat_id: message_id} для текущего пользователя
    read_markers: dict = {}
    for chat in user_chats:
        read_map = chat.get('read_messages_by_user') or chat.get('readMessagesByUser') or {}
        marker = read_map.get(user_id) or read_map.get(str(user_id))
        if marker:
            read_markers[str(chat['id'])] = str(marker)

    # Системные чаты (notifications, favorites) — unreadCount считается иначе,
    # для остальных делаем bulk-запрос
    non_system_ids = [
        str(c['id']) for c in user_chats
        if not (c.get('is_favorites_chat') or str(c.get('id', '')).startswith('favorites_'))
    ]
    unread_counts = db.get_unread_counts_bulk(non_system_ids, user_id, read_markers) \
        if hasattr(db, 'get_unread_counts_bulk') else {}

    for chat in user_chats:
        cid = str(chat['id'])
        last_msg = last_messages.get(cid)
        if last_msg:
            chat['lastMessage'] = last_msg

        is_favorites = bool(chat.get('is_favorites_chat')) or cid.startswith('favorites_')
        if is_favorites:
            chat['unreadCount'] = 0
        else:
            chat['unreadCount'] = unread_counts.get(cid, 0)
    
    # Функция для безопасного извлечения времени создания для сортировки
    def get_sort_time(chat):
        created_at = chat.get('lastMessage', {}).get('created_at', '')
        if isinstance(created_at, datetime):
            return created_at
        elif isinstance(created_at, str) and created_at:
            try:
                return datetime.fromisoformat(created_at.replace('Z', '+00:00'))
            except:
                return datetime.min
        return datetime.min
    
    # Сортируем по последнему сообщению
    user_chats.sort(key=get_sort_time, reverse=True)
    
    # Преобразуем snake_case → camelCase для frontend
    result = [snake_to_camel(chat) for chat in user_chats]
    return result


@router.post("/api/chats")
def create_chat(chat_data: ChatCreate, me: Identity = Depends(current_identity)):
    """Создать новый чат. Создатель — всегда вошедший; он же обязательно среди участников."""
    chat_data.creatorId = me.user_id
    chat_data.participantIds = list(dict.fromkeys([str(p) for p in chat_data.participantIds] + [me.user_id]))
    if not chat_data.isGroup and len(chat_data.participantIds) > 2:
        raise HTTPException(status_code=400, detail="Личный чат — ровно два участника")

    def sync_todo_chat_id(todo_id: Optional[str], chat_id: str):
        if not todo_id or not chat_id:
            return
        try:
            task = db.get_task(todo_id)
            if not task:
                return
            metadata = task.get('metadata') if isinstance(task.get('metadata'), dict) else {}
            if metadata.get('chatId') == chat_id or metadata.get('chat_id') == chat_id:
                return
            merged_metadata = {**metadata, 'chatId': chat_id}
            db.update_task(todo_id, {'metadata': merged_metadata})
        except Exception as sync_err:
            logger.warning("[POST /api/chats] failed to sync todo chatId for task %s: %s", todo_id, sync_err)
    
    # Проверяем, не существует ли уже личный чат с этими участниками
    if not chat_data.isGroup and len(chat_data.participantIds) == 2:
        existing_chat = db.find_private_chat(chat_data.participantIds[0], chat_data.participantIds[1])
        if existing_chat:
            if chat_data.todoId:
                sync_todo_chat_id(chat_data.todoId, existing_chat.get('id'))
            return snake_to_camel(existing_chat)
    
    # Если указан todoId, проверяем существование чата для этой задачи
    if chat_data.todoId:
        existing_chat = db.find_chat_by_todo(chat_data.todoId)
        if existing_chat:
            sync_todo_chat_id(chat_data.todoId, existing_chat.get('id'))
            return snake_to_camel(existing_chat)
    
    new_chat = {
        "id": str(uuid.uuid4()),
        "title": chat_data.title,
        "is_group": chat_data.isGroup,
        "participant_ids": chat_data.participantIds,
        "created_at": datetime.now().isoformat(),
        "read_messages_by_user": {}
    }
    
    # Добавляем creatorId для групповых чатов
    if chat_data.isGroup and chat_data.creatorId:
        new_chat["creator_id"] = chat_data.creatorId
    
    # Добавляем todoId если указан
    if chat_data.todoId:
        new_chat["todo_id"] = chat_data.todoId
    
    result = db.create_chat(new_chat)

    if chat_data.todoId and result and result.get('id'):
        sync_todo_chat_id(chat_data.todoId, result.get('id'))

    # For group chats: send system invite message and push SSE to all participants
    if chat_data.isGroup and result and result.get('id'):
        created_chat_id = result['id']
        creator_name = 'Неизвестно'
        if chat_data.creatorId:
            try:
                creator_user = db.get_user_by_id(chat_data.creatorId)
                if creator_user:
                    creator_name = creator_user.get('name') or creator_user.get('username') or 'Неизвестно'
            except Exception:
                pass
        # Request chats post their own tailored system notice (with number/date/
        # department) from the client right after creation — skip the generic
        # "Группа … создана" invite for them so it doesn't show first.
        if not chat_data.isRequest:
            invite_msg = {
                'id': str(uuid.uuid4()),
                'chat_id': created_chat_id,
                'author_id': chat_data.creatorId or 'system',
                'author_name': creator_name,
                'content': f'Группа «{chat_data.title}» создана. Вас пригласил {creator_name}.',
                'is_system_message': True,
                'metadata': {'systemEvent': 'group_created'},
                'created_at': datetime.now(timezone.utc).isoformat(),
            }
            try:
                if db.add_message(invite_msg):
                    db.update_chat(created_chat_id, {
                        'last_message_id': invite_msg['id'],
                        'updated_at': invite_msg['created_at'],
                    })
                    _invalidate_chat_cache(created_chat_id)
                else:
                    # Don't point last_message_id at a message that was never actually
                    # written — add_message returns None (rather than raising) on failure.
                    logger.warning("[create_chat] failed to persist invite message for chat %s", created_chat_id)
            except Exception as e:
                logger.warning("[create_chat] failed to add invite message: %s", e)
        # SSE: notify all participants so their chat list updates immediately
        try:
            fresh_chat = db.get_chat(created_chat_id)
            if fresh_chat:
                sse_manager.push_to_chat(fresh_chat, '', {
                    'type': 'chat_created',
                    'chatId': created_chat_id,
                    'chat': snake_to_camel(fresh_chat),
                })
        except Exception as e:
            logger.warning("[create_chat] SSE push failed: %s", e)

    return snake_to_camel(result)


@router.get("/api/chats/{chat_id}")
def get_chat(chat_id: str, me: Identity = Depends(current_identity)):
    """Получить информацию о чате"""
    chat = require_member(chat_id, me, allow_missing_own=False)
    return snake_to_camel(db.get_chat(chat_id) or chat)


@router.put("/api/chats/{chat_id}")
def update_chat(chat_id: str, update_data: dict = Body(...), me: Identity = Depends(current_identity)):
    """Обновить данные чата (title, avatar, статус обсуждения).

    Личные маркеры (прочитано, закреплено, архив, без звука) отсюда менять нельзя —
    для них есть отдельные маршруты: раньше любой участник мог перезаписать их у всех."""
    chat = require_member(chat_id, me, allow_missing_own=False)
    group = bool(chat.get('is_group') or chat.get('isGroup'))
    if group and any(k in update_data for k in ('title', 'avatar')) and not (is_creator(chat, me) or me.is_admin):
        raise HTTPException(status_code=403, detail="Название и аватар группы меняет её создатель")

    allowed_fields = {
        'title',
        'avatar',
        'discussionStatus',
        'discussion_status',
    }

    normalized = {k: v for k, v in update_data.items() if k in allowed_fields}
    if not normalized:
        raise HTTPException(status_code=400, detail="No valid fields provided")

    normalized['updated_at'] = datetime.now().isoformat()
    updated_chat = db.update_chat(chat_id, normalized)
    if not updated_chat:
        raise HTTPException(status_code=500, detail="Failed to update chat")

    return snake_to_camel(updated_chat)


@router.delete("/api/chats/{chat_id}")
def delete_chat(chat_id: str, me: Identity = Depends(current_identity)):
    """Удалить чат и все его сообщения: группу — её создатель (или админ), личный чат — участник."""
    chat = require_member(chat_id, me, allow_missing_own=False)
    if chat.get('is_system_chat') or chat.get('is_favorites_chat') or chat.get('is_notifications_chat'):
        raise HTTPException(status_code=400, detail="Служебные чаты удалить нельзя")
    if (chat.get('is_group') or chat.get('isGroup')) and not (is_creator(chat, me) or me.is_admin):
        raise HTTPException(status_code=403, detail="Группу удаляет её создатель")

    # Синхронная архивация задачи при удалении связанного task-чата
    todo_id = chat.get('todo_id')
    if todo_id:
        try:
            task = db.get_task(todo_id)
            if task and not task.get('archived'):
                db.update_task(todo_id, {'archived': True})
                logger.info("[DELETE /api/chats/%s] archived linked task %s", chat_id, todo_id)
        except Exception as task_err:
            logger.warning("[DELETE /api/chats/%s] failed to archive linked task %s: %s", chat_id, todo_id, task_err)
    
    # Удаляем чат (CASCADE удалит сообщения и участников)
    db.delete_chat(chat_id)
    
    return {"success": True}


@router.post("/api/chats/{chat_id}/archive")
def archive_chat(chat_id: str, data_payload: dict = Body(...), me: Identity = Depends(current_identity)):
    """Архивировать/разархивировать чат для вошедшего пользователя"""
    user_id = me.user_id
    raw_is_archived = data_payload.get('isArchived', True)

    if isinstance(raw_is_archived, str):
        is_archived = raw_is_archived.strip().lower() in ('1', 'true', 'yes', 'on')
    else:
        is_archived = bool(raw_is_archived)

    chat = require_member(chat_id, me, allow_missing_own=False)

    is_system_chat = bool(
        chat.get('is_system_chat')
        or chat.get('isSystemChat')
        or chat.get('is_notifications_chat')
        or chat.get('isNotificationsChat')
        or chat.get('is_favorites_chat')
        or chat.get('isFavoritesChat')
    )
    if is_system_chat:
        raise HTTPException(status_code=400, detail="System chats cannot be archived")

    archived_by_user = chat.get('archived_by_user') or chat.get('archivedByUser') or {}
    if not isinstance(archived_by_user, dict):
        archived_by_user = {}

    archived_by_user[user_id] = is_archived

    updated = db.merge_user_map(chat_id, 'archived_by_user', user_id, is_archived)
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to update chat archive state")

    return {
        "success": True,
        "chatId": chat_id,
        "userId": user_id,
        "isArchived": is_archived,
        "archivedByUser": archived_by_user,
    }


@router.post("/api/chats/{chat_id}/mute")
def mute_chat(chat_id: str, data_payload: dict = Body(...), me: Identity = Depends(current_identity)):
    """Включить/выключить уведомления чата для вошедшего пользователя."""
    user_id = me.user_id
    is_muted = bool(data_payload.get('muted', True))

    require_member(chat_id, me, allow_missing_own=False)
    chat = db.get_chat(chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")

    muted_by_user = chat.get('muted_by_user') or chat.get('mutedByUser') or {}
    if not isinstance(muted_by_user, dict):
        muted_by_user = {}

    if is_muted:
        muted_by_user[user_id] = True
    else:
        muted_by_user.pop(user_id, None)

    updated = db.merge_user_map(chat_id, 'muted_by_user', user_id, True, remove=not is_muted)
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to update mute state")

    return {
        "success": True,
        "chatId": chat_id,
        "userId": user_id,
        "muted": is_muted,
        "mutedByUser": muted_by_user,
    }


@router.post("/api/chats/{chat_id}/pin")
def pin_chat(chat_id: str, data_payload: dict, me: Identity = Depends(current_identity)):
    """Закрепить/открепить чат для вошедшего пользователя"""
    user_id = me.user_id
    require_member(chat_id, me)
    raw_is_pinned = data_payload.get('isPinned', True)
    raw_pin_order = data_payload.get('pinOrder')
    if isinstance(raw_is_pinned, str):
        is_pinned = raw_is_pinned.strip().lower() in ('1', 'true', 'yes', 'on')
    else:
        is_pinned = bool(raw_is_pinned)

    pin_order: Optional[int] = None
    if raw_pin_order is not None:
        try:
            pin_order = int(raw_pin_order)
        except (TypeError, ValueError):
            pin_order = None
    
    chat = db.get_chat(chat_id)
    if not chat and str(chat_id).startswith('favorites_'):
        favorites_user_id = str(user_id)
        new_chat = {
            "id": chat_id,
            "title": "Избранное",
            "is_group": False,
            "is_favorites_chat": True,
            "participant_ids": [favorites_user_id],
            "creator_id": favorites_user_id,
            "created_at": datetime.now().isoformat(),
            "read_messages_by_user": {},
            "pinned_by_user": {str(user_id): True},
            "pinned_order_by_user": {str(user_id): pin_order if pin_order is not None else 0},
        }
        chat = db.create_chat(new_chat)

    if not chat and str(chat_id).startswith('notifications-'):
        notifications_user_id = str(user_id)
        new_chat = {
            "id": chat_id,
            "title": "Уведомления",
            "is_group": False,
            "is_notifications_chat": True,
            "is_system_chat": True,
            "participant_ids": [notifications_user_id],
            "creator_id": notifications_user_id,
            "created_at": datetime.now().isoformat(),
            "read_messages_by_user": {},
            "pinned_by_user": {str(user_id): True},
            "pinned_order_by_user": {str(user_id): pin_order if pin_order is not None else 0},
        }
        chat = db.create_chat(new_chat)

    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")

    pinned_by_user = chat.get('pinned_by_user')
    if pinned_by_user is None:
        pinned_by_user = chat.get('pinnedByUser')
    if not isinstance(pinned_by_user, dict):
        pinned_by_user = {}

    pinned_order_by_user = chat.get('pinned_order_by_user')
    if pinned_order_by_user is None:
        pinned_order_by_user = chat.get('pinnedOrderByUser')
    if not isinstance(pinned_order_by_user, dict):
        pinned_order_by_user = {}

    pinned_by_user[user_id] = is_pinned

    if is_pinned:
        if pin_order is None:
            existing_orders: List[int] = []
            for value in pinned_order_by_user.values():
                try:
                    existing_orders.append(int(value))
                except (TypeError, ValueError):
                    continue
            pin_order = (max(existing_orders) + 1) if existing_orders else 0
        pinned_order_by_user[user_id] = pin_order
    else:
        pinned_order_by_user.pop(user_id, None)

    if is_pinned:
        db.merge_user_map(chat_id, 'pinned_order_by_user', user_id, pin_order)
        updated = db.merge_user_map(chat_id, 'pinned_by_user', user_id, True)
    else:
        db.merge_user_map(chat_id, 'pinned_order_by_user', user_id, remove=True)
        updated = db.merge_user_map(chat_id, 'pinned_by_user', user_id, False)
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to update chat pin state")
    
    return {"success": True, "isPinned": is_pinned, "pinOrder": pin_order if is_pinned else None}
