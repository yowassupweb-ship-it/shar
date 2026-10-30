"""Личные MCP-серверы агентов человека: подключаются к каждому его запуску на ноде рядом с MCP Шара.

Два вида:
  http   удалённый MCP по адресу (Streamable HTTP / SSE): url и заголовки (например, Authorization: Bearer …)
  npm    локальный MCP из npm-пакета: нода запускает `npx -y <пакет> [аргументы]` в каталоге человека, с его переменными

Человек добавляет их в Настройки → Ядро или просит агента — тот ставит сам (mcp/apps.py: mcp_install; в режиме
«Осторожно» — с разрешения человека). Секреты (заголовки, переменные) хранятся зашифрованными и отдаются ноде только на
время запуска (dispatch.build_run), в ответах API и инструментов их нет.

  GET    /api/core/mcp-servers                мои MCP-серверы (без секретов)
  PUT    /api/core/mcp-servers/{name}         {kind, url?, package?, args?, headers?, env?, enabled?, note?}
  DELETE /api/core/mcp-servers/{name}
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.db.connection import Json
from app.core.security import Identity, current_identity
from app.modules.core_agents import store

router = APIRouter()

NAME = re.compile(r"^[a-z][a-z0-9_-]{1,30}$")
PACKAGE = re.compile(r"^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9._^~-]+)?$")
RESERVED = {"shar", "browser"}
MAX_SERVERS = 20

schema.register("core_mcp_servers", """
CREATE TABLE IF NOT EXISTS core_mcp_servers (
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    package TEXT NOT NULL DEFAULT '',
    args JSONB NOT NULL DEFAULT '[]'::jsonb,
    secrets_enc TEXT NOT NULL DEFAULT '',
    secret_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
    note TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT true,
    added_by TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, name)
);
""")


class McpError(Exception):
    pass


def _ready() -> bool:
    from app.modules.workspace import store as ws_store

    return ws_store.table_ready("core_mcp_servers")


def _view(row: dict) -> dict:
    return {"name": row["name"], "kind": row["kind"], "url": row["url"], "package": row["package"], "args": row.get("args") or [],
            "secretKeys": row.get("secret_keys") or [], "note": row["note"], "enabled": row["enabled"], "addedBy": row["added_by"],
            "updatedAt": row["updated_at"].isoformat() if row.get("updated_at") else None}


def listing(user_id: str) -> list[dict]:
    if not _ready():
        return []
    return [_view(r) for r in db.conn.fetch_all("SELECT * FROM core_mcp_servers WHERE user_id = %s ORDER BY name", (user_id,)) or []]


def save(user_id: str, name: str, data: dict[str, Any], actor: str) -> dict:
    name = str(name).strip().lower()
    if not NAME.match(name) or name in RESERVED:
        raise McpError("Имя MCP: латиница, цифры, - и _, 2–31 знак, с буквы (shar и browser заняты)")
    current = db.conn.fetch_one("SELECT * FROM core_mcp_servers WHERE user_id = %s AND name = %s", (user_id, name))
    if not current and (db.conn.fetch_one("SELECT count(*)::int AS n FROM core_mcp_servers WHERE user_id = %s", (user_id,)) or {}).get("n", 0) >= MAX_SERVERS:
        raise McpError(f"MCP-серверов не больше {MAX_SERVERS}")
    kind = data.get("kind") or (current or {}).get("kind") or ("npm" if data.get("package") else "http")
    url, package, args = "", "", []
    if kind == "http":
        url = str(data.get("url") or (current or {}).get("url") or "").strip()
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise McpError("Адрес MCP — полный https://…")
    elif kind == "npm":
        package = str(data.get("package") or (current or {}).get("package") or "").strip()
        if not PACKAGE.match(package):
            raise McpError("npm-пакет MCP указан неверно (пример: @modelcontextprotocol/server-github)")
        raw = data.get("args") if data.get("args") is not None else (current or {}).get("args") or []
        args = [str(a)[:300] for a in raw][:20] if isinstance(raw, list) else []
    else:
        raise McpError("kind: http (по адресу) или npm (пакет через npx)")
    # Секреты: заголовки для http, переменные окружения для npm. Пустое значение — оставить прежнее.
    secrets = json.loads(store.unseal((current or {}).get("secrets_enc") or "") or "{}")
    incoming = data.get("headers") if kind == "http" else data.get("env")
    for key, value in (incoming or {}).items() if isinstance(incoming, dict) else []:
        key = str(key).strip()
        if not re.match(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$", key):
            raise McpError(f"Недопустимое имя: {key[:40]}")
        if value is None:
            secrets.pop(key, None)
        elif str(value).strip():
            secrets[key] = str(value)[:4000]
    enabled = data.get("enabled") if isinstance(data.get("enabled"), bool) else (current or {}).get("enabled", True)
    note = str(data.get("note") if data.get("note") is not None else (current or {}).get("note") or "")[:300]
    db.conn.execute_query(
        """INSERT INTO core_mcp_servers (user_id, name, kind, url, package, args, secrets_enc, secret_keys, note, enabled, added_by)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (user_id, name) DO UPDATE SET kind = EXCLUDED.kind, url = EXCLUDED.url, package = EXCLUDED.package,
             args = EXCLUDED.args, secrets_enc = EXCLUDED.secrets_enc, secret_keys = EXCLUDED.secret_keys, note = EXCLUDED.note,
             enabled = EXCLUDED.enabled, added_by = EXCLUDED.added_by, updated_at = now()""",
        (user_id, name, kind, url, package, Json(args), store.seal(json.dumps(secrets)) if secrets else "", Json(sorted(secrets)), note,
         enabled, actor))
    return _view(db.conn.fetch_one("SELECT * FROM core_mcp_servers WHERE user_id = %s AND name = %s", (user_id, name)))


def remove(user_id: str, name: str) -> bool:
    return bool(db.conn.fetch_one("DELETE FROM core_mcp_servers WHERE user_id = %s AND name = %s RETURNING name", (user_id, name)))


def for_run(user_id: str) -> list[dict]:
    """Включённые MCP человека для запуска на ноде — с секретами (только в задаче ноде, не в API)."""
    if not _ready():
        return []
    out = []
    for row in db.conn.fetch_all("SELECT * FROM core_mcp_servers WHERE user_id = %s AND enabled ORDER BY name", (user_id,)) or []:
        secrets = json.loads(store.unseal(row.get("secrets_enc") or "") or "{}")
        if row["kind"] == "http":
            out.append({"name": row["name"], "type": "http", "url": row["url"], "headers": secrets})
        else:
            out.append({"name": row["name"], "type": "npm", "package": row["package"], "args": row.get("args") or [], "env": secrets})
    return out


# ── REST для настроек ────────────────────────────────────────────────────────

class ServerBody(BaseModel):
    kind: Optional[Literal["http", "npm"]] = None
    url: Optional[str] = Field(default=None, max_length=500)
    package: Optional[str] = Field(default=None, max_length=200)
    args: Optional[list[str]] = Field(default=None, max_length=20)
    headers: Optional[dict[str, Optional[str]]] = None
    env: Optional[dict[str, Optional[str]]] = None
    enabled: Optional[bool] = None
    note: Optional[str] = Field(default=None, max_length=300)


def _guard(me: Identity) -> None:
    from app.modules.core_chat.router import allowed

    if not allowed(me):
        raise HTTPException(status_code=403, detail="«Ядро» вам пока не включено")
    if not _ready():
        raise HTTPException(status_code=503, detail="MCP агентов ещё не включены на сервере: нужна схема (выкладка с -Schema)")


@router.get("/api/core/mcp-servers")
def get_servers(me: Identity = Depends(current_identity)):
    _guard(me)
    return {"servers": listing(me.user_id)}


@router.put("/api/core/mcp-servers/{name}")
def put_server(name: str, body: ServerBody, me: Identity = Depends(current_identity)):
    _guard(me)
    try:
        save(me.user_id, name, body.model_dump(exclude_none=True), me.display_name)
    except (McpError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"servers": listing(me.user_id)}


@router.delete("/api/core/mcp-servers/{name}")
def delete_server(name: str, me: Identity = Depends(current_identity)):
    _guard(me)
    remove(me.user_id, name)
    return {"servers": listing(me.user_id)}
