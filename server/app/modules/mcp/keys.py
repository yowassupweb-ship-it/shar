"""Личные ключи MCP: агент (Claude, Cursor и т. п.) работает с «Офисом» от имени человека и с его правами.

  GET    /api/mcp/keys          мои ключи (без самих ключей: только начало, название, когда выпущен и пользовались)
  POST   /api/mcp/keys          {name} → ключ целиком, один раз
  DELETE /api/mcp/keys/{id}     отозвать

В базе — только SHA-256 ключа: украденная база не даёт войти. Ключ отзывается сразу (проверка без кэша).
Отключённый человек — отключены и его ключи (личность берётся как у сессии).
"""

from __future__ import annotations

import hashlib
import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.security import Identity, current_identity, identity_of

router = APIRouter()

PREFIX = "shar_mcp_"
MAX_KEYS = 10

schema.register("mcp_keys", """
CREATE TABLE IF NOT EXISTS mcp_keys (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL UNIQUE,
    token_start TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mcp_keys_user ON mcp_keys(user_id);
""")


class KeyBody(BaseModel):
    name: str = Field(default="", max_length=80)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _view(row: dict) -> dict:
    return {"id": str(row["id"]), "name": row["name"], "start": row["token_start"], "createdAt": row["created_at"],
            "lastUsedAt": row["last_used_at"]}


def _ready() -> None:
    from app.modules.workspace import store  # поздний импорт: workspace тянет S3

    if not store.table_ready("mcp_keys"):
        raise HTTPException(status_code=503, detail="MCP ещё не включён на сервере: нужна таблица mcp_keys")


@router.get("/api/mcp/keys")
def list_keys(me: Identity = Depends(current_identity)):
    _ready()
    rows = db.conn.fetch_all(
        "SELECT id, name, token_start, created_at::text AS created_at, last_used_at::text AS last_used_at FROM mcp_keys "
        "WHERE user_id = %s AND revoked_at IS NULL ORDER BY id DESC", (me.user_id,)) or []
    return {"keys": [_view(r) for r in rows]}


@router.post("/api/mcp/keys", status_code=201)
def create_key(body: KeyBody, me: Identity = Depends(current_identity)):
    _ready()
    count = db.conn.fetch_one("SELECT count(*) AS n FROM mcp_keys WHERE user_id = %s AND revoked_at IS NULL", (me.user_id,))["n"]
    if count >= MAX_KEYS:
        raise HTTPException(status_code=400, detail=f"Не больше {MAX_KEYS} ключей: отзовите ненужный")
    token = PREFIX + secrets.token_urlsafe(32)
    row = db.conn.fetch_one(
        "INSERT INTO mcp_keys (user_id, name, token_hash, token_start) VALUES (%s, %s, %s, %s) "
        "RETURNING id, name, token_start, created_at::text AS created_at, last_used_at::text AS last_used_at",
        (me.user_id, body.name.strip() or "Ключ MCP", _hash(token), token[:len(PREFIX) + 4]),
    )
    return {"key": _view(row), "token": token}


@router.delete("/api/mcp/keys/{key_id}")
def revoke_key(key_id: str, me: Identity = Depends(current_identity)):
    _ready()
    if not key_id.isdigit():
        raise HTTPException(status_code=404, detail="Ключ не найден")
    done = db.conn.fetch_one("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s AND user_id = %s AND revoked_at IS NULL RETURNING id",
                             (int(key_id), me.user_id))
    if not done:
        raise HTTPException(status_code=404, detail="Ключ не найден")
    return {"ok": True}


def identity_for_token(token: str) -> Identity | None:
    """Ключ из заголовка Authorization → человек. Отметку «пользовались» ставим не чаще раза в минуту."""
    if not token.startswith(PREFIX):
        return None
    row = db.conn.fetch_one(
        "SELECT id, user_id, last_used_at > now() - interval '1 minute' AS fresh FROM mcp_keys WHERE token_hash = %s AND revoked_at IS NULL",
        (_hash(token),))
    if not row:
        return None
    if not row.get("fresh"):
        db.conn.execute_query("UPDATE mcp_keys SET last_used_at = now() WHERE id = %s", (row["id"],))
    return identity_of(str(row["user_id"]))
