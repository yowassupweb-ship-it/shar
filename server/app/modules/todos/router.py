from __future__ import annotations

import logging
import time as _time
import uuid
from typing import Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.helpers import _ru_when, _truthy
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity
from app.modules.calendar.router import _roll_recurring_calendar_events
from app.modules.chats.chat_notifications import send_notification_message

router = APIRouter()

logger = logging.getLogger(__name__)


def _roll_recurring_tasks() -> None:
    """Advance recurring task-series so exactly one future occurrence exists.

    get_todos called this by name, but it was never defined — so EVERY /api/todos
    request raised `NameError` and 500'd ("all tasks disappeared"). The real roller
    is _roll_recurring_calendar_events (materialises the next occurrence in the
    calendar); this simply delegates to it (throttled, never raises), so loading
    tasks also keeps recurring series rolled forward."""
    try:
        _roll_recurring_calendar_events()
    except Exception as e:
        logger.warning(f"[_roll_recurring_tasks] skipped: {e}")


def _involved(task: dict, uid: str) -> bool:
    ids = {str(x) for x in (task.get('assigned_to_ids') or task.get('assignedToIds') or []) if x}
    direct = {str(task.get(k)) for k in ('author_id', 'assigned_by_id', 'assigned_to_id', 'assigned_to') if task.get(k)}
    return uid in ids | direct


def _can_access_task(task: Optional[dict], me: Identity) -> bool:
    """Видит/правит задачу тот, кто в ней участвует; админ и «видящие все» — любую;
    руководитель отдела — задачи отдела (правило из db.get_tasks)."""
    if not task:
        return False
    if me.is_admin or _involved(task, me.user_id):
        return True
    row = db.get_user_by_id(me.user_id) or {}
    if row.get('can_see_all_tasks'):
        return True
    if row.get('is_department_head'):
        return any(str(t.get('id')) == str(task.get('id')) for t in db.get_tasks(user_id=me.user_id))
    return False


def _owned_task_or_403(task_id: str, me: Identity) -> dict:
    task = db.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not _can_access_task(task, me):
        raise HTTPException(status_code=403, detail="Нет доступа к задаче")
    return task


def _list_owner_or_403(list_id: str, me: Identity) -> None:
    item = next((l for l in db.get_todo_lists(user_id=me.user_id) if str(l.get('id')) == str(list_id)), None)
    if not item:
        raise HTTPException(status_code=404, detail="List not found")
    if not (me.is_admin or str(item.get('creator_id') or '') == me.user_id):
        raise HTTPException(status_code=403, detail="Список меняет его создатель")


@router.get("/api/todos")
def get_todos(userId: Optional[str] = None, taskId: Optional[str] = None, me: Identity = Depends(current_identity)):
    """Получить список задач"""
    logger.debug(f"[GET /api/todos] userId={userId}, taskId={taskId}")
    stage_keys = {
        'stagesEnabled',
        'technicalSpecTabs',
        'stageMeta',
        'stageDefaultAssigneeId',
        'stageDefaultAssigneeName',
        'recurrence',
        'versionHistory',
        'delegatedById',
        'delegatedBy',
        'chatId'
    }

    def hydrate_task(task: dict):
        data = snake_to_camel(task)
        metadata = data.get('metadata') or {}
        if isinstance(metadata, dict):
            for key in stage_keys:
                if key in metadata:
                    data[key] = metadata[key]
        return data

    # Если запрошена конкретная задача по ID — возвращаем только её (без фильтра по пользователю)
    if taskId:
        return {"todos": [hydrate_task(_owned_task_or_403(taskId, me))], "lists": [], "categories": []}

    # Повторяющиеся задачи докатываем до «есть ровно один будущий срок».
    _roll_recurring_tasks()

    # Видимость считается от вошедшего. Раньше запрос без userId отдавал ВСЕ задачи компании.
    uid = me.user_id
    todos = db.get_tasks(user_id=uid)
    lists = db.get_todo_lists(user_id=uid)
    categories = db.get_todo_categories()
    
    logger.debug(f"[GET /api/todos] Найдено списков: {len(lists)}, задач: {len(todos)}, категорий: {len(categories)}")
    if len(lists) == 0:
        logger.debug("[GET /api/todos] user %s has no accessible lists", uid)
    # Преобразуем snake_case в camelCase
    todos = [hydrate_task(todo) for todo in todos]
    lists = [snake_to_camel(list_item) for list_item in lists]
    categories = [snake_to_camel(cat) for cat in categories]
    
    return {
        "todos": todos,
        "lists": lists,
        "categories": categories
    }


