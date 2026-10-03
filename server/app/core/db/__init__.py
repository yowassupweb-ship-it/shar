"""Единая точка доступа к базе: `from app.core.db import db`.

  connection.py   PostgresConnection — по соединению на поток, повтор при обрыве
  repos/*.py      запросы по областям (users, chats, messages, events, tasks, cloud, mail…)
  database.py     PostgresDatabase — склейка репозиториев
"""

from __future__ import annotations

import logging

from app.core.db.connection import PostgresConnection
from app.core.db.database import PostgresDatabase

log = logging.getLogger("shar.db")


class DatabaseAdapter:
    """Подключение + методы предметной области; неизвестные атрибуты уходят в PostgresDatabase."""

    def __init__(self) -> None:
        self.conn = PostgresConnection()
        if not self.conn.connect():
            log.warning("PostgreSQL недоступен при старте — подключимся при первом запросе")
        self.db = PostgresDatabase(self.conn)

    def __getattr__(self, name: str):
        return getattr(self.db, name)


db = DatabaseAdapter()

__all__ = ["db", "DatabaseAdapter", "PostgresConnection", "PostgresDatabase"]
