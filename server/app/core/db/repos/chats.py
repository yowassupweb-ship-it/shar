from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.core.db.connection import Json

logger = logging.getLogger("shar.db")


class ChatsRepo:
    """Запросы области «chats». Требует self.conn (PostgresConnection)."""

    _chats_columns_ensured = False  # class-level flag: run once per process

    def _ensure_chats_columns(self):
        """Ensure optional chats columns exist — runs DDL only once per process startup."""
        if type(self)._chats_columns_ensured:
            return
        # Mark as done immediately — all statements are IF NOT EXISTS and idempotent;
        # don't re-run them on every request even if one fails.
        type(self)._chats_columns_ensured = True
        ddl_statements = [
            "ALTER TABLE chats ADD COLUMN IF NOT EXISTS pinned_by_user JSONB DEFAULT '{}'::jsonb",
            "ALTER TABLE chats ADD COLUMN IF NOT EXISTS pinned_order_by_user JSONB DEFAULT '{}'::jsonb",
            "ALTER TABLE chats ADD COLUMN IF NOT EXISTS archived_by_user JSONB DEFAULT '{}'::jsonb",
            "ALTER TABLE chats ADD COLUMN IF NOT EXISTS muted_by_user JSONB DEFAULT '{}'::jsonb",
            "ALTER TABLE chats ADD COLUMN IF NOT EXISTS discussion_status VARCHAR(50)",
            "ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar TEXT",
            # read_messages_by_user stores a MESSAGE ID (read-up-to marker, for unread
            # counts) — it was never a timestamp, but the client had nothing else to
            # show in the "read at" detail popup, so it fell back to that message's
            # own createdAt (send time) as an approximation, which read as "message
            # sat unread for ages, then the read receipt shows it was read at the
            # moment it was sent". This column is the actual wall-clock mark-read
            # time, set unconditionally in main.py's mark_messages_as_read.
            "ALTER TABLE chats ADD COLUMN IF NOT EXISTS read_at_by_user JSONB DEFAULT '{}'::jsonb",
        ]
        for sql in ddl_statements:
            try:
                self.conn.execute_query(sql)
            except Exception as e:
                logger.warning(f"DDL failed (will continue): {e}")

    def get_chats(self, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get chats, optionally filtered by user"""
        self._ensure_chats_columns()
        # ORDER BY c.updated_at alone used to leave the list sorted by whenever the
        # chat ROW last changed (rename, archive, pin, mute, ...) — add_message()
        # never touches it, so a chat with brand-new messages could sit anywhere.
        # The client's own SSE handler re-sorts by last-message-time locally the
        # instant a message arrives, but that ordering got silently discarded the
        # next time this query ran (poll, tab reopen, chat switch) since it never
        # matched what the server considered "most recent". Ordering by the actual
        # latest non-deleted message time (falling back to updated_at for chats
        # with no messages yet) makes the server agree with what the client already
        # shows. idx_messages_chat_created_active (chat_id, created_at DESC WHERE
        # is_deleted = false) makes this subquery an index scan, not a table scan.
        if user_id:
            # GROUP BY c.id already yields exactly one row per chat (the JOIN can
            # otherwise multiply rows across participants) — DISTINCT was redundant
            # on top of that, and Postgres additionally rejects SELECT DISTINCT
            # combined with an ORDER BY expression that isn't itself in the select
            # list (which the COALESCE subquery below isn't), so keeping both broke
            # this query outright: "for SELECT DISTINCT, ORDER BY expressions must
            # appear in select list" — the chat list silently came back empty.
            # LIMIT is a safety net, not real pagination — the frontend's chat-list
            # request has no page/cursor concept at all (unlike get_messages, which
            # the client already pages through), so a real cursor-paginated rewrite
            # here would need matching frontend infinite-scroll UI that wasn't asked
            # for. A generous cap just stops a pathological account (thousands of
            # chats) from turning this into a full, unbounded ARRAY_AGG + correlated
            # subquery scan on every chat-list load; it's a no-op for every real user.
            query = """
                SELECT c.*,
                    ARRAY_REMOVE(ARRAY_AGG(DISTINCT cp.user_id), NULL) AS participant_ids
                FROM chats c
                INNER JOIN chat_participants cp ON c.id = cp.chat_id
                WHERE c.id IN (
                    SELECT chat_id FROM chat_participants WHERE user_id = %s
                )
                GROUP BY c.id
                ORDER BY COALESCE(
                    (SELECT MAX(m.created_at) FROM messages m WHERE m.chat_id = c.id AND m.is_deleted = false),
                    c.updated_at
                ) DESC
                LIMIT 500
            """
            chats = self.conn.fetch_all(query, (user_id,))
        else:
            query = """
                SELECT c.*,
                    ARRAY_REMOVE(ARRAY_AGG(DISTINCT cp.user_id), NULL) AS participant_ids
                FROM chats c
                LEFT JOIN chat_participants cp ON c.id = cp.chat_id
                GROUP BY c.id
                ORDER BY COALESCE(
                    (SELECT MAX(m.created_at) FROM messages m WHERE m.chat_id = c.id AND m.is_deleted = false),
                    c.updated_at
                ) DESC
                LIMIT 2000
            """
            chats = self.conn.fetch_all(query)
        
        # Convert participant_ids from list to array if needed
        for chat in chats:
            if chat.get('participant_ids') is None:
                chat['participant_ids'] = []
        
        return chats

    def get_user_chats(self, user_id: str) -> List[Dict[str, Any]]:
        """Get all chats for a specific user (alias for get_chats)"""
        return self.get_chats(user_id=user_id)

    def get_chat(self, chat_id: str) -> Optional[Dict[str, Any]]:
        """Get single chat"""
        self._ensure_chats_columns()
        query = """
            SELECT c.*,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT cp.user_id), NULL) AS participant_ids
            FROM chats c
            LEFT JOIN chat_participants cp ON c.id = cp.chat_id
            WHERE c.id = %s
            GROUP BY c.id
        """
        result = self.conn.fetch_one(query, (chat_id,))
        if result:
            chat = dict(result)
            # If chat_participants table is empty, fall back to stored participantIds column
            if not chat.get('participant_ids'):
                stored = chat.get('participantIds') or []
                if isinstance(stored, list):
                    chat['participant_ids'] = [str(uid) for uid in stored if uid is not None]
                else:
                    chat['participant_ids'] = []
            return chat
        return None

    def update_chat(self, chat_id: str, update_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update chat"""
        self._ensure_chats_columns()
        set_clauses = []
        params = []
        
        field_mapping = {
            'title': 'title',
            'avatar': 'avatar',
            'is_group': 'is_group',
            'isGroup': 'is_group',
            'todo_id': 'todo_id',
            'todoId': 'todo_id',
            'is_notifications_chat': 'is_notifications_chat',
            'isNotificationsChat': 'is_notifications_chat',
            'is_system_chat': 'is_system_chat',
            'isSystemChat': 'is_system_chat',
            'is_favorites_chat': 'is_favorites_chat',
            'isFavoritesChat': 'is_favorites_chat',
            'read_messages_by_user': 'read_messages_by_user',
            'readMessagesByUser': 'read_messages_by_user',
            'read_at_by_user': 'read_at_by_user',
            'readAtByUser': 'read_at_by_user',
            'pinned_by_user': 'pinned_by_user',
            'pinnedByUser': 'pinned_by_user',
            'pinned_order_by_user': 'pinned_order_by_user',
            'pinnedOrderByUser': 'pinned_order_by_user',
            'archived_by_user': 'archived_by_user',
            'archivedByUser': 'archived_by_user',
            'muted_by_user': 'muted_by_user',
            'mutedByUser': 'muted_by_user',
            'discussion_status': 'discussion_status',
            'discussionStatus': 'discussion_status',
            'updated_at': 'updated_at',
            'updatedAt': 'updated_at'
        }
        
        # Имя колонки — только из белого списка: раньше неизвестный ключ шёл в SQL как есть.
        allowed_columns = set(field_mapping.values()) | {'last_message_id'}
        for key, value in update_data.items():
            db_field = field_mapping.get(key, key)
            if db_field not in allowed_columns:
                continue
            if db_field in ['read_messages_by_user', 'read_at_by_user', 'pinned_by_user', 'pinned_order_by_user', 'archived_by_user', 'muted_by_user']:
                set_clauses.append(f"{db_field} = %s")
                params.append(Json(value))
            else:
                set_clauses.append(f"{db_field} = %s")
                params.append(value)
        
        if not set_clauses:
            return self.get_chat(chat_id)
        
        params.append(chat_id)
        query = f"""
            UPDATE chats
            SET {', '.join(set_clauses)}
            WHERE id = %s
            RETURNING *
        """
        
        result = self.conn.fetch_one(query, tuple(params))
        return dict(result) if result else None

    _USER_MAP_COLUMNS = frozenset({
        'read_messages_by_user', 'read_at_by_user', 'pinned_by_user',
        'pinned_order_by_user', 'archived_by_user', 'muted_by_user',
    })

    def merge_user_map(self, chat_id: str, column: str, user_id: str, value: Any = None, *, remove: bool = False) -> Optional[Dict[str, Any]]:
        """Атомарно поставить (или убрать) ЗНАЧЕНИЕ одного пользователя в личной карте чата.

        Карты (прочитано, закреплено, архив, без звука) — JSONB «пользователь → значение».
        Прежний путь «прочитать карту, поменять в Python, записать целиком» терял правки:
        два участника, отметившие чат прочитанным одновременно, затирали друг друга. Здесь
        меняется один ключ внутри UPDATE — чужие ключи не трогаются."""
        if column not in self._USER_MAP_COLUMNS:
            raise ValueError(f"unknown chat map column: {column}")
        self._ensure_chats_columns()
        if remove:
            query = f"UPDATE chats SET {column} = COALESCE({column}, '{{}}'::jsonb) - %s WHERE id = %s RETURNING *"
            params: tuple = (user_id, chat_id)
        else:
            query = f"UPDATE chats SET {column} = COALESCE({column}, '{{}}'::jsonb) || jsonb_build_object(%s::text, %s::jsonb) WHERE id = %s RETURNING *"
            params = (user_id, Json(value), chat_id)
        result = self.conn.fetch_one(query, params)
        return dict(result) if result else None

    def find_private_chat(self, user_id1: str, user_id2: str) -> Optional[Dict[str, Any]]:
        """Find existing private chat between two users"""
        query = """
            SELECT c.*, 
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT cp.user_id), NULL) AS participant_ids
            FROM chats c
            INNER JOIN chat_participants cp ON c.id = cp.chat_id
            WHERE c.is_group = false
            GROUP BY c.id
            HAVING COUNT(DISTINCT cp.user_id) = 2
                AND ARRAY_AGG(DISTINCT cp.user_id) @> ARRAY[%s, %s]::varchar[]
            LIMIT 1
        """
        result = self.conn.fetch_one(query, (user_id1, user_id2))
        if result:
            chat = dict(result)
            if chat.get('participant_ids') is None:
                chat['participant_ids'] = []
            return chat
        return None

    def add_chat(self, chat: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Add new chat"""
        self._ensure_chats_columns()
        query = """
            INSERT INTO chats 
            (id, title, is_group, todo_id, is_notifications_chat, is_system_chat, is_favorites_chat, 
             creator_id, read_messages_by_user, pinned_by_user, pinned_order_by_user, archived_by_user, discussion_status, avatar)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """
        params = (
            chat.get('id'),
            chat.get('title'),
            chat.get('is_group', chat.get('isGroup', False)),
            chat.get('todo_id', chat.get('todoId')),
            chat.get('is_notifications_chat', chat.get('isNotificationsChat', False)),
            chat.get('is_system_chat', chat.get('isSystemChat', False)),
            chat.get('is_favorites_chat', chat.get('isFavoritesChat', False)),
            chat.get('creator_id', chat.get('creatorId')),
            Json(chat.get('read_messages_by_user', chat.get('readMessagesByUser', {}))),
            Json(chat.get('pinned_by_user', chat.get('pinnedByUser', {}))),
            Json(chat.get('pinned_order_by_user', chat.get('pinnedOrderByUser', {}))),
            Json(chat.get('archived_by_user', chat.get('archivedByUser', {}))),
            chat.get('discussion_status', chat.get('discussionStatus')),
            chat.get('avatar')
        )
        result = self.conn.fetch_one(query, params)
        
        # Add participants
        participant_ids = chat.get('participant_ids', chat.get('participantIds', []))
        if result and participant_ids:
            for participant_id in participant_ids:
                self._add_chat_participant(chat.get('id'), participant_id)
        
        return dict(result) if result else None

    def create_chat(self, chat: Dict[str, Any]) -> Dict[str, Any]:
        """Create new chat (alias for add_chat)"""
        return self.add_chat(chat)

    def find_chat_by_todo(self, todo_id: str) -> Optional[Dict[str, Any]]:
        """Find chat associated with a task"""
        self._ensure_chats_columns()
        query = """
            SELECT c.*, 
                ARRAY_AGG(DISTINCT cp.user_id) FILTER (WHERE cp.user_id IS NOT NULL) AS participant_ids
            FROM chats c
            LEFT JOIN chat_participants cp ON c.id = cp.chat_id
            WHERE c.todo_id = %s
            GROUP BY c.id
            LIMIT 1
        """
        result = self.conn.fetch_one(query, (todo_id,))
        if result:
            chat = dict(result)
            if chat.get('participant_ids') is None:
                chat['participant_ids'] = []
            return chat
        return None

    def delete_chat(self, chat_id: str) -> bool:
        """Delete chat (cascade deletes messages and participants)"""
        query = "DELETE FROM chats WHERE id = %s"
        self.conn.execute_query(query, (chat_id,))
        return True

    def _add_chat_participant(self, chat_id: str, user_id: str):
        """Add participant to chat"""
        query = "INSERT INTO chat_participants (chat_id, user_id) VALUES (%s, %s)"
        self.conn.execute_query(query, (chat_id, user_id))

    def add_chat_participant(self, chat_id: str, user_id: str) -> bool:
        """Public, idempotent add — used to add someone to an existing group chat."""
        existing = self.conn.fetch_one(
            "SELECT 1 FROM chat_participants WHERE chat_id = %s AND user_id = %s",
            (chat_id, str(user_id)),
        )
        if not existing:
            self._add_chat_participant(chat_id, str(user_id))
        return True

    def remove_chat_participant(self, chat_id: str, user_id: str) -> bool:
        """Remove someone from a group chat."""
        self.conn.execute_query(
            "DELETE FROM chat_participants WHERE chat_id = %s AND user_id = %s",
            (chat_id, str(user_id)),
        )
        return True