def _push_task_sse(task: dict, event: str = 'task_updated') -> None:
    """Push SSE event to all users related to a task (assignees, creator, delegator)."""
    if not task:
        return
    recipients: set = set()
    for key in ('assigned_to_id', 'assigned_by_id', 'delegated_by_id'):
        uid = task.get(key) or task.get(snake_to_camel(key) if '_' in key else key)
        if uid:
            recipients.add(str(uid))
    for uid in (task.get('assigned_to_ids') or []):
        if uid:
            recipients.add(str(uid))
    payload = {
        'type': event,
        'taskId': task.get('id'),
        'task': snake_to_camel(task),
    }
    for uid in recipients:
        try:
            sse_manager.push(uid, payload)
        except Exception:
            pass


_TASK_STATUS_RU = {
    'in-progress': 'в работе', 'pending': 'в ожидании', 'todo': 'в ожидании', 'review': 'на проверке',
    'stuck': 'застряла', 'cancelled': 'отменена', 'completed': 'выполнена', 'done': 'выполнена',
}


_task_notified: Dict[str, float] = {}


def _task_field(t: Optional[dict], *keys: str):
    for k in keys:
        if t and t.get(k) not in (None, ''):
            return t.get(k)
    return None


def _task_assignees(t: Optional[dict]) -> set:
    out = set()
    ids = _task_field(t, 'assigned_to_ids', 'assignedToIds') or []
    if isinstance(ids, (list, tuple)):
        out.update(str(i) for i in ids if i)
    single = _task_field(t, 'assigned_to_id', 'assignedToId', 'assigned_to')
    if single:
        out.add(str(single))
    return out


def _task_status(t: Optional[dict]) -> str:
    if not t:
        return ''
    if _truthy(_task_field(t, 'is_completed', 'isCompleted', 'completed')):
        return 'completed'
    return str(_task_field(t, 'status') or 'pending')


def _task_due_text(t: dict) -> str:
    due = _task_field(t, 'due_date', 'dueDate')
    return f"\nСрок: {_ru_when(str(due)[:10] + 'T00:00:00', True)}" if due else ''


def _send_task_notice(uid: str, kind: str, task_id: str, text: str, actor: str) -> None:
    # Один и тот же факт дважды за минуту (двойной клик, повтор запроса) — одно уведомление.
    key = f"{uid}|{kind}|{task_id}|{text}"
    now = _time.monotonic()
    if now - _task_notified.get(key, -1e9) < 60:
        return
    _task_notified[key] = now
    if len(_task_notified) > 5000:
        for k in [k for k, v in _task_notified.items() if now - v > 600]:
            _task_notified.pop(k, None)
    try:
        send_notification_message(uid, {
            "content": text,
            "notificationType": kind,
            "linkedTaskId": task_id,
            "fromUserId": actor or None,
            "metadata": {"linkedTaskId": task_id},
        })
    except Exception as e:
        logger.debug(f"[tasks] notify {uid} failed: {e}")


