"""Схема базы, которую создаёт сам сервис.

Модули регистрируют свои идемпотентные DDL (`CREATE TABLE IF NOT EXISTS …`) через
register(); lifecycle применяет их при старте. Так таблица живёт рядом с кодом,
который её использует, а не в россыпи SQL-скриптов.

Таблицы старого бэкенда (users, chats, messages, …) создаёт baseline —
migrations/0001_baseline.sql; применить: `python -m app.migrate`.
"""

from __future__ import annotations

import logging

from app.core.db import db

log = logging.getLogger("shar.schema")

_statements: list[tuple[str, str]] = []


def register(name: str, ddl: str) -> None:
    """Зарегистрировать DDL модуля (повторная регистрация того же имени заменяет)."""
    for i, (existing, _) in enumerate(_statements):
        if existing == name:
            _statements[i] = (name, ddl)
            return
    _statements.append((name, ddl))


def apply() -> list[str]:
    """Применить зарегистрированное. Возвращает имена, которые не удалось применить."""
    failed: list[str] = []
    for name, ddl in _statements:
        if not db.conn.execute_query(ddl):
            failed.append(name)
            log.error("schema: %s not applied", name)
    return failed
