from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.core.db.connection import Json

logger = logging.getLogger("shar.db")


class TasksRepo:
    """Запросы области «tasks». Требует self.conn (PostgresConnection)."""

    # ==================== TASKS (TODOS) ====================
    def get_tasks(self, user_id: Optional[str] = None, list_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get all tasks, optionally filtered by user or list"""
        if user_id:
            # Проверяем права пользователя
            user_query = "SELECT can_see_all_tasks, is_department_head, department, role FROM users WHERE id = %s"
            user_result = self.conn.fetch_one(user_query, (user_id,))
            can_see_all = user_result and user_result.get('can_see_all_tasks', False)
            is_admin = user_result and user_result.get('role') == 'admin'
            is_dept_head = user_result and user_result.get('is_department_head', False)
            user_dept = user_result.get('department') if user_result else None
            
            if can_see_all or is_admin:
                # Пользователь видит все задачи
                query = "SELECT * FROM tasks ORDER BY created_at DESC"
                return self.conn.fetch_all(query)
            elif is_dept_head and user_dept:
                # Руководитель отдела видит все задачи участников своего отдела
                dept_users_query = "SELECT id, name FROM users WHERE department = %s"
                dept_users = self.conn.fetch_all(dept_users_query, (user_dept,))
                dept_user_ids = [u['id'] for u in dept_users]
                dept_user_names = [u['name'] for u in dept_users if u.get('name')]

                if not dept_user_ids:
                    query = "SELECT * FROM tasks WHERE assigned_by_id = %s OR author_id = %s ORDER BY created_at DESC"
                    return self.conn.fetch_all(query, (user_id, user_id))

                placeholders_ids = ','.join(['%s'] * len(dept_user_ids))
                placeholders_names = ','.join(['%s'] * len(dept_user_names)) if dept_user_names else '%s'

                assigned_to_ids_checks = []
                assigned_to_ids_params = []
                for uid in dept_user_ids:
                    assigned_to_ids_checks.append("assigned_to_ids::jsonb @> %s::jsonb")
                    assigned_to_ids_params.append(f'["{uid}"]')

                query = f"""
                    SELECT * FROM tasks
                    WHERE assigned_by_id IN ({placeholders_ids})
                    OR author_id IN ({placeholders_ids})
                    OR assigned_to IN ({placeholders_names})
                    OR ({' OR '.join(assigned_to_ids_checks)})
                    ORDER BY created_at DESC
                """

                names_params = dept_user_names if dept_user_names else ['']
                params = tuple(dept_user_ids + dept_user_ids + names_params + assigned_to_ids_params)
                return self.conn.fetch_all(query, params)
            else:
                # Фильтруем только по связанным задачам (заказчик или исполнитель)
                query = """
                    SELECT * FROM tasks 
                    WHERE assigned_by_id = %s 
                    OR assigned_to = %s
                    OR assigned_to_ids::jsonb @> %s::jsonb
                    ORDER BY created_at DESC
                """
                return self.conn.fetch_all(query, (user_id, user_id, f'["{user_id}"]'))
        elif list_id:
            query = "SELECT * FROM tasks WHERE list_id = %s ORDER BY task_order, created_at DESC"
            return self.conn.fetch_all(query, (list_id,))
        else:
            query = "SELECT * FROM tasks ORDER BY created_at DESC"
            return self.conn.fetch_all(query)

    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Get single task"""
        query = "SELECT * FROM tasks WHERE id = %s"
        result = self.conn.fetch_one(query, (task_id,))
        return dict(result) if result else None

    def get_tasks_by_ids(self, task_ids: List[str]) -> Dict[str, Dict[str, Any]]:
        """Bulk-fetch tasks by IDs. Returns {task_id: task_dict}."""
        if not task_ids:
            return {}
        placeholders = ','.join(['%s'] * len(task_ids))
        query = f"SELECT * FROM tasks WHERE id IN ({placeholders})"
        rows = self.conn.fetch_all(query, tuple(task_ids))
        return {str(row['id']): dict(row) for row in rows}

    def add_task(self, task: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Add new task"""
        query = """
            INSERT INTO tasks 
            (id, title, description, status, review_comment, priority, due_date, assigned_to, assigned_to_ids, 
             author_id, assigned_by_id, list_id, category_id, tags, is_completed, add_to_calendar, calendar_event_id, calendar_list_id, task_order, metadata)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """
        params = (
            task.get('id'),
            task.get('title'),
            task.get('description'),
            task.get('status', 'pending'),
            task.get('review_comment') or task.get('reviewComment'),
            task.get('priority', 'medium'),
            task.get('due_date'),  # snake_case
            task.get('assigned_to'),  # snake_case
            Json(task.get('assigned_to_ids', [])),  # snake_case
            task.get('author_id'),  # snake_case
            task.get('assigned_by_id'),  # snake_case
            task.get('list_id'),  # snake_case
            task.get('category_id'),  # snake_case
            Json(task.get('tags', [])),
            task.get('is_completed', False),  # snake_case
            task.get('add_to_calendar', False),  # snake_case
            task.get('calendar_event_id'),  # snake_case
            task.get('calendar_list_id'),  # snake_case
            task.get('task_order', 0),  # snake_case
            Json(task.get('metadata', {}))
        )
        result = self.conn.fetch_one(query, params)
        return dict(result) if result else None

    def update_task(self, task_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update task"""
        # Поддержка и camelCase и snake_case
        field_map = {
            'title': 'title',
            'description': 'description',
            'assigneeResponse': 'assignee_response',
            'assignee_response': 'assignee_response',
            'status': 'status',
            'reviewComment': 'review_comment',
            'review_comment': 'review_comment',
            'priority': 'priority',
            'dueDate': 'due_date',
            'due_date': 'due_date',
            'assignedTo': 'assigned_to',
            'assigned_to': 'assigned_to',
            'assignedToIds': 'assigned_to_ids',
            'assigned_to_ids': 'assigned_to_ids',
            'authorId': 'author_id',
            'author_id': 'author_id',
            'assignedById': 'assigned_by_id',
            'assigned_by_id': 'assigned_by_id',
            'listId': 'list_id',
            'list_id': 'list_id',
            'categoryId': 'category_id',
            'category_id': 'category_id',
            'tags': 'tags',
            'completed': 'is_completed',
            'isCompleted': 'is_completed',
            'is_completed': 'is_completed',
            'addToCalendar': 'add_to_calendar',
            'add_to_calendar': 'add_to_calendar',
            'calendarEventId': 'calendar_event_id',
            'calendar_event_id': 'calendar_event_id',
            'calendarListId': 'calendar_list_id',
            'calendar_list_id': 'calendar_list_id',
            'order': 'task_order',
            'task_order': 'task_order',
            'taskOrder': 'task_order',
            'archived': 'archived',
            'isArchived': 'archived',
            'metadata': 'metadata'
        }
        
        # Логирование для assigned_to_ids
        if 'assignedToIds' in updates or 'assigned_to_ids' in updates:
            logger.debug(f"[DB] 👥 Updating assigned_to_ids for task {task_id}")
            logger.debug(f"[DB]    Input assignedToIds: {updates.get('assignedToIds')}")
            logger.debug(f"[DB]    Input assigned_to_ids: {updates.get('assigned_to_ids')}")
        
        # Собираем уникальные db_field -> value
        db_updates = {}
        for key, value in updates.items():
            if key in field_map:
                db_field = field_map[key]
                # Для JSONB полей применяем Json()
                if key in ['tags', 'assignedToIds', 'assigned_to_ids', 'metadata']:
                    db_updates[db_field] = Json(value)
                else:
                    db_updates[db_field] = value
        
        if not db_updates:
            return self.get_task(task_id)
        
        logger.debug(f"[DB] DB updates to apply: {list(db_updates.keys())}")
        if 'assigned_to_ids' in db_updates:
            logger.debug(f"[DB]    assigned_to_ids value: {db_updates['assigned_to_ids']}")
        
        # Формируем set_clauses и params из уникальных полей
        set_clauses = [f"{field} = %s" for field in db_updates.keys()]
        params = list(db_updates.values())
        
        set_clauses.append("updated_at = NOW()")
        params.append(task_id)
        
        query = f"UPDATE tasks SET {', '.join(set_clauses)} WHERE id = %s RETURNING *"
        result = self.conn.fetch_one(query, tuple(params))
        
        if result and 'assigned_to_ids' in dict(result):
            logger.debug(f"[DB] ✅ Task {task_id} updated with assigned_to_ids: {dict(result)['assigned_to_ids']}")
        
        return dict(result) if result else None

    def delete_task(self, task_id: str) -> bool:
        """Delete task"""
        query = "DELETE FROM tasks WHERE id = %s"
        return self.conn.execute_query(query, (task_id,))

    # ==================== TODO LISTS ====================
    def get_todo_lists(self, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get all todo lists, optionally filtered by user"""
        logger.debug(f"[get_todo_lists] Запрос списков для user_id={user_id}")
        
        if user_id:
            # Получаем информацию о пользователе
            user_query = "SELECT can_see_all_tasks, department, is_department_head, role, name FROM users WHERE id = %s"
            user_result = self.conn.fetch_one(user_query, (user_id,))
            
            if not user_result:
                logger.debug(f"[get_todo_lists] Пользователь {user_id} не найден!")
                return []
            
            can_see_all = user_result.get('can_see_all_tasks', False)
            is_admin = user_result.get('role') == 'admin'
            is_dept_head = user_result.get('is_department_head', False)
            user_dept = user_result.get('department')
            user_name = user_result.get('name')
            
            logger.debug(f"[get_todo_lists] Пользователь: {user_name}, can_see_all={can_see_all}, is_admin={is_admin}, dept={user_dept}")
            
            # Админы и пользователи с can_see_all_tasks видят все списки
            if is_admin or can_see_all:
                logger.debug("[get_todo_lists] Пользователь - админ или имеет can_see_all_tasks, возвращаем все списки")
                query = "SELECT * FROM todo_lists ORDER BY list_order, created_at"
                result = self.conn.fetch_all(query)
                logger.debug(f"[get_todo_lists] Найдено списков для админа: {len(result)}")
                return result
            
            # Начальники отдела видят списки своих подчиненных
            if is_dept_head and user_dept:
                logger.debug(f"[get_todo_lists] Пользователь - начальник отдела {user_dept}")
                # Получаем ID всех пользователей отдела
                dept_users_query = "SELECT id FROM users WHERE department = %s"
                dept_users = self.conn.fetch_all(dept_users_query, (user_dept,))
                dept_user_ids = [u['id'] for u in dept_users]
                logger.debug(f"[get_todo_lists] Сотрудников в отделе: {len(dept_user_ids)}")
                
                # Списки созданные сотрудниками отдела + списки с задачами где участвуют сотрудники отдела
                if dept_user_ids:
                    placeholders_creator = ','.join(['%s'] * len(dept_user_ids))
                    placeholders_assigned_by = ','.join(['%s'] * len(dept_user_ids))
                    placeholders_names = ','.join(['%s'] * len(dept_user_ids))
                    
                    # Для assigned_to_ids используем OR для каждого ID
                    assigned_to_checks = []
                    assigned_to_params = []
                    for uid in dept_user_ids:
                        assigned_to_checks.append("assigned_to_ids::jsonb @> %s::jsonb")
                        assigned_to_params.append(f'["{uid}"]')
                    
                    query = f"""
                        SELECT DISTINCT l.* FROM todo_lists l
                        WHERE l.creator_id IN ({placeholders_creator})
                        OR l.id IN (
                            SELECT DISTINCT list_id FROM tasks 
                            WHERE assigned_by_id IN ({placeholders_assigned_by})
                            OR assigned_to IN (SELECT name FROM users WHERE id IN ({placeholders_names}))
                            OR ({' OR '.join(assigned_to_checks)})
                        )
                        ORDER BY l.list_order, l.created_at
                    """
                    params = tuple(dept_user_ids + dept_user_ids + dept_user_ids + assigned_to_params)
                    result = self.conn.fetch_all(query, tuple(params))
                    logger.debug(f"[get_todo_lists] Найдено списков для начальника отдела: {len(result)}")
                    return result
            
            logger.debug("[get_todo_lists] Обычный пользователь без специальных прав")
            # Обычные пользователи видят списки где:
            # 1. Они создатели (даже если список пустой)
            # 2. Есть задачи где они участники
            # 3. Список публичный (allowed_users и allowed_departments пустые или NULL)
            # 4. Они в allowed_users
            # 5. Их отдел в allowed_departments
            query = """
                SELECT DISTINCT l.* FROM todo_lists l
                WHERE l.creator_id = %s
                OR l.id IN (
                    SELECT DISTINCT list_id FROM tasks
                    WHERE assigned_by_id = %s
                    OR assigned_to = %s
                    OR assigned_to_ids::jsonb @> %s::jsonb
                )
                OR (
                    (l.allowed_users IS NULL OR cardinality(l.allowed_users) = 0)
                    AND (l.allowed_departments IS NULL OR cardinality(l.allowed_departments) = 0)
                )
                OR (%s = ANY(l.allowed_users) OR %s = ANY(l.allowed_users))
                OR (
                    %s IS NOT NULL
                    AND l.allowed_departments IS NOT NULL
                    AND (
                        %s = ANY(l.allowed_departments)
                        OR EXISTS (
                            SELECT 1 FROM unnest(l.allowed_departments) AS ad
                            WHERE lower(replace(replace(ad, 'ё', 'е'), ' ', '_')) = lower(replace(replace(%s, 'ё', 'е'), ' ', '_'))
                        )
                    )
                )
                ORDER BY l.list_order, l.created_at
            """
            # Normalize-on-both-sides fallback for legacy allowed_departments entries saved
            # before the departments table existed (mixed raw-name / id formats).
            result = self.conn.fetch_all(query, (user_id, user_id, user_name, f'["{user_id}"]', user_id, user_name, user_dept, user_dept, user_dept))
            logger.debug(f"[get_todo_lists] Найдено списков для обычного пользователя: {len(result)}")
            if len(result) == 0:
                logger.debug(f"[get_todo_lists] WARNING: Проверьте права доступа для пользователя {user_id} ({user_name})")
            return result
        else:
            query = "SELECT * FROM todo_lists ORDER BY list_order, created_at"
            return self.conn.fetch_all(query)

    def add_todo_list(self, list_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Add new todo list"""
        # Сначала проверяем наличие обязательных колонок
        try:
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS creator_id VARCHAR(255)")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS default_executor_id VARCHAR(255)")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS default_customer_id VARCHAR(255)")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS default_add_to_calendar BOOLEAN DEFAULT FALSE")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS stages_enabled BOOLEAN DEFAULT FALSE")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS allowed_users TEXT[] DEFAULT ARRAY[]::TEXT[]")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS allowed_departments TEXT[] DEFAULT ARRAY[]::TEXT[]")
        except Exception as e:
            logger.warning(f"Error checking/adding todo_lists columns: {e}")
        
        query = """
            INSERT INTO todo_lists 
            (id, name, color, icon, department, list_order, creator_id, default_executor_id, default_customer_id, default_add_to_calendar, stages_enabled, allowed_users, allowed_departments)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """
        allowed_users = list_data.get('allowedUsers', list_data.get('allowed_users', [])) or []
        allowed_departments = list_data.get('allowedDepartments', list_data.get('allowed_departments', [])) or []
        params = (
            list_data.get('id'),
            list_data.get('name'),
            list_data.get('color', '#3b82f6'),
            list_data.get('icon'),
            list_data.get('department'),
            list_data.get('order', 0),
            list_data.get('creatorId') or list_data.get('creator_id'),
            list_data.get('defaultExecutorId') or list_data.get('default_executor_id') or list_data.get('defaultAssigneeId'),
            list_data.get('defaultCustomerId') or list_data.get('default_customer_id'),
            bool(list_data.get('defaultAddToCalendar') or list_data.get('default_add_to_calendar', False)),
            bool(list_data.get('stagesEnabled') or list_data.get('stages_enabled', False)),
            allowed_users,
            allowed_departments,
        )
        result = self.conn.fetch_one(query, params)
        if result:
            return dict(result)

        # Fallback для старой схемы БД (без новых колонок)
        fallback_query = """
            INSERT INTO todo_lists
            (id, name, color, icon, department, list_order, creator_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """
        fallback_params = (
            list_data.get('id'),
            list_data.get('name'),
            list_data.get('color', '#3b82f6'),
            list_data.get('icon'),
            list_data.get('department'),
            list_data.get('order', 0),
            list_data.get('creatorId') or list_data.get('creator_id'),
        )
        fallback_result = self.conn.fetch_one(fallback_query, fallback_params)
        return dict(fallback_result) if fallback_result else None

    def update_todo_list(self, list_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update todo list"""
        # На проде схема могла быть частично мигрирована.
        # Гарантируем наличие колонок перед UPDATE, чтобы не получать ложный 404
        # из-за SQL ошибки "column does not exist".
        try:
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS creator_id VARCHAR(255)")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS default_executor_id VARCHAR(255)")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS default_customer_id VARCHAR(255)")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS default_add_to_calendar BOOLEAN DEFAULT FALSE")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS stages_enabled BOOLEAN DEFAULT FALSE")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS allowed_users TEXT[] DEFAULT ARRAY[]::TEXT[]")
            self.conn.execute_query("ALTER TABLE todo_lists ADD COLUMN IF NOT EXISTS allowed_departments TEXT[] DEFAULT ARRAY[]::TEXT[]")
        except Exception as e:
            logger.warning(f"Error checking/adding todo_lists columns before update: {e}")

        set_clauses = []
        params = []
        
        field_mapping = {
            'name': 'name',
            'color': 'color',
            'icon': 'icon',
            'department': 'department',
            'order': 'list_order',
            'archived': 'archived',
            'defaultExecutorId': 'default_executor_id',
            'default_executor_id': 'default_executor_id',
            'defaultCustomerId': 'default_customer_id',
            'default_customer_id': 'default_customer_id',
            'defaultAddToCalendar': 'default_add_to_calendar',
            'default_add_to_calendar': 'default_add_to_calendar',
            'stagesEnabled': 'stages_enabled',
            'stages_enabled': 'stages_enabled',
            'allowedUsers': 'allowed_users',
            'allowed_users': 'allowed_users',
            'allowedDepartments': 'allowed_departments',
            'allowed_departments': 'allowed_departments',
        }
        
        for key, db_field in field_mapping.items():
            if key in updates:
                set_clauses.append(f"{db_field} = %s")
                params.append(updates[key])
        
        if not set_clauses:
            return None
        
        params.append(list_id)
        query = f"""
            UPDATE todo_lists 
            SET {', '.join(set_clauses)}, updated_at = CURRENT_TIMESTAMP
            WHERE id = %s
            RETURNING *
        """
        result = self.conn.fetch_one(query, tuple(params))
        return dict(result) if result else None

    def delete_todo_list(self, list_id: str) -> bool:
        """Delete todo list"""
        query = "DELETE FROM todo_lists WHERE id = %s"
        return self.conn.execute_query(query, (list_id,))

    # ==================== TODO CATEGORIES ====================
    def get_todo_categories(self) -> List[Dict[str, Any]]:
        """Get all todo categories"""
        query = "SELECT * FROM todo_categories ORDER BY category_order, created_at"
        return self.conn.fetch_all(query)

    def add_todo_category(self, category_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Add new todo category"""
        query = """
            INSERT INTO todo_categories 
            (id, name, color, icon, category_order)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING *
        """
        params = (
            category_data.get('id'),
            category_data.get('name'),
            category_data.get('color', '#6366f1'),
            category_data.get('icon'),
            category_data.get('order', 0)
        )
        result = self.conn.fetch_one(query, params)
        return dict(result) if result else None

    def update_todo_category(self, category_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update todo category"""
        set_clauses = []
        params = []
        
        field_mapping = {
            'name': 'name',
            'color': 'color',
            'icon': 'icon',
            'order': 'category_order'
        }
        
        for key, db_field in field_mapping.items():
            if key in updates:
                set_clauses.append(f"{db_field} = %s")
                params.append(updates[key])
        
        if not set_clauses:
            return None
        
        params.append(category_id)
        query = f"""
            UPDATE todo_categories 
            SET {', '.join(set_clauses)}, updated_at = CURRENT_TIMESTAMP
            WHERE id = %s
            RETURNING *
        """
        result = self.conn.fetch_one(query, tuple(params))
        return dict(result) if result else None

    def delete_todo_category(self, category_id: str) -> bool:
        """Delete todo category"""
        query = "DELETE FROM todo_categories WHERE id = %s"
        return self.conn.execute_query(query, (category_id,))
