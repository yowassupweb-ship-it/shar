from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.core.db.connection import Json
from app.core.passwords import hash_password, is_hashed, verify_password

logger = logging.getLogger("shar.db")


def _hashed(password: Optional[str]) -> Optional[str]:
    """Пароль в базу — только хешем: что бы ни пришло от вызывающего, открытым текстом он не ляжет."""
    if not password or is_hashed(password):
        return password
    return hash_password(password)


class UsersRepo:
    """Запросы области «users». Требует self.conn (PostgresConnection)."""

    # ==================== USERS ====================
    def get_users(self, include_disabled: bool = False) -> List[Dict[str, Any]]:
        """All users. Disabled (soft-deactivated) users are hidden by default so
        they disappear from the app everywhere; admin passes include_disabled to
        still see + re-enable them."""
        self._ensure_users_columns()
        if include_disabled:
            query = "SELECT * FROM users ORDER BY created_at"
        else:
            query = "SELECT * FROM users WHERE is_disabled IS NOT TRUE ORDER BY created_at"
        return self.conn.fetch_all(query)

    def get_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Get single user by ID, username or email"""
        # Try ID, username or email
        query = "SELECT * FROM users WHERE id = %s OR username = %s OR email = %s"
        result = self.conn.fetch_one(query, (user_id, user_id, user_id))
        return dict(result) if result else None

    def get_user_by_login(self, login: str) -> Optional[Dict[str, Any]]:
        """Пользователь по логину или почте — только для входа. В отличие от get_user,
        id в поиске не участвует: иначе username, совпавший с чужим id, подменял бы человека."""
        result = self.conn.fetch_one(
            "SELECT * FROM users WHERE username = %s OR email = %s ORDER BY (username = %s) DESC LIMIT 1",
            (login, login, login),
        )
        return dict(result) if result else None

    def get_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Get single user by ID"""
        query = "SELECT * FROM users WHERE id = %s"
        result = self.conn.fetch_one(query, (user_id,))
        return dict(result) if result else None

    def verify_user(self, username: str, password: str) -> bool:
        """Verify user credentials.

        Понимает и хешированные пароли, и старые открытые — см. app.core.passwords:
        перехеширование происходит при входе, чтобы миграция никого не выбросила."""
        user = self.get_user_by_login(username)
        if user is None:
            return False
        return verify_password(password, user.get("password"))

    def delete_user(self, user_id: str) -> bool:
        """Delete a user. This method didn't exist on the Postgres backend at
        all (only on the legacy JSON store), so admin 'delete user' was raising
        AttributeError → 500. Every FK into users is ON DELETE CASCADE / SET
        NULL (chat_participants, messages, reactions, tasks, events…), so the
        DB itself handles dependent rows — a plain delete is safe. Returns False
        when there's no such user so the endpoint can 404."""
        existing = self.conn.fetch_one("SELECT id FROM users WHERE id = %s", (user_id,))
        if not existing:
            return False
        self.conn.execute_query("DELETE FROM users WHERE id = %s", (user_id,))
        return True

    def add_user(self, user: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Add new user"""
        import uuid

        self._ensure_users_columns()
        # Generate ID if not provided
        user_id = user.get('id', str(uuid.uuid4()))

        # Support both camelCase and snake_case
        username = user.get('username', user.get('email', '').split('@')[0])

        # Multi-department: department_ids is the full set; keep the legacy single
        # `department` in sync to the first (primary) so existing reads keep working.
        dept_ids = user.get('department_ids', user.get('departmentIds')) or []
        dept_ids = [str(d) for d in dept_ids if d]
        primary_dept = user.get('department') or (dept_ids[0] if dept_ids else None)
        if primary_dept and primary_dept not in dept_ids:
            dept_ids = [primary_dept, *dept_ids]

        query = """
            INSERT INTO users
            (id, name, username, email, password, role, todo_role, position, department,
             phone, work_schedule, enabled_tools, can_see_all_tasks, avatar, department_ids)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::text[])
            ON CONFLICT (email) DO NOTHING
            RETURNING *
        """
        params = (
            user_id,
            user.get('name'),
            username,
            user.get('email'),
            _hashed(user.get('password')),
            user.get('role', 'user'),
            user.get('todo_role', user.get('todoRole', 'universal')),
            user.get('position'),
            primary_dept,
            user.get('phone'),
            user.get('work_schedule', user.get('workSchedule')),
            Json(user.get('enabled_tools', user.get('enabledTools', []))),
            user.get('can_see_all_tasks', user.get('canSeeAllTasks', False)),
            user.get('avatar'),
            dept_ids,
        )
        result = self.conn.fetch_one(query, params)
        return dict(result) if result else None

    def update_user(self, user_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update user"""
        # Mapping camelCase to snake_case
        field_map = {
            'enabledTools': 'enabled_tools',
            'canSeeAllTasks': 'can_see_all_tasks',
            'isDepartmentHead': 'is_department_head',
            'todoRole': 'todo_role',
            'workSchedule': 'work_schedule',
            'telegramId': 'telegram_id',
            'telegramUsername': 'telegram_username',
            'isOnline': 'is_online',
            'lastSeen': 'last_seen',
            'createdAt': 'created_at',
            'updatedAt': 'updated_at',
            'visibleTabs': 'visible_tabs',
            'toolsOrder': 'tools_order',
            'isActive': 'is_active',
            'isDisabled': 'is_disabled',
            'pinnedTools': 'pinned_tools',
            'chatSettings': 'chat_settings',
            'departmentIds': 'department_ids'
        }
        # A handful of callers pass an already-snake_case (or single-word,
        # case-identical) key straight through instead of via field_map —
        # every one actually used anywhere in the codebase, enumerated here.
        # Anything else is dropped rather than interpolated as a column name:
        # `db_key` used to fall back to the raw dict key unchanged, so a caller
        # that ever forwarded an unvalidated body could inject an arbitrary
        # column name into the UPDATE (values are parameterized, the column
        # name never was).
        allowed_direct_keys = {
            'username', 'name', 'email', 'password', 'role', 'position',
            'department', 'phone', 'avatar', 'last_seen',
        }
        self._ensure_users_columns()

        updates = dict(updates)
        # Multi-department: whenever the set of departments changes, keep the legacy
        # single `department` (primary) in sync to the first one, unless the caller
        # explicitly set `department` too.
        if 'departmentIds' in updates:
            dids = [str(d) for d in (updates['departmentIds'] or []) if d]
            updates['departmentIds'] = dids
            if 'department' not in updates:
                updates['department'] = dids[0] if dids else None

        set_clauses = []
        params = []

        for key, value in updates.items():
            # Convert to snake_case; drop anything not in the known allow-list
            # instead of trusting the caller's key as a column name.
            if key in field_map:
                db_key = field_map[key]
            elif key in allowed_direct_keys:
                db_key = key
            else:
                continue

            # Handle JSON fields
            if db_key == 'chat_settings':
                set_clauses.append("chat_settings = COALESCE(chat_settings, '{}'::jsonb) || %s::jsonb")
                params.append(Json(value or {}))
            elif db_key in ['enabled_tools', 'metadata', 'visible_tabs', 'tools_order', 'pinned_tools']:
                set_clauses.append(f"{db_key} = %s")
                params.append(Json(value))
            elif db_key == 'password':
                set_clauses.append("password = %s")
                params.append(_hashed(value))
            elif db_key == 'department_ids':
                # Postgres TEXT[] — cast so an empty list doesn't hit "cannot determine
                # type of empty array".
                set_clauses.append(f"{db_key} = %s::text[]")
                params.append(value or [])
            else:
                set_clauses.append(f"{db_key} = %s")
                params.append(value)
        
        set_clauses.append("updated_at = NOW()")
        params.append(user_id)
        
        query = f"UPDATE users SET {', '.join(set_clauses)} WHERE id = %s RETURNING *"
        result = self.conn.fetch_one(query, tuple(params))
        return dict(result) if result else None

    _users_columns_ensured = False  # class-level flag: run once per process

    def _ensure_users_columns(self):
        """Ensure optional users columns exist (idempotent, once per process)."""
        if type(self)._users_columns_ensured:
            return
        type(self)._users_columns_ensured = True
        ddl_statements = [
            # 'Disabled' = soft-deactivation: the user vanishes from every list
            # (users/contacts/chats) but their account + history stay, and it can
            # be flipped back on — distinct from a hard delete.
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN DEFAULT FALSE",
            # A user can belong to MULTIPLE departments/sub-departments. department_ids
            # is the full set; the legacy single `department` column is kept in sync to
            # the first of these as the "primary", so all existing code that reads
            # user.department keeps working.
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS department_ids TEXT[] DEFAULT '{}'::text[]",
        ]
        for sql in ddl_statements:
            try:
                self.conn.execute_query(sql)
            except Exception as e:
                logger.warning(f"DDL failed (will continue): {e}")
