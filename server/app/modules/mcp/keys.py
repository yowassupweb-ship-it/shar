"""Личные ключи MCP: агент (Claude, Cursor и т. п.) работает с «Офисом» от имени человека — и только там, куда
человек его пустил.

  GET    /api/mcp/keys              мои ключи (без самих ключей: начало, название, доступ, срок, когда пользовались)
  POST   /api/mcp/keys              {name, scope, expiresInDays?} → ключ целиком, один раз
  PATCH  /api/mcp/keys/{id}         {name?, scope?} — поменять доступ, не меняя ключ у агента
  DELETE /api/mcp/keys/{id}         отозвать
  GET    /api/mcp/keys/{id}/log     что агент делал этим ключом (последние 200 действий)

Доступ ключа (scope) — подмножество прав человека, расширить их ключ не может:
  access   read — только читать; edit — ещё править существующее; create — ещё создавать и раскладывать по папкам;
  kinds    какие виды материалов видны (заметки, документы, таблицы, презентации);
  folders  null — весь «Офис»; список id — только эти папки и всё, что в них вложено;
  shared   видны ли материалы, которыми с человеком поделились (иначе — только его собственные).

В базе — только SHA-256 ключа: украденная база не даёт войти. Отзыв и смена доступа действуют сразу (без кэша).
Отключённый человек — отключены и его ключи (личность берётся как у сессии).
"""

from __future__ import annotations

import hashlib
import random
import secrets
from dataclasses import dataclass
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.db.connection import Json
from app.core.security import Identity, current_identity, identity_of

router = APIRouter()

