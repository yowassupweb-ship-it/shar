"""PostgresDatabase — склейка репозиториев по областям в один объект."""

from __future__ import annotations

import logging

from app.core.db.connection import PostgresConnection
from app.core.db.repos.chats import ChatsRepo
from app.core.db.repos.cloud import CloudRepo
from app.core.db.repos.departments import DepartmentsRepo
from app.core.db.repos.events import EventsRepo
from app.core.db.repos.mail import MailRepo
from app.core.db.repos.messages import MessagesRepo
from app.core.db.repos.settings import SettingsRepo
from app.core.db.repos.tasks import TasksRepo
from app.core.db.repos.users import UsersRepo

logger = logging.getLogger("shar.db")


class PostgresDatabase(SettingsRepo, UsersRepo, DepartmentsRepo, ChatsRepo, MessagesRepo, EventsRepo, TasksRepo, CloudRepo, MailRepo):
    """Высокоуровневые операции над базой; методы живут в repos/*."""

    _indexes_ensured = False

    def __init__(self, connection: PostgresConnection):
        self.conn = connection  # индексы создаёт app.migrate (после baseline), а не конструктор

    def ensure_performance_indexes(self):
        """Create composite indexes needed for fast chat-list queries — runs once per process."""
        if type(self)._indexes_ensured:
            return
        indexes = [
            # Fast DISTINCT ON (chat_id) ORDER BY chat_id, created_at DESC
            "CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at DESC)",
            # Partial index: only non-deleted messages (matches our WHERE clause exactly)
            "CREATE INDEX IF NOT EXISTS idx_messages_chat_created_active ON messages(chat_id, created_at DESC) WHERE is_deleted = false",
            # chat_participants lookups: find chats for a user, and find users in a chat
            "CREATE INDEX IF NOT EXISTS idx_chat_participants_user_id ON chat_participants(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_chat_participants_chat_id ON chat_participants(chat_id)",
            # messages unread count: filter by author and timestamp
            "CREATE INDEX IF NOT EXISTS idx_messages_author_created ON messages(author_id, created_at) WHERE is_deleted = false",
            # unread own-last lookup: chat_id = ANY(...) + author_id = ...
            "CREATE INDEX IF NOT EXISTS idx_messages_chat_author_created_active ON messages(chat_id, author_id, created_at DESC) WHERE is_deleted = false",
        ]
        try:
            for sql in indexes:
                try:
                    self.conn.execute_query(sql)
                except Exception as e:
                    logger.warning(f"[DB] Index creation warning: {e}")
            type(self)._indexes_ensured = True
        except KeyboardInterrupt:
            raise
        except BaseException as e:
            # DB unavailable at startup — indexes will be created on the next successful startup.
            logger.debug(f"[DB] Skipping index creation at startup: {type(e).__name__}")
