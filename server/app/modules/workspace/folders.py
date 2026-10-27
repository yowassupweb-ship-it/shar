"""Папки «Офиса» — личные: каждый раскладывает свой список сам, в том числе чужие материалы, которыми с ним
поделились. Коллеги чужих папок не видят. Папки вкладываются друг в друга (parent_id); удаление папки материалы
не трогает — её вложенные папки и материалы поднимаются на уровень выше (с верхнего уровня — в общий список).

  GET    /api/workspace/folders                 мои папки (плоским списком, у каждой parentId и counts по видам)
  POST   /api/workspace/folders                 {title, parentId?}
  PATCH  /api/workspace/folders/{id}            {title?, parentId?} — переименовать / переложить (parentId: null — наверх)
  DELETE /api/workspace/folders/{id}
  PUT    /api/workspace/folders/order           {parentId, ids} — порядок папок на уровне (и перенос туда же)
  PUT    /api/workspace/folders/{id}/order      {ids} — порядок материалов в папке (и перенос в неё)
  PUT    /api/workspace/items/{id}/folder       {folderId: id | null} — положить в папку (в конец) / вынуть
  PUT    /api/workspace/root/order              {ids} — порядок материалов вне папок (и вынуть их туда из папок)
  GET    /api/workspace/folders/{id}/shares     кому открыта папка (поимённо и отделам)
  PUT    /api/workspace/folders/{id}/shares     {userId | departmentId, role: "view"|"edit"|null}

Открытая папка — как открытый документ, только сразу на всё, что владелец в неё положил (и во вложенные, и что
положит потом): получатель видит её у себя целиком, с общей раскладкой и порядком. Менять папку (название,
состав, порядок, доступ) может только владелец; «правка» даёт править документы внутри.

Любое изменение раскладки — событие workspace_folders на все устройства владельца: список перестраивается сам.
"""

from __future__ import annotations