PREFIX = "shar_mcp_"
# Ключи на один запуск агента «Ядра» (core_agents/dispatch.py): в списке человека и в лимите их не видно.
JOB_PREFIX = "Ядро · "
MAX_KEYS = 10
KINDS = ("note", "document", "table", "presentation")
ACCESS = ("read", "edit", "create")
LOG_KEEP = 500

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
ALTER TABLE mcp_keys ADD COLUMN IF NOT EXISTS scope JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE mcp_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS mcp_key_log (
    id BIGSERIAL PRIMARY KEY,
    key_id BIGINT NOT NULL REFERENCES mcp_keys(id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tool TEXT NOT NULL,
    item_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    ok BOOLEAN NOT NULL DEFAULT true,
    error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mcp_key_log_key ON mcp_key_log(key_id, id DESC);
""")


class ScopeBody(BaseModel):
    access: Literal["read", "edit", "create"] = "read"
    kinds: list[Literal["note", "document", "table", "presentation"]] = Field(default_factory=lambda: list(KINDS))
    folders: list[str] | None = Field(default=None, max_length=200)
    shared: bool = True
    apps: list[Literal["calendar", "tasks", "files", "people", "agent", "integrations"]] = Field(default_factory=list)


class KeyBody(BaseModel):
    name: str = Field(default="", max_length=80)
    scope: ScopeBody = Field(default_factory=ScopeBody)
    expiresInDays: int | None = Field(default=None, ge=1, le=3650)


class KeyPatch(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    scope: ScopeBody | None = None


@dataclass(frozen=True)
class KeyContext:
    """Кто зовёт и что ему можно: человек, ключ и доступ ключа (уже очищенный)."""

    me: Identity
    key_id: str
    key_name: str
    scope: dict[str, Any]


def clean_scope(raw: Any, user_id: str) -> dict[str, Any]:
    """Доступ в каноническом виде. Папки — только те, что человек сейчас видит (свои и открытые ему)."""
    s = raw if isinstance(raw, dict) else {}
    kinds = [k for k in (s.get("kinds") or []) if k in KINDS]
    folders = s.get("folders")
    if folders is not None:
        from app.modules.workspace.folders import (
            _folders,  # поздний импорт: workspace тянет S3
        )

        visible = {f["id"] for f in _folders(user_id)}
        folders = [str(f) for f in folders if str(f) in visible]
    from app.modules.mcp.apps import APPS

    # Календарь, задачи и прочее сверх «Офиса» — только если открыты явно: у старых ключей их нет.
    apps = [a for a in (s.get("apps") or []) if a in APPS]
    out = {"access": s.get("access") if s.get("access") in ACCESS else "read", "kinds": kinds,
           "folders": folders, "shared": bool(s.get("shared", True)), "apps": apps}
    if s.get("job"):  # ключ запуска «Ядра»: в какое сообщение агент отвечает (ask_user) и режим разрешений человека
        out["job"] = str(s["job"])
        out["mode"] = str(s.get("mode") or "careful")
    return out


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


_COLUMNS = ("id, name, token_start, scope, created_at::text AS created_at, last_used_at::text AS last_used_at, "
            "expires_at::text AS expires_at, (expires_at IS NOT NULL AND expires_at <= now()) AS expired")


def _view(row: dict) -> dict:
    return {"id": str(row["id"]), "name": row["name"], "start": row["token_start"], "scope": row["scope"] or {},
            "createdAt": row["created_at"], "lastUsedAt": row["last_used_at"], "expiresAt": row["expires_at"],
            "expired": bool(row["expired"])}


def _ready() -> None:
    from app.modules.workspace import store  # поздний импорт: workspace тянет S3

    if not store.table_ready("mcp_key_log"):
        raise HTTPException(status_code=503, detail="MCP ещё не включён на сервере: нужна схема MCP (выкладка с -Schema)")


def _own_key(key_id: str, user_id: str) -> dict:
    row = db.conn.fetch_one(f"SELECT {_COLUMNS} FROM mcp_keys WHERE id = %s AND user_id = %s AND revoked_at IS NULL",
                            (int(key_id), user_id)) if key_id.isdigit() else None
    if not row:
        raise HTTPException(status_code=404, detail="Ключ не найден")
    return row


@router.get("/api/mcp/keys")
def list_keys(me: Identity = Depends(current_identity)):
    _ready()
    rows = db.conn.fetch_all(f"SELECT {_COLUMNS} FROM mcp_keys WHERE user_id = %s AND revoked_at IS NULL AND name NOT LIKE %s ORDER BY id DESC",
                             (me.user_id, JOB_PREFIX + "%")) or []
    return {"keys": [_view(r) for r in rows]}


@router.post("/api/mcp/keys", status_code=201)
def create_key(body: KeyBody, me: Identity = Depends(current_identity)):
    _ready()
    count = db.conn.fetch_one("SELECT count(*) AS n FROM mcp_keys WHERE user_id = %s AND revoked_at IS NULL AND name NOT LIKE %s",
                              (me.user_id, JOB_PREFIX + "%"))["n"]
    if count >= MAX_KEYS:
        raise HTTPException(status_code=400, detail=f"Не больше {MAX_KEYS} ключей: отзовите ненужный")
    scope = clean_scope(body.scope.model_dump(), me.user_id)
    if not scope["kinds"]:
        raise HTTPException(status_code=400, detail="Отметьте хотя бы один вид материалов")
    token = PREFIX + secrets.token_urlsafe(32)
    row = db.conn.fetch_one(
        "INSERT INTO mcp_keys (user_id, name, token_hash, token_start, scope, expires_at) "
        "VALUES (%s, %s, %s, %s, %s, CASE WHEN %s::int IS NULL THEN NULL ELSE now() + make_interval(days => %s::int) END) "
        f"RETURNING {_COLUMNS}",
        (me.user_id, body.name.strip() or "Ключ MCP", _hash(token), token[:len(PREFIX) + 4], Json(scope), body.expiresInDays, body.expiresInDays),
    )
    return {"key": _view(row), "token": token}


@router.patch("/api/mcp/keys/{key_id}")
def change_key(key_id: str, body: KeyPatch, me: Identity = Depends(current_identity)):
    _ready()
    _own_key(key_id, me.user_id)
    if body.name is not None:
        db.conn.execute_query("UPDATE mcp_keys SET name = %s WHERE id = %s", (body.name.strip() or "Ключ MCP", int(key_id)))
    if body.scope is not None:
        scope = clean_scope(body.scope.model_dump(), me.user_id)
        if not scope["kinds"]:
            raise HTTPException(status_code=400, detail="Отметьте хотя бы один вид материалов")
        db.conn.execute_query("UPDATE mcp_keys SET scope = %s WHERE id = %s", (Json(scope), int(key_id)))
    return {"key": _view(_own_key(key_id, me.user_id))}


@router.delete("/api/mcp/keys/{key_id}")
def revoke_key(key_id: str, me: Identity = Depends(current_identity)):
    _ready()
    _own_key(key_id, me.user_id)
    db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (int(key_id),))
    return {"ok": True}


@router.get("/api/mcp/keys/{key_id}/log")
def key_log(key_id: str, me: Identity = Depends(current_identity)):
    _ready()
    _own_key(key_id, me.user_id)
    rows = db.conn.fetch_all(
        "SELECT at::text AS at, tool, item_id, title, ok, error FROM mcp_key_log WHERE key_id = %s ORDER BY id DESC LIMIT 200", (int(key_id),)) or []
    return {"log": [{"at": r["at"], "tool": r["tool"], "itemId": r["item_id"], "title": r["title"], "ok": r["ok"], "error": r["error"]} for r in rows]}


def context_for_token(token: str) -> KeyContext | None:
    """Ключ из заголовка Authorization → кто и что ему можно. Просроченный и отозванный — None.
    Отметку «пользовались» ставим не чаще раза в минуту."""
    if not token.startswith(PREFIX):
        return None
    row = db.conn.fetch_one(
        "SELECT id, user_id, name, scope, last_used_at > now() - interval '1 minute' AS fresh FROM mcp_keys "
        "WHERE token_hash = %s AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", (_hash(token),))
    if not row:
        return None
    me = identity_of(str(row["user_id"]))
    if me is None:
        return None
    if not row.get("fresh"):
        db.conn.execute_query("UPDATE mcp_keys SET last_used_at = now() WHERE id = %s", (row["id"],))
    return KeyContext(me=me, key_id=str(row["id"]), key_name=row["name"], scope=clean_scope(row["scope"], me.user_id))


def log_call(ctx: KeyContext, tool: str, item_id: str = "", title: str = "", error: str = "") -> None:
    """Журнал действий агента — человек видит его в настройках. Хранится последние LOG_KEEP записей ключа."""
    db.conn.execute_query("INSERT INTO mcp_key_log (key_id, tool, item_id, title, ok, error) VALUES (%s, %s, %s, %s, %s, %s)",
                          (int(ctx.key_id), tool, item_id[:40], title[:200], not error, error[:300]))
    if random.random() < 0.02:  # подрезаем изредка: журнал — не архив
        db.conn.execute_query(
            "DELETE FROM mcp_key_log WHERE key_id = %s AND id < (SELECT id FROM mcp_key_log WHERE key_id = %s ORDER BY id DESC OFFSET %s LIMIT 1)",
            (int(ctx.key_id), int(ctx.key_id), LOG_KEEP))
