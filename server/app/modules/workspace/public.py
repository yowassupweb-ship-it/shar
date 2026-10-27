"""Материалы по ссылке — без входа в Шар.

Токен выдаёт владелец (router.py: /links): один на режим view или edit. Открывшему доступны только
этот материал и только то, что позволяет режим. Путь /api/share/ внесён в PUBLIC_PREFIXES
(core/security.py) — личность тут не нужна, нужен токен.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.db import db
from app.modules.workspace import store
from app.modules.workspace.store import WorkspaceError

router = APIRouter()

_TOKEN = re.compile(r"^[A-Za-z0-9_-]{24,64}$")


class SharedPatch(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    baseUpdatedAt: Optional[str] = None


def _link(token: str) -> dict[str, Any]:
    if not _TOKEN.match(token):
        raise HTTPException(status_code=404, detail="Ссылка не найдена")
    link = db.conn.fetch_one("SELECT item_id, mode FROM workspace_item_links WHERE token = %s", (token,))
    if not link:
        raise HTTPException(status_code=404, detail="Ссылка не найдена или отозвана")
    return link


def _shared_view(row: dict[str, Any], mode: str) -> dict[str, Any]:
    return {
        "mode": mode,
        "item": {
            "id": row["id"], "kind": row["kind"], "title": row["title"], "content": row["content"],
            "meta": row["meta"] or {}, "updatedAt": row["updated_at"],
        },
    }


@router.get("/api/share/workspace/{token}")
def open_shared(token: str):
    link = _link(token)
    row = store.get_row(str(link["item_id"]))
    if not row:
        raise HTTPException(status_code=404, detail="Материал удалён")
    db.conn.execute_query("UPDATE workspace_item_links SET last_used_at = now() WHERE token = %s", (token,))
    return _shared_view(row, link["mode"])


@router.patch("/api/share/workspace/{token}")
def save_shared(token: str, body: SharedPatch):
    link = _link(token)
    if link["mode"] != "edit":
        raise HTTPException(status_code=403, detail="Эта ссылка — только для просмотра")
    row = store.get_row(str(link["item_id"]))
    if not row:
        raise HTTPException(status_code=404, detail="Материал удалён")
    sets: list[str] = []
    params: list[Any] = []
    new_key = ""
    try:
        if body.title is not None:
            sets.append("title = %s")
            params.append(body.title.strip()[:200])
        if body.content is not None:
            store.validate_content(row["kind"], body.content, shared=True)
            parts, values, new_key = store.content_sets(int(row["id"]), body.content)
            sets += parts + ["text_content = %s", "updated_by = 'link'"] + (["updated_via = ''"] if store.via_ready() else [])
            params += values + [store.text_of(row["kind"], body.content)]
    except WorkspaceError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc
    if not sets:
        return _shared_view(row, link["mode"])
    sets.append("updated_at = now()")
    sql = f"UPDATE workspace_items SET {', '.join(sets)} WHERE id = %s"
    params.append(int(row["id"]))
    if body.baseUpdatedAt and body.content is not None:
        sql += " AND updated_at::text = %s"
        params.append(body.baseUpdatedAt)
    saved = db.conn.fetch_one(sql + " RETURNING id", tuple(params))
    taken = bool(saved) and body.content is not None and store.snapshot(row, "link")
    if new_key:
        store.finish_content(new_key, "" if taken else (row.get("content_key") or ""), saved=bool(saved))
    if not saved:
        raise HTTPException(status_code=409, detail="Материал изменили, пока вы правили")
    if body.content is not None or body.title is not None:
        live = store.get_row(str(row["id"]), full=False)
        store.push_to_viewers(str(row["id"]), {"type": "workspace_changed", "reason": "content", "itemId": str(row["id"]), "kind": row["kind"],
                                               "updatedAt": live["updated_at"], "by": "Гость по ссылке", "byId": "link"})
    db.conn.execute_query("UPDATE workspace_item_links SET last_used_at = now() WHERE token = %s", (token,))
    return _shared_view(store.get_row(str(row["id"])), link["mode"])
