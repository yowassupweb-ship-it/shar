"""Миграции базы: `python -m app.migrate` (или автоматически при старте сервиса).

  1. migrations/*.sql — по порядку имён, каждая один раз (учёт — таблица schema_migrations);
  2. DDL модулей (core/schema.py) — идемпотентные CREATE TABLE IF NOT EXISTS.

Baseline 0001 идемпотентен, поэтому на боевой базе старого бэкенда он ничего не ломает:
существующие таблицы остаются, недостающие создаются.

На проде автоматических миграций нет (SHAR_AUTO_MIGRATE=0) — схема догоняется отдельным шагом выпуска:
  python -m app.migrate --print          показать DDL модулей (прочитать перед применением)
  python -m app.migrate --schema-only    применить только DDL модулей (новые таблицы и столбцы, IF NOT EXISTS)
  python -m app.migrate --reindex-office пересчитать текст для поиска у таблиц «Офиса» (разово)
Подробно — docs/RELEASE.md."""

from __future__ import annotations

import logging
from pathlib import Path

from app.config import SERVER_ROOT
from app.core import schema
from app.core.db import db

log = logging.getLogger("shar.migrate")

MIGRATIONS_DIR = SERVER_ROOT / "migrations"


def run() -> list[str]:
    """Применить всё недостающее. Возвращает имена применённых миграций."""
    db.conn.execute_query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    done = {r["name"] for r in db.conn.fetch_all("SELECT name FROM schema_migrations") or []}
    applied: list[str] = []
    for path in sorted(Path(MIGRATIONS_DIR).glob("*.sql")):
        if path.name in done:
            continue
        log.info("applying migration %s", path.name)
        if not db.conn.execute_sql_file(str(path)):
            raise RuntimeError(f"migration {path.name} failed")
        db.conn.execute_query("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
        applied.append(path.name)
    # Импорт модулей регистрирует их DDL.
    import app.modules  # noqa: F401, PLC0415

    failed = schema.apply()
    if failed:
        raise RuntimeError(f"schema not applied: {', '.join(failed)}")
    db.db.ensure_performance_indexes()
    # Колонки, которые старый бэкенд добавлял лениво.
    for ensure in ("_ensure_users_columns", "_ensure_departments_columns", "_ensure_chats_columns", "_ensure_cloud_storage_tables", "_ensure_mail_tables"):
        getattr(db.db, ensure)()
    return applied


def schema_only() -> None:
    """Только DDL модулей: шаг выпуска на проде, где миграции при старте выключены."""
    import app.modules  # noqa: F401, PLC0415

    failed = schema.apply()
    if failed:
        raise RuntimeError(f"schema not applied: {', '.join(failed)}")


if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if "--print" in sys.argv:
        import app.modules  # noqa: F401, PLC0415

        for name, ddl in schema._statements:
            print(f"-- {name}\n{ddl.strip()}\n")
    elif "--schema-only" in sys.argv:
        schema_only()
        print("schema: applied")
    elif "--reindex-office" in sys.argv:
        # Текст для поиска у таблиц, сохранённых до того, как его начали считать (разовый шаг выпуска).
        from app.modules.workspace import store  # noqa: PLC0415

        print("reindexed:", store.reindex_text())
    else:
        done = run()
        print("applied:", ", ".join(done) if done else "nothing to do")