from typing import Literal, Optional

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
ALTER TABLE workspace_folders ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES workspace_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_folders_parent ON workspace_folders(parent_id);
ALTER TABLE workspace_folders ADD COLUMN IF NOT EXISTS position DOUBLE PRECISION;
ALTER TABLE workspace_item_folder ADD COLUMN IF NOT EXISTS position DOUBLE PRECISION;
CREATE TABLE IF NOT EXISTS workspace_folder_shares (
    folder_id BIGINT NOT NULL REFERENCES workspace_folders(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (folder_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_folder_shares_user ON workspace_folder_shares(user_id);
CREATE TABLE IF NOT EXISTS workspace_folder_dept_shares (
    folder_id BIGINT NOT NULL REFERENCES workspace_folders(id) ON DELETE CASCADE,
    department_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (folder_id, department_id)
);
-- Ручной порядок материалов вне папок (у каждого свой, как и раскладка по папкам).
CREATE TABLE IF NOT EXISTS workspace_item_root_order (
    user_id TEXT NOT NULL,
    item_id BIGINT NOT NULL REFERENCES workspace_items(id) ON DELETE CASCADE,
    position DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (user_id, item_id)
);
""")

MAX_FOLDERS = 200
MAX_DEPTH = 8


class FolderBody(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    parentId: Optional[str] = None


class FolderPatch(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    parentId: Optional[str] = None


class PlaceBody(BaseModel):
    folderId: Optional[str] = None


class FolderOrderBody(BaseModel):
    parentId: Optional[str] = None
    ids: list[str] = Field(max_length=MAX_FOLDERS)


class ItemOrderBody(BaseModel):
    ids: list[str] = Field(max_length=2000)


class FolderShareBody(BaseModel):
    userId: Optional[str] = None
    departmentId: Optional[str] = None
    role: Optional[Literal["view", "edit"]] = None


def _push(users: set[str], payload: dict) -> None:
    try:
        from app.core.realtime import sse_manager  # поздний импорт: realtime тянет много

        for uid in users:
            if uid:
                sse_manager.push(uid, payload)
    except Exception:
        pass


def _changed(user_id: str) -> None:
    """Раскладка изменилась — все устройства владельца и все, кому открыты его папки, перестроят список
    (без содержимого): материал или папка «переезжает» у всех на глазах. Не ломает запрос."""
    _push({user_id} | store.folder_audience(user_id), {"type": "workspace_folders"})


def _folders(user_id: str) -> list[dict]:
    roles = store.shared_folder_roles(user_id)
    rows = db.conn.fetch_all(
        "SELECT f.id::text AS id, f.parent_id::text AS parent_id, f.title, f.position, f.created_at::text AS created_at, f.owner_id, "
        "(SELECT count(*) FROM workspace_folder_shares s WHERE s.folder_id = f.id) "
        "+ (SELECT count(*) FROM workspace_folder_dept_shares d WHERE d.folder_id = f.id) AS shares "
        "FROM workspace_folders f WHERE f.owner_id = %s OR f.id = ANY(%s) ORDER BY f.position NULLS LAST, lower(f.title), f.id",
        (user_id, list(roles)),
    ) or []
    accessible = {r["id"] for r in rows}
    owner_ids = sorted({str(r["owner_id"]) for r in rows if str(r["owner_id"]) != user_id})
    owners = {str(u["id"]): u.get("name") or u.get("username") or "" for u in (db.conn.fetch_all("SELECT id, name, username FROM users WHERE id = ANY(%s)", (owner_ids,)) or [])} if owner_ids else {}
    # Сколько своих разложенных материалов каждого вида лежит прямо в папке (видимых человеку): раздел «Доки»
    # показывает папку, только если в ней (или во вложенных) есть документы; совсем пустая видна везде.
    counts: dict[str, dict[str, int]] = {}
    for c in db.conn.fetch_all(
        "SELECT x.folder_id::text AS folder_id, i.kind, count(*) AS n FROM workspace_item_folder x "
        f"JOIN workspace_items i ON i.id = x.item_id WHERE x.user_id = %s AND {store.visible_sql('i')} GROUP BY 1, 2",
        (user_id, *store.visible_params(user_id)),
    ) or []:
        counts.setdefault(c["folder_id"], {})[c["kind"]] = int(c["n"])
    # В открытых мне папках считаем по раскладке владельца (её материалы мне видны через папку).
    if roles:
        for c in db.conn.fetch_all(
            "SELECT x.folder_id::text AS folder_id, i.kind, count(*) AS n FROM workspace_item_folder x "
            "JOIN workspace_items i ON i.id = x.item_id AND i.owner_id = x.user_id "
            "WHERE x.folder_id = ANY(%s) GROUP BY 1, 2", (list(roles),),
        ) or []:
            counts.setdefault(c["folder_id"], {})[c["kind"]] = int(c["n"])
    out = []
    for r in rows:
        mine = str(r["owner_id"]) == user_id
        out.append({
            "id": r["id"],
            # Верх открытой мне ветки — у меня на верхнем уровне (родитель-то мне не открыт).
            "parentId": r["parent_id"] if (mine or r["parent_id"] in accessible) else None,
            "title": r["title"], "position": r["position"], "createdAt": r["created_at"],
            "counts": counts.get(r["id"], {}),
            "ownerId": str(r["owner_id"]), "ownerName": "" if mine else owners.get(str(r["owner_id"]), ""),
            "role": "owner" if mine else roles.get(int(r["id"]), "view"),
            "shares": int(r["shares"] or 0) if mine else 0,
        })
    return out


def _own(folder_id: Optional[str], user_id: str) -> dict:
    row = db.conn.fetch_one("SELECT id, owner_id, parent_id FROM workspace_folders WHERE id = %s", (int(folder_id),)) if str(folder_id).isdigit() else None
    if not row or str(row["owner_id"]) != user_id:
        raise HTTPException(status_code=404, detail="Папка не найдена")
    return row


def _title(raw: str) -> str:
    title = raw.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Назовите папку")
    return title


def _check_parent(parent_id: str, user_id: str, moving: Optional[str] = None) -> int:
    """Папка-родитель: своя, не сама перекладываемая и не внутри неё, не глубже MAX_DEPTH."""
    _own(parent_id, user_id)
    depth, cur = 1, int(parent_id)
    while cur is not None:
        if moving is not None and cur == int(moving):
            raise HTTPException(status_code=400, detail="Папку нельзя положить в саму себя или во вложенную в неё")
        depth += 1
        if depth > MAX_DEPTH:
            raise HTTPException(status_code=400, detail=f"Не глубже {MAX_DEPTH} уровней")
        row = db.conn.fetch_one("SELECT parent_id FROM workspace_folders WHERE id = %s", (cur,))
        cur = row["parent_id"] if row else None
    return int(parent_id)


@router.get("/api/workspace/folders")
def list_folders(me: Identity = Depends(current_identity)):
    return {"folders": _folders(me.user_id)}


@router.post("/api/workspace/folders", status_code=201)
def create_folder(body: FolderBody, me: Identity = Depends(current_identity)):
    title = _title(body.title)
    count = db.conn.fetch_one("SELECT count(*) AS n FROM workspace_folders WHERE owner_id = %s", (me.user_id,))["n"]
    if count >= MAX_FOLDERS:
        raise HTTPException(status_code=400, detail="Слишком много папок")
    parent = _check_parent(body.parentId, me.user_id) if body.parentId else None
    row = db.conn.fetch_one(
        "INSERT INTO workspace_folders (owner_id, title, parent_id, position) VALUES (%s, %s, %s, "
        "(SELECT COALESCE(max(position), -1) + 1 FROM workspace_folders WHERE owner_id = %s AND parent_id IS NOT DISTINCT FROM %s)) "
        "RETURNING id::text AS id", (me.user_id, title, parent, me.user_id, parent))
    _changed(me.user_id)
    folders = _folders(me.user_id)
    return {"folder": next(f for f in folders if f["id"] == row["id"]), "folders": folders}


@router.patch("/api/workspace/folders/{folder_id}")
def change_folder(folder_id: str, body: FolderPatch, me: Identity = Depends(current_identity)):
    _own(folder_id, me.user_id)
    if body.title is not None:
        db.conn.execute_query("UPDATE workspace_folders SET title = %s WHERE id = %s", (_title(body.title), int(folder_id)))
    if "parentId" in body.model_fields_set:
        parent = _check_parent(body.parentId, me.user_id, moving=folder_id) if body.parentId else None
        db.conn.execute_query("UPDATE workspace_folders SET parent_id = %s WHERE id = %s", (parent, int(folder_id)))
    _changed(me.user_id)
    return {"folders": _folders(me.user_id)}


@router.delete("/api/workspace/folders/{folder_id}")
def delete_folder(folder_id: str, me: Identity = Depends(current_identity)):
    folder = _own(folder_id, me.user_id)
    parent = folder.get("parent_id")
    # Содержимое — на уровень выше: вложенные папки к родителю удаляемой, материалы в родителя (с верхнего уровня —
    # раскладка удаляется каскадом, и материалы возвращаются в общий список).
    db.conn.execute_query("UPDATE workspace_folders SET parent_id = %s WHERE parent_id = %s", (parent, int(folder_id)))
    if parent is not None:
        db.conn.execute_query("UPDATE workspace_item_folder SET folder_id = %s WHERE folder_id = %s", (parent, int(folder_id)))
    db.conn.execute_query("DELETE FROM workspace_folders WHERE id = %s", (int(folder_id),))
    _changed(me.user_id)
    return {"folders": _folders(me.user_id)}


def _shares_payload(folder_id: str) -> dict:
    users = db.conn.fetch_all("SELECT user_id, role FROM workspace_folder_shares WHERE folder_id = %s ORDER BY created_at", (int(folder_id),)) or []
    names = {str(u["id"]): u.get("name") or u.get("username") or "" for u in (db.conn.fetch_all(
        "SELECT id, name, username FROM users WHERE id = ANY(%s)", ([str(r["user_id"]) for r in users],)) or [])} if users else {}
    dept_names = {str(d["id"]): d["name"] for d in (db.get_departments() or [])}
    depts = db.conn.fetch_all("SELECT department_id, role FROM workspace_folder_dept_shares WHERE folder_id = %s ORDER BY created_at", (int(folder_id),)) or []
    return {
        "shares": [{"userId": str(r["user_id"]), "role": r["role"], "name": names.get(str(r["user_id"]), "")} for r in users],
        "departments": [{"departmentId": str(d["department_id"]), "role": d["role"], "name": dept_names.get(str(d["department_id"]), str(d["department_id"])),
                         "members": len(store.dept_members([str(d["department_id"])]))} for d in depts],
    }


@router.get("/api/workspace/folders/{folder_id}/shares")
def folder_shares(folder_id: str, me: Identity = Depends(current_identity)):
    _own(folder_id, me.user_id)
    return _shares_payload(folder_id)


@router.put("/api/workspace/folders/{folder_id}/shares")
def set_folder_share(folder_id: str, body: FolderShareBody, me: Identity = Depends(current_identity)):
    """Открыть папку человеку или отделу (или убрать доступ: role = null). Получатели видят её сразу."""
    _own(folder_id, me.user_id)
    if bool(body.userId) == bool(body.departmentId):
        raise HTTPException(status_code=400, detail="Укажите человека или отдел")
    if body.userId:
        if body.userId == me.user_id:
            raise HTTPException(status_code=400, detail="Владельцу доступ выдавать не нужно")
        if not db.get_user_by_id(body.userId):
            raise HTTPException(status_code=404, detail="Человек не найден")
        affected, table, column, key = {body.userId}, "workspace_folder_shares", "user_id", body.userId
    else:
        if not db.get_department(body.departmentId):
            raise HTTPException(status_code=404, detail="Отдел не найден")
        affected, table, column, key = store.dept_members([body.departmentId]), "workspace_folder_dept_shares", "department_id", body.departmentId
    if body.role is None:
        db.conn.execute_query(f"DELETE FROM {table} WHERE folder_id = %s AND {column} = %s", (int(folder_id), key))
    else:
        db.conn.execute_query(
            f"INSERT INTO {table} (folder_id, {column}, role) VALUES (%s, %s, %s) "
            f"ON CONFLICT (folder_id, {column}) DO UPDATE SET role = EXCLUDED.role", (int(folder_id), key, body.role))
    title = (db.conn.fetch_one("SELECT title FROM workspace_folders WHERE id = %s", (int(folder_id),)) or {}).get("title") or ""
    by = (db.get_user_by_id(me.user_id) or {}).get("name") or ""
    # Получатели: папка появляется (или исчезает) у них сразу; тем, кому открыли, — уведомление.
    _push(affected - {me.user_id}, {"type": "workspace_folders", "reason": "shared" if body.role else "changed", "title": title, "by": by})
    _push({me.user_id}, {"type": "workspace_folders"})
    return _shares_payload(folder_id)


@router.put("/api/workspace/folders/order")
def order_folders(body: FolderOrderBody, me: Identity = Depends(current_identity)):
    """Порядок папок на одном уровне — как в ids. Папка из другого места переносится сюда (с проверкой на цикл)."""
    parent = int(body.parentId) if body.parentId else None
    if body.parentId:
        _own(body.parentId, me.user_id)
    for index, folder_id in enumerate(body.ids):
        folder = _own(folder_id, me.user_id)
        if folder.get("parent_id") != parent:
            parent = _check_parent(body.parentId, me.user_id, moving=folder_id) if body.parentId else None
        db.conn.execute_query("UPDATE workspace_folders SET parent_id = %s, position = %s WHERE id = %s", (parent, index, int(folder_id)))
    _changed(me.user_id)
    return {"folders": _folders(me.user_id)}


@router.put("/api/workspace/folders/{folder_id}/order")
def order_items(folder_id: str, body: ItemOrderBody, me: Identity = Depends(current_identity)):
    """Порядок материалов в папке — как в ids. Материал из другого места кладётся в эту папку."""
    _own(folder_id, me.user_id)
    for index, item_id in enumerate(body.ids):
        try:
            store.get_visible(item_id, me.user_id, content=False)
        except WorkspaceError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
        db.conn.execute_query(
            "INSERT INTO workspace_item_folder (user_id, item_id, folder_id, position) VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (user_id, item_id) DO UPDATE SET folder_id = EXCLUDED.folder_id, position = EXCLUDED.position",
            (me.user_id, int(item_id), int(folder_id), index),
        )
    _changed(me.user_id)
    return {"ok": True}


@router.put("/api/workspace/root/order")
def order_root(body: ItemOrderBody, me: Identity = Depends(current_identity)):
    """Порядок материалов вне папок — как в ids. Материал из своей папки при этом из неё выходит."""
    if not store.table_ready("workspace_item_root_order"):
        raise HTTPException(status_code=503, detail="Порядок вне папок ещё не включён на сервере")
    for index, item_id in enumerate(body.ids):
        try:
            store.get_visible(item_id, me.user_id, content=False)
        except WorkspaceError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
        db.conn.execute_query("DELETE FROM workspace_item_folder WHERE user_id = %s AND item_id = %s", (me.user_id, int(item_id)))
        db.conn.execute_query(
            "INSERT INTO workspace_item_root_order (user_id, item_id, position) VALUES (%s, %s, %s) "
            "ON CONFLICT (user_id, item_id) DO UPDATE SET position = EXCLUDED.position",
            (me.user_id, int(item_id), index),
        )
    _changed(me.user_id)
    return {"ok": True}


@router.put("/api/workspace/items/{item_id}/folder")
def place_item(item_id: str, body: PlaceBody, me: Identity = Depends(current_identity)):
    try:
        store.get_visible(item_id, me.user_id, content=False)
    except WorkspaceError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc
    if body.folderId:
        _own(body.folderId, me.user_id)
        db.conn.execute_query(
            "INSERT INTO workspace_item_folder (user_id, item_id, folder_id, position) VALUES (%s, %s, %s, "
            "(SELECT COALESCE(max(position), -1) + 1 FROM workspace_item_folder WHERE user_id = %s AND folder_id = %s)) "
            "ON CONFLICT (user_id, item_id) DO UPDATE SET folder_id = EXCLUDED.folder_id, position = EXCLUDED.position",
            (me.user_id, int(item_id), int(body.folderId), me.user_id, int(body.folderId)),
        )
    else:
        db.conn.execute_query("DELETE FROM workspace_item_folder WHERE user_id = %s AND item_id = %s", (me.user_id, int(item_id)))
    _changed(me.user_id)
    return {"folderId": body.folderId or None}
