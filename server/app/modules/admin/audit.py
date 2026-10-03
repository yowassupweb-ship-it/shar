"""Журнал действий администратора: кто, что и над кем сделал."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.core import schema
from app.core.db import db
from app.core.db.connection import Json
from app.core.security import Identity

log = logging.getLogger("shar.audit")

schema.register("admin_audit", """
CREATE TABLE IF NOT EXISTS admin_audit (
    id         BIGSERIAL PRIMARY KEY,
    at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_id   TEXT NOT NULL,
    actor_name TEXT,
    action     TEXT NOT NULL,
    target     TEXT,
    details    JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit (at DESC)""")

SECRET_KEYS = {"password", "token", "botToken", "telegramBotToken", "apiKey"}


def record(actor: Identity, action: str, target: Optional[str] = None, **details: Any) -> None:
    """Записать действие. Секреты из details вырезаются; сбой журнала не ломает само действие."""
    clean: Dict[str, Any] = {k: ("***" if k in SECRET_KEYS else v) for k, v in details.items() if v is not None}
    try:
        db.conn.execute_query(
            "INSERT INTO admin_audit (actor_id, actor_name, action, target, details) VALUES (%s, %s, %s, %s, %s)",
            (actor.user_id, actor.display_name, action, target, Json(clean)),
        )
    except Exception as exc:
        log.warning("audit write failed: %s", exc)


def recent(limit: int = 100) -> List[Dict[str, Any]]:
    rows = db.conn.fetch_all("SELECT * FROM admin_audit ORDER BY at DESC LIMIT %s", (min(max(limit, 1), 500),)) or []
    return [
        {"id": r["id"], "at": r["at"].isoformat() if hasattr(r["at"], "isoformat") else r["at"], "actorId": r["actor_id"],
         "actorName": r["actor_name"], "action": r["action"], "target": r["target"], "details": r["details"] or {}}
        for r in rows
    ]