def _notify_task_change(before: Optional[dict], after: Optional[dict], actor: str) -> None:
    """Новые исполнители — «новая задача»; смена статуса — автору, постановщику и
    остальным исполнителям. Тому, кто сделал изменение, — ничего."""
    if not after:
        return
    try:
        task_id = str(_task_field(after, 'id') or '')
        title = str(_task_field(after, 'title') or 'Задача').strip() or 'Задача'
        actor_name = ((db.get_user(actor) or {}).get('name') if actor else None) or 'Коллега'
        added = _task_assignees(after) - _task_assignees(before) - {actor, ''}
        for uid in added:
            _send_task_notice(uid, 'new_task', task_id, f"📋 {actor_name} поручил(а) задачу\n{title}{_task_due_text(after)}", actor)
        if before is not None:
            st_before, st_after = _task_status(before), _task_status(after)
            if st_after != st_before:
                watchers = set(_task_assignees(after))
                for key in ('author_id', 'authorId', 'assigned_by_id', 'assignedById'):
                    v = _task_field(after, key)
                    if v:
                        watchers.add(str(v))
                watchers -= {actor, ''}
                watchers -= added
                icon = '✅' if st_after == 'completed' else '🔄'
                text = f"{icon} {actor_name}: «{title}» — {_TASK_STATUS_RU.get(st_after, st_after)}"
                for uid in watchers:
                    _send_task_notice(uid, 'task_status_changed', task_id, text, actor)
    except Exception as e:
        logger.debug(f"[tasks] notify change failed: {e}")


