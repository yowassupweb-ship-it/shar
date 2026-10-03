"""Хранилище web-push: подписки устройств и личные настройки уведомлений."""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.core import schema
from app.core.db import db
from app.core.db.connection import Json

log = logging.getLogger("shar.push")

schema.register("push_subscriptions", """
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint     TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    subscription JSONB NOT NULL,
    user_agent   TEXT,
    platform     TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id)""")

schema.register("push_prefs", """
CREATE TABLE IF NOT EXISTS push_prefs (
    user_id TEXT PRIMARY KEY,
    prefs   JSONB NOT NULL DEFAULT '{}'::jsonb
)""")

MAX_SUBSCRIPTIONS_PER_USER = 20


def upsert_subscription(user_id: str, subscription: Dict[str, Any], user_agent: str = "", platform: str = "") -> Dict[str, Any]:
    """Подписка принадлежит устройству (endpoint). Если на нём входил другой человек —
    она переходит к вошедшему сейчас: иначе общий компьютер показывал бы пуши обоим."""
    endpoint = str(subscription.get("endpoint") or "").strip()
    row = db.conn.fetch_one(
        """
        INSERT INTO push_subscriptions (endpoint, user_id, subscription, user_agent, platform)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (endpoint) DO UPDATE SET
            user_id = EXCLUDED.user_id, subscription = EXCLUDED.subscription,
            user_agent = EXCLUDED.user_agent, platform = EXCLUDED.platform, updated_at = NOW()
        RETURNING endpoint, updated_at
        """,
        (endpoint, user_id, Json(subscription), user_agent[:400], platform[:80]),
    )
    # Старые подписки сверх лимита уходят: браузеры переподписываются, а записи копятся.
    db.conn.execute_query(
        """
        DELETE FROM push_subscriptions WHERE user_id = %s AND endpoint NOT IN (
            SELECT endpoint FROM push_subscriptions WHERE user_id = %s ORDER BY updated_at DESC LIMIT %s)
        """,
        (user_id, user_id, MAX_SUBSCRIPTIONS_PER_USER),
    )
    return dict(row) if row else {"endpoint": endpoint}


def subscriptions_of(user_id: str) -> List[Dict[str, Any]]:
    return [dict(r) for r in db.conn.fetch_all("SELECT endpoint, subscription FROM push_subscriptions WHERE user_id = %s", (user_id,))]


def count_for(user_id: str) -> int:
    row = db.conn.fetch_one("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = %s", (user_id,))
    return int(row["n"]) if row else 0


def remove(user_id: str, endpoint: str = "") -> int:
    """Удалить подписки пользователя (одну по endpoint или все свои)."""
    if endpoint:
        row = db.conn.fetch_one("DELETE FROM push_subscriptions WHERE user_id = %s AND endpoint = %s RETURNING 1 AS x", (user_id, endpoint))
        return 1 if row else 0
    rows = db.conn.fetch_all("DELETE FROM push_subscriptions WHERE user_id = %s RETURNING 1 AS x", (user_id,))
    return len(rows or [])


def drop_endpoint(endpoint: str) -> None:
    """Подписка умерла (404/410 от push-сервиса) — убрать, у кого бы она ни была."""
    db.conn.execute_query("DELETE FROM push_subscriptions WHERE endpoint = %s", (endpoint,))


def get_prefs(user_id: str) -> Dict[str, Any]:
    row = db.conn.fetch_one("SELECT prefs FROM push_prefs WHERE user_id = %s", (user_id,))
    return dict(row["prefs"]) if row and isinstance(row["prefs"], dict) else {}


def set_prefs(user_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    row = db.conn.fetch_one(
        """
        INSERT INTO push_prefs (user_id, prefs) VALUES (%s, %s)
        ON CONFLICT (user_id) DO UPDATE SET prefs = push_prefs.prefs || EXCLUDED.prefs
        RETURNING prefs
        """,
        (user_id, Json(patch)),
    )
    return dict(row["prefs"]) if row else patch
