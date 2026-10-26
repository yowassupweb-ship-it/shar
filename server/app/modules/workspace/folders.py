"""Папки «Офиса» — личные: каждый раскладывает свой список сам, в том числе чужие материалы, которыми с ним
поделились. Коллеги чужих папок не видят; удаление папки материалы не трогает — они возвращаются в общий список.

  GET    /api/workspace/folders                 мои папки
  POST   /api/workspace/folders                 {title}
  PATCH  /api/workspace/folders/{id}            {title}
  DELETE /api/workspace/folders/{id}
  PUT    /api/workspace/items/{id}/folder       {folderId: id | null} — положить в папку / вынуть
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.security import Identity, current_identity
from app.modules.workspace import store
from app.modules.workspace.store import WorkspaceError

router = APIRouter()

schema.register("workspace_folders", """
CREATE TABLE IF NOT EXISTS workspace_folders (
    id BIGSERIAL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspace_folders_owner ON workspace_folders(owner_id);
CREATE TABLE IF NOT EXISTS workspace_item_folder (
    user_id TEXT NOT NULL,
    item_id BIGINT NOT NULL REFERENCES workspace_items(id) ON DELETE CASCADE,
    folder_id BIGINT NOT NULL REFERENCES workspace_folders(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_item_folder_folder ON workspace_item_folder(folder_id);
""")

MAX_FOLDERS = 200


class FolderBody(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class PlaceBody(BaseModel):
    folderId: Optional[str] = None


def _folders(user_id: str) -> list[dict]:
    rows = db.conn.fetch_all(
        "SELECT f.id::text AS id, f.title, f.created_at::text AS created_at FROM workspace_folders f "
        "WHERE f.owner_id = %s ORDER BY lower(f.title), f.id", (user_id,),
    ) or []
    return [{"id": r["id"], "title": r["title"], "createdAt": r["created_at"]} for r in rows]


def _own(folder_id: Optional[str], user_id: str) -> dict:
    row = db.conn.fetch_one("SELECT id, owner_id FROM workspace_folders WHERE id = %s", (int(folder_id),)) if str(folder_id).isdigit() else None
    if not row or str(row["owner_id"]) != user_id:
        raise HTTPException(status_code=404, detail="Папка не найдена")
    return row


def _title(raw: str) -> str:
    title = raw.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Назовите папку")
    return title


@router.get("/api/workspace/folders")
def list_folders(me: Identity = Depends(current_identity)):
    return {"folders": _folders(me.user_id)}


@router.post("/api/workspace/folders", status_code=201)
def create_folder(body: FolderBody, me: Identity = Depends(current_identity)):
    title = _title(body.title)
    count = db.conn.fetch_one("SELECT count(*) AS n FROM workspace_folders WHERE owner_id = %s", (me.user_id,))["n"]
    if count >= MAX_FOLDERS:
        raise HTTPException(status_code=400, detail="Слишком много папок")
    row = db.conn.fetch_one("INSERT INTO workspace_folders (owner_id, title) VALUES (%s, %s) RETURNING id::text AS id", (me.user_id, title))
    folders = _folders(me.user_id)
    return {"folder": next(f for f in folders if f["id"] == row["id"]), "folders": folders}


@router.patch("/api/workspace/folders/{folder_id}")
def rename_folder(folder_id: str, body: FolderBody, me: Identity = Depends(current_identity)):
    _own(folder_id, me.user_id)
    db.conn.execute_query("UPDATE workspace_folders SET title = %s WHERE id = %s", (_title(body.title), int(folder_id)))
    return {"folders": _folders(me.user_id)}


@router.delete("/api/workspace/folders/{folder_id}")
def delete_folder(folder_id: str, me: Identity = Depends(current_identity)):
    _own(folder_id, me.user_id)
    db.conn.execute_query("DELETE FROM workspace_folders WHERE id = %s", (int(folder_id),))  # раскладка уходит каскадом
    return {"folders": _folders(me.user_id)}


@router.put("/api/workspace/items/{item_id}/folder")
def place_item(item_id: str, body: PlaceBody, me: Identity = Depends(current_identity)):
    try:
        store.get_visible(item_id, me.user_id, content=False)
    except WorkspaceError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc
    if body.folderId:
        _own(body.folderId, me.user_id)
        db.conn.execute_query(
            "INSERT INTO workspace_item_folder (user_id, item_id, folder_id) VALUES (%s, %s, %s) "
            "ON CONFLICT (user_id, item_id) DO UPDATE SET folder_id = EXCLUDED.folder_id",
            (me.user_id, int(item_id), int(body.folderId)),
        )
    else:
        db.conn.execute_query("DELETE FROM workspace_item_folder WHERE user_id = %s AND item_id = %s", (me.user_id, int(item_id)))
    return {"folderId": body.folderId or None}