@router.post("/api/todos")
def create_todo(request: Request, todo_data: dict = Body(...), me: Identity = Depends(current_identity)):
    """Создать новую задачу, список или категорию"""
    
    logger.debug("[POST /api/todos] === START ===")
    logger.debug(f"[POST /api/todos] Received data keys: {list(todo_data.keys())}")
    logger.debug(f"[POST /api/todos] Full data: {todo_data}")
    todo_type = todo_data.get('type', 'todo')
    logger.debug(f"[POST /api/todos] Type: {todo_type}")
    if todo_type == 'list':
        allowed_users = todo_data.get('allowedUsers', todo_data.get('allowed_users', [])) or []
        allowed_departments = todo_data.get('allowedDepartments', todo_data.get('allowed_departments', [])) or []
        new_list = {
            'id': str(uuid.uuid4()),
            'name': todo_data.get('name', 'Новый список'),
            'color': todo_data.get('color', '#3b82f6'),
            'icon': todo_data.get('icon', 'folder'),
            'department': todo_data.get('department'),
            'order': todo_data.get('order', 0),
            'creatorId': me.user_id,
            'defaultExecutorId': todo_data.get('defaultExecutorId') or todo_data.get('default_executor_id') or todo_data.get('defaultAssigneeId'),
            'defaultCustomerId': todo_data.get('defaultCustomerId') or todo_data.get('default_customer_id'),
            'defaultAddToCalendar': todo_data.get('defaultAddToCalendar', todo_data.get('default_add_to_calendar', False)),
            'stagesEnabled': todo_data.get('stagesEnabled', todo_data.get('stages_enabled', False)),
            'allowedUsers': allowed_users,
            'allowedDepartments': allowed_departments,
        }
        logger.debug(f"[POST /api/todos] Creating list: {new_list['name']} by creator: {new_list.get('creatorId')}")
        result = db.add_todo_list(new_list)
        logger.debug(f"[POST /api/todos] List created: {result.get('id') if result else 'FAILED'}")
        if not result:
            raise HTTPException(status_code=500, detail="Failed to create list")
        return snake_to_camel(result)
    
    elif todo_type == 'category':
        if not me.is_admin:
            raise HTTPException(status_code=403, detail="Категории создаёт администратор")
        new_category = {
            'id': str(uuid.uuid4()),
            'name': todo_data.get('name', 'Новая категория'),
            'color': todo_data.get('color', '#6366f1'),
            'icon': todo_data.get('icon', 'tag'),
            'order': todo_data.get('order', 0)
        }
        logger.debug(f"[POST /api/todos] Creating category: {new_category['name']}")
        result = db.add_todo_category(new_category)
        logger.debug(f"[POST /api/todos] Category created: {result.get('id') if result else 'FAILED'}")
        if not result:
            raise HTTPException(status_code=500, detail="Failed to create category")
        return snake_to_camel(result)
    
    else:
        stage_keys = {
            'stagesEnabled',
            'technicalSpecTabs',
            'stageMeta',
            'stageDefaultAssigneeId',
            'stageDefaultAssigneeName',
            'recurrence',
            'reminderTime',
            'versionHistory',
            'delegatedById',
            'delegatedBy',
            'chatId'  # Добавляем chatId для индикатора обсуждения
        }
        metadata = todo_data.get('metadata') or {}
        if isinstance(metadata, dict):
            for key in stage_keys:
                if key in todo_data:
                    metadata[key] = todo_data.get(key)

        # Преобразуем camelCase в snake_case для БД
        new_todo = {
            'id': str(uuid.uuid4()),
            'title': todo_data.get('title', ''),
            'description': todo_data.get('description', ''),
            'status': todo_data.get('status', 'todo'),
            'review_comment': todo_data.get('reviewComment') or todo_data.get('review_comment'),
            'priority': todo_data.get('priority', 'medium'),
            'author_id': me.user_id,
            'assigned_to': todo_data.get('assignedTo') or todo_data.get('assigned_to'),
            'assigned_to_id': todo_data.get('assignedToId') or todo_data.get('assigned_to_id'),
            'assigned_to_ids': todo_data.get('assignedToIds', []) or todo_data.get('assigned_to_ids', []),
            'assigned_by_id': (todo_data.get('assignedById') or todo_data.get('assigned_by_id')) if me.is_admin else me.user_id,
            'due_date': todo_data.get('dueDate') or todo_data.get('due_date'),
            'list_id': todo_data.get('listId') or todo_data.get('list_id'),
            'category_id': todo_data.get('categoryId') or todo_data.get('category_id'),
            'tags': todo_data.get('tags', []),
            'is_completed': todo_data.get('isCompleted', False) or todo_data.get('is_completed', False),
            'calendar_event_id': todo_data.get('calendarEventId') or todo_data.get('calendar_event_id'),
            'calendar_list_id': todo_data.get('calendarListId') or todo_data.get('calendar_list_id'),
            'add_to_calendar': todo_data.get('addToCalendar', False) or todo_data.get('add_to_calendar', False),
            'task_order': todo_data.get('order', 0) or todo_data.get('task_order', 0),
            'metadata': metadata
        }
        
        logger.debug(f"[POST /api/todos] Creating task: {new_todo['title']}")
        logger.debug(f"[POST /api/todos] Task data: list_id={new_todo['list_id']}, assigned_to={new_todo['assigned_to']}")
        result = db.add_task(new_todo)
        
        if result:
            logger.debug(f"[POST /api/todos] Task created successfully: {result.get('id')}")
            logger.debug("[POST /api/todos] === SUCCESS ===")
            data = snake_to_camel(result)
            if isinstance(data.get('metadata'), dict):
                for key in stage_keys:
                    if key in data['metadata']:
                        data[key] = data['metadata'][key]
            # SSE: notify all assignees so they see the task instantly
            _push_task_sse(result, event='task_created')
            _notify_task_change(None, result, me.user_id)
            return data
        else:
            logger.debug("[POST /api/todos] ERROR: Failed to create task")
            logger.debug("[POST /api/todos] === FAILED ===")
            raise HTTPException(status_code=500, detail="Failed to create task")


