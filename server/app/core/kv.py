"""Небольшое JSON-хранилище «ключ → значение» в Postgres.

Замена файлам data/*.json старого Next (requests.json, utm-пресеты и т.п.): те
перезаписывались целиком без блокировок, и два одновременных запроса теряли
правки друг друга. Здесь изменение — одна транзакция с блокировкой строки.
"""

from __future__ import annotations

import copy
import json
import logging
from typing import Any, Callable

from app.core import schema
from app.core.db import db
from app.core.db.connection import PSYCOPG_VERSION, Json

log = logging.getLogger("shar.kv")

schema.register("app_kv", """
CREATE TABLE IF NOT EXISTS app_kv (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)""")


def get(key: str, default: Any = None) -> Any:
    row = db.conn.fetch_one("SELECT value FROM app_kv WHERE key = %s", (key,))
    return row["value"] if row else copy.deepcopy(default)


def set(key: str, value: Any) -> None:  # noqa: A001 — имя как у dict.update/set в других хранилищах
    db.conn.execute_query(
        "INSERT INTO app_kv (key, value, updated_at) VALUES (%s, %s, NOW()) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
        (key, Json(value)),
    )


def update(key: str, default: Any, fn: Callable[[Any], Any]) -> Any:
    """Прочитать, изменить функцией fn (возвращает новое значение), записать — атомарно.

    Строка блокируется на время вызова fn: параллельные update() ждут своей очереди и
    видят уже изменённое значение. fn должна быть быстрой и без обращений к сети."""
    conn = db.conn._get_thread_conn()
    if PSYCOPG_VERSION == 3:
        with conn.transaction():
            return _update_locked(conn, key, default, fn)
    previous = conn.autocommit
    conn.autocommit = False
    try:
        result = _update_locked(conn, key, default, fn)
        conn.commit()
        return result
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.autocommit = previous


def _update_locked(conn, key: str, default: Any, fn: Callable[[Any], Any]) -> Any:
    with conn.cursor() as cur:
        cur.execute("INSERT INTO app_kv (key, value) VALUES (%s, %s) ON CONFLICT (key) DO NOTHING", (key, Json(default)))
        cur.execute("SELECT value FROM app_kv WHERE key = %s FOR UPDATE", (key,))
        row = cur.fetchone()
        current = row["value"] if isinstance(row, dict) else row[0]
        if isinstance(current, str):
            current = json.loads(current)
        new_value = fn(current)
        cur.execute("UPDATE app_kv SET value = %s, updated_at = NOW() WHERE key = %s", (Json(new_value), key))
        return new_value