@router.put("/api/todos")
def update_todo(request: Request, todo_data: dict = Body(...), me: Identity = Depends(current_identity)):
    """Обновить задачу, список или категорию"""
    todo_id = todo_data.get('id')
    todo_type = todo_data.get('type', 'todo')
    stage_keys = {
        'stagesEnabled',
        'technicalSpecTabs',
        'stageMeta',
            'stageDefaultAssigneeId',
            'stageDefaultAssigneeName',
            'recurrence',
            'reminderTime',
            'versionHistory',
            'delegatedById',
            'delegatedBy',
            'chatId'  # Добавляем chatId для индикатора обсуждения
    }
    
    logger.debug(f"[PUT /api/todos] Received update request for {todo_type} ID: {todo_id}")
    logger.debug(f"[PUT /api/todos] Update data keys: {list(todo_data.keys())}")
    if not todo_id:
        raise HTTPException(status_code=400, detail="ID is required")
    
    updates = {k: v for k, v in todo_data.items() if k not in ['id', 'type']}
    # Автора и постановщика задним числом не меняют (кроме админа).
    if not me.is_admin:
        for k in ('authorId', 'author_id', 'assignedById', 'assigned_by_id'):
            updates.pop(k, None)
    if todo_type == 'list':
        _list_owner_or_403(todo_id, me)
    elif todo_type == 'category':
        if not me.is_admin:
            raise HTTPException(status_code=403, detail="Категории меняет администратор")
    else:
        _owned_task_or_403(todo_id, me)
    logger.debug(f"[PUT /api/todos] Processing updates: {list(updates.keys())}")
    # Состояние до правки — чтобы сообщить только о настоящих изменениях.
    task_before = None
    if todo_type not in ('list', 'category'):
        try:
            task_before = db.get_task(todo_id)
        except Exception:
            task_before = None
    
    if todo_type == 'list':
        result = db.update_todo_list(todo_id, updates)

        # Fallback для прода с частично несовместимой схемой:
        # если обновление не прошло, пробуем только безопасные базовые поля.
        if not result:
            safe_keys = {'name', 'color', 'icon', 'department', 'order'}
            safe_updates = {k: v for k, v in updates.items() if k in safe_keys}
            if safe_updates:
                logger.debug(f"[PUT /api/todos] List update fallback with safe fields: {list(safe_updates.keys())}")
                result = db.update_todo_list(todo_id, safe_updates)
    elif todo_type == 'category':
        result = db.update_todo_category(todo_id, updates)
    else:
        if any(key in updates for key in stage_keys) or 'metadata' in updates:
            existing = db.get_task(todo_id)
            existing_metadata = existing.get('metadata') if existing else {}
            if not isinstance(existing_metadata, dict):
                existing_metadata = {}
            incoming_metadata = updates.get('metadata') or {}
            if not isinstance(incoming_metadata, dict):
                incoming_metadata = {}
            
            # Log existing metadata
            logger.debug(f"[PUT /api/todos] 📦 Existing metadata from DB: {existing_metadata}")
            logger.debug(f"[PUT /api/todos] 📦 Incoming metadata from client: {incoming_metadata}")
            # Log stageMeta before moving to metadata
            if 'stageMeta' in updates:
                logger.debug(f"[PUT /api/todos] 📊 stageMeta from client (root level): {updates.get('stageMeta')}")
            if 'technicalSpecTabs' in updates:
                logger.debug(f"[PUT /api/todos] 📋 technicalSpecTabs from client: {updates.get('technicalSpecTabs')}")
            for key in stage_keys:
                if key in updates:
                    value = updates.pop(key)
                    incoming_metadata[key] = value
                    logger.debug(f"[PUT /api/todos] 📌 Moved {key} to incoming_metadata: {value if key != 'stageMeta' else 'stageMeta object'}")
            merged_metadata = {**existing_metadata, **incoming_metadata}
            updates['metadata'] = merged_metadata
            
            logger.debug("[PUT /api/todos] 📦 Final merged metadata to save:")
            logger.debug(f"[PUT /api/todos]    stageMeta keys: {list(merged_metadata.get('stageMeta', {}).keys()) if merged_metadata.get('stageMeta') else 'None'}")
            logger.debug(f"[PUT /api/todos]    technicalSpecTabs: {merged_metadata.get('technicalSpecTabs')}")
        # Log assignedToIds specifically
        if 'assignedToIds' in updates or 'assigned_to_ids' in updates:
            logger.debug("[PUT /api/todos] 👥 Multiple executors update:")
            logger.debug(f"[PUT /api/todos]    assignedToIds: {updates.get('assignedToIds')}")
            logger.debug(f"[PUT /api/todos]    assigned_to_ids: {updates.get('assigned_to_ids')}")
        logger.debug(f"[PUT /api/todos] Calling db.update_task({todo_id}, {list(updates.keys())})")
        result = db.update_task(todo_id, updates)
        if result:
            logger.debug(f"[PUT /api/todos] Task updated successfully in DB: {result.get('id')}")
            logger.debug(f"[PUT /api/todos] 📦 metadata from DB: {result.get('metadata')}")
            if 'assigned_to_ids' in result:
                logger.debug(f"[PUT /api/todos] 👥 DB returned assigned_to_ids: {result.get('assigned_to_ids')}")
            try:
                linked_chat = db.find_chat_by_todo(todo_id)
                if linked_chat and linked_chat.get('id'):
                    task_status = result.get('status') or ('review' if result.get('is_completed') or result.get('completed') else 'pending')
                    db.update_chat(linked_chat['id'], {'discussion_status': task_status})
            except Exception as discussion_sync_error:
                logger.debug(f"[PUT /api/todos] ⚠️ Failed to sync discussion status for task {todo_id}: {discussion_sync_error}")
        else:
            logger.debug(f"[PUT /api/todos] ERROR: Task not found or update failed for ID: {todo_id}")
    if not result:
        logger.debug(f"[PUT /api/todos] 404 - {todo_type.capitalize()} not found")
        raise HTTPException(status_code=404, detail=f"{todo_type.capitalize()} not found")
    
    logger.debug("[PUT /api/todos] Returning successful response")
    data = snake_to_camel(result)
    metadata = data.get('metadata') or {}
    if isinstance(metadata, dict):
        for key in stage_keys:
            if key in metadata:
                data[key] = metadata[key]

    # SSE: push updated task to all assignees
    _push_task_sse(result, event='task_updated')
    if todo_type not in ('list', 'category') and task_before is not None:
        _notify_task_change(task_before, result, me.user_id)

    logger.debug(f"[PUT /api/todos] 📊 Final stageMeta in response: {data.get('stageMeta')}")
    return data


@router.delete("/api/todos")
def delete_todo(id: str, type: str = 'todo', me: Identity = Depends(current_identity)):
    """Удалить задачу (автор, постановщик, админ), список (создатель, админ) или категорию (админ)"""
    if not id:
        raise HTTPException(status_code=400, detail="ID is required")

    if type == 'list':
        _list_owner_or_403(id, me)
    elif type == 'category':
        if not me.is_admin:
            raise HTTPException(status_code=403, detail="Категории удаляет администратор")
    else:
        task = _owned_task_or_403(id, me)
        if not (me.is_admin or me.user_id in {str(task.get('author_id') or ''), str(task.get('assigned_by_id') or '')}):
            raise HTTPException(status_code=403, detail="Удалить задачу может её автор или постановщик")

    if type == 'list':
        success = db.delete_todo_list(id)
    elif type == 'category':
        success = db.delete_todo_category(id)
    else:
        success = db.delete_task(id)
    
    if not success:
        raise HTTPException(status_code=404, detail=f"{type.capitalize()} not found")
    
    return {"success": True}


@router.get("/api/todos/people")
def get_todo_people(me: Identity = Depends(current_identity)):
    """Получить список людей для назначения задач"""
    users = db.get_users()
    # Возвращаем все нужные поля из users для фронтенда
    people = []
    for user in users:
        person = {
            'id': user.get('id'),
            'username': user.get('username'),
            'name': user.get('name') or user.get('username'),  # fallback to username
            'telegramId': user.get('telegram_id'),
            'todoPersonId': user.get('todo_person_id'),
            'canSeeAllTasks': user.get('can_see_all_tasks', False),
            'role': user.get('todo_role') or 'universal',  # используем todo_role
            'lastSeen': user.get('last_seen'),
            'isOnline': user.get('is_online', False)
        }
        people.append(person)
    return {"people": people}
