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
  PUT    /api/workspace/folders/{id}/shares     {userId | departmentId, role: "view"|"edit"|"move"|null}

Открытая папка — как открытый документ, только сразу на всё, что владелец в неё положил (и во вложенные, и что
положит потом): получатель видит её у себя целиком, с общей раскладкой и порядком. Права получателя:
  view  — смотреть;
  edit  — править документы внутри;
  move  — перемещение и правка: ещё перекладывать материалы и папки внутри открытой ветки, переименовывать
          и заводить в ней папки (их владелец — владелец ветки), класть туда свои материалы — их видят все, кому
          открыта папка (строка раскладки владельца с placed_by = автор). Свой материал автор может забрать обратно.
Участник с «перемещением» удаляет вложенные папки (содержимое поднимается выше) и материалы — в корзину
(store.TRASH_DAYS дней, router.py). Удалить саму открытую ему папку, раздавать доступ и выносить чужой материал из
ветки может только владелец.

Любое изменение раскладки — событие workspace_folders на все устройства владельца: список перестраивается сам.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

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

# Право «перемещение» (move). Сначала роли, столбец placed_by — последним: по нему код понимает, что шаг применён
# (store.move_ready). Индекс по item_id — место материала ищется по нему без user_id (store.owner_place).
schema.register("workspace_folder_move", """
ALTER TABLE workspace_folder_shares DROP CONSTRAINT IF EXISTS workspace_folder_shares_role_check;
ALTER TABLE workspace_folder_shares ADD CONSTRAINT workspace_folder_shares_role_check CHECK (role IN ('view', 'edit', 'move'));
ALTER TABLE workspace_folder_dept_shares DROP CONSTRAINT IF EXISTS workspace_folder_dept_shares_role_check;
ALTER TABLE workspace_folder_dept_shares ADD CONSTRAINT workspace_folder_dept_shares_role_check CHECK (role IN ('view', 'edit', 'move'));
CREATE INDEX IF NOT EXISTS idx_workspace_item_folder_item ON workspace_item_folder(item_id);
ALTER TABLE workspace_item_folder ADD COLUMN IF NOT EXISTS placed_by TEXT;
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
    role: Optional[Literal["view", "edit", "move"]] = None


def _push(users: set[str], payload: dict) -> None:
    try:
        from app.core.realtime import sse_manager  # поздний импорт: realtime тянет много

        for uid in users:
            if uid:
                sse_manager.push(uid, payload)
    except Exception:
        pass


def _changed(user_id: str, *owners: str) -> None:
    """Раскладка изменилась — все устройства владельца и все, кому открыты его папки, перестроят список
    (без содержимого): материал или папка «переезжает» у всех на глазах. owners — чьи ещё раскладки задеты
    (участник с правом «перемещение» меняет раскладку владельца ветки). Не ломает запрос."""
    users = {user_id}
    for owner in {user_id, *owners}:
        users |= {owner} | store.folder_audience(owner)
    _push(users, {"type": "workspace_folders"})


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
            f"JOIN workspace_items i ON i.id = x.item_id AND {store.published_sql('x', 'i')}"
            f"{' AND i.deleted_at IS NULL' if store.trash_ready() else ''} "
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


def _arrange(folder_id: Optional[str], user_id: str, roles: Optional[dict[int, str]] = None) -> dict:
    """Папка, в которой человек раскладывает: своя или открытая ему с правом «перемещение». roles — заранее
    посчитанные открытые папки (store.shared_folder_roles), чтобы цикл по списку не ходил за ними каждый раз."""
    row = db.conn.fetch_one("SELECT id, owner_id, parent_id FROM workspace_folders WHERE id = %s", (int(folder_id),)) if str(folder_id).isdigit() else None
    if row and str(row["owner_id"]) == user_id:
        return row
    role = (roles if roles is not None else store.shared_folder_roles(user_id)).get(int(row["id"])) if row else None
    if not role:
        raise HTTPException(status_code=404, detail="Папка не найдена")
    if role != "move":
        raise HTTPException(status_code=403, detail="В этой папке перекладывать может только владелец или тот, кому дано право «Перемещение»")
    return row


def _scope(user_id: str) -> dict[int, str]:
    """Открытые мне папки (для _arrange). Без шага схемы «перемещение» права move нет ни у кого."""
    return store.shared_folder_roles(user_id) if store.move_ready() else {}


def _place(me: str, item_id: str, folder: dict, position: Any, roles: dict[int, str]) -> None:
    """Положить материал в папку folder (своя или открытая с правом «перемещение»).

    Своя папка — моя раскладка, как раньше. Чужая — раскладка её владельца, которую видят все, кому открыта ветка:
    сюда можно переложить то, что уже лежит в этой ветке (в папке, где у меня «перемещение»), и положить свой
    материал (placed_by = я). Положить чужой материал, которого в ветке нет, нельзя — папкой не раздают чужое."""
    try:
        row = store.get_visible(item_id, me, content=False)
    except WorkspaceError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc
    owner = str(folder["owner_id"])
    item = int(item_id)
    mine = str(row["owner_id"]) == me
    if owner == me:
        db.conn.execute_query(
            "INSERT INTO workspace_item_folder (user_id, item_id, folder_id, position) VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (user_id, item_id) DO UPDATE SET folder_id = EXCLUDED.folder_id, position = EXCLUDED.position",
            (me, item, int(folder["id"]), position),
        )
        if mine and store.move_ready():
            # Своё — в свою папку: из чужой ветки, куда я его клал, материал уходит (у материала одно общее место).
            db.conn.execute_query("DELETE FROM workspace_item_folder WHERE item_id = %s AND placed_by = %s AND user_id <> %s", (item, me, me))
        return
    if mine:
        # Свой материал — в открытую мне ветку: место в раскладке владельца ветки, положил я.
        db.conn.execute_query("DELETE FROM workspace_item_folder WHERE item_id = %s AND (user_id = %s OR (placed_by = %s AND user_id <> %s))", (item, me, me, owner))
        db.conn.execute_query(
            "INSERT INTO workspace_item_folder (user_id, item_id, folder_id, position, placed_by) VALUES (%s, %s, %s, %s, %s) "
            "ON CONFLICT (user_id, item_id) DO UPDATE SET folder_id = EXCLUDED.folder_id, position = EXCLUDED.position, placed_by = EXCLUDED.placed_by",
            (owner, item, int(folder["id"]), position, me),
        )
        return
    place = db.conn.fetch_one(
        f"SELECT x.folder_id FROM workspace_item_folder x JOIN workspace_items i ON i.id = x.item_id "
        f"WHERE x.item_id = %s AND x.user_id = %s AND {store.published_sql('x', 'i')}", (item, owner))
    if not place or roles.get(int(place["folder_id"])) != "move":
        raise HTTPException(status_code=403, detail="Чужой материал можно перекладывать только внутри папки, где у вас право «Перемещение»")
    db.conn.execute_query("UPDATE workspace_item_folder SET folder_id = %s, position = %s WHERE user_id = %s AND item_id = %s",
                          (int(folder["id"]), position, owner, item))
    # Моё личное место для этого материала больше не нужно — он виден там, куда я его переложил.
    db.conn.execute_query("DELETE FROM workspace_item_folder WHERE user_id = %s AND item_id = %s", (me, item))


def _withdraw(me: str, item_id: str) -> None:
    """Свой материал, положенный в чужую открытую ветку, автор может забрать обратно."""
    if store.move_ready():
        db.conn.execute_query(
            "DELETE FROM workspace_item_folder x USING workspace_items i WHERE i.id = x.item_id AND x.item_id = %s "
            "AND x.placed_by = %s AND i.owner_id = %s AND x.user_id <> %s", (int(item_id), me, me, me))


def _title(raw: str) -> str:
    title = raw.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Назовите папку")
    return title


def _check_parent(parent_id: str, user_id: str, moving: Optional[dict] = None, roles: Optional[dict[int, str]] = None) -> int:
    """Папка-родитель: своя или с правом «перемещение», того же владельца, что перекладываемая папка moving,
    не она сама и не внутри неё, не глубже MAX_DEPTH."""
    parent = _arrange(parent_id, user_id, roles)
    if moving is not None and str(parent["owner_id"]) != str(moving["owner_id"]):
        raise HTTPException(status_code=400, detail="Папку можно переложить только в папку того же владельца")
    moving_id = moving["id"] if moving is not None else None
    depth, cur = 1, int(parent_id)
    while cur is not None:
        if moving_id is not None and cur == int(moving_id):
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
    roles = _scope(me.user_id)
    parent = _check_parent(body.parentId, me.user_id, roles=roles) if body.parentId else None
    # Папка внутри чужой ветки (право «перемещение») — часть ветки: владелец у неё тот же, доступ наследуется.
    owner = str(_arrange(body.parentId, me.user_id, roles)["owner_id"]) if body.parentId else me.user_id
    count = db.conn.fetch_one("SELECT count(*) AS n FROM workspace_folders WHERE owner_id = %s", (owner,))["n"]
    if count >= MAX_FOLDERS:
        raise HTTPException(status_code=400, detail="Слишком много папок")
    row = db.conn.fetch_one(
        "INSERT INTO workspace_folders (owner_id, title, parent_id, position) VALUES (%s, %s, %s, "
        "(SELECT COALESCE(max(position), -1) + 1 FROM workspace_folders WHERE owner_id = %s AND parent_id IS NOT DISTINCT FROM %s)) "
        "RETURNING id::text AS id", (owner, title, parent, owner, parent))
    _changed(me.user_id, owner)
    folders = _folders(me.user_id)
    return {"folder": next(f for f in folders if f["id"] == row["id"]), "folders": folders}


@router.patch("/api/workspace/folders/{folder_id}")
def change_folder(folder_id: str, body: FolderPatch, me: Identity = Depends(current_identity)):
    roles = _scope(me.user_id)
    folder = _arrange(folder_id, me.user_id, roles)
    owner = str(folder["owner_id"])
    if "parentId" in body.model_fields_set:
        if not body.parentId and owner != me.user_id:
            raise HTTPException(status_code=403, detail="Вынести папку из открытой вам ветки может только владелец")
        parent = _check_parent(body.parentId, me.user_id, moving=folder, roles=roles) if body.parentId else None
    if body.title is not None:
        db.conn.execute_query("UPDATE workspace_folders SET title = %s WHERE id = %s", (_title(body.title), int(folder_id)))
    if "parentId" in body.model_fields_set:
        db.conn.execute_query("UPDATE workspace_folders SET parent_id = %s WHERE id = %s", (parent, int(folder_id)))
    _changed(me.user_id, owner)
    return {"folders": _folders(me.user_id)}


@router.delete("/api/workspace/folders/{folder_id}")
def delete_folder(folder_id: str, me: Identity = Depends(current_identity)):
    """Своя папка — всегда; в открытой ветке с правом «перемещение» — вложенная (саму открытую вам папку — нет)."""
    roles = _scope(me.user_id)
    folder = _arrange(folder_id, me.user_id, roles)
    owner = str(folder["owner_id"])
    parent = folder.get("parent_id")
    if owner != me.user_id and (parent is None or roles.get(int(parent)) != "move"):
        raise HTTPException(status_code=403, detail="Открытую вам папку удалить может только владелец — вложенные в неё можно")
    # Содержимое — на уровень выше: вложенные папки к родителю удаляемой, материалы в родителя (с верхнего уровня —
    # раскладка удаляется каскадом, и материалы возвращаются в общий список).
    db.conn.execute_query("UPDATE workspace_folders SET parent_id = %s WHERE parent_id = %s", (parent, int(folder_id)))
    if parent is not None:
        db.conn.execute_query("UPDATE workspace_item_folder SET folder_id = %s WHERE folder_id = %s", (parent, int(folder_id)))
    db.conn.execute_query("DELETE FROM workspace_folders WHERE id = %s", (int(folder_id),))
    _changed(me.user_id, owner)
    return {"folders": _folders(me.user_id)}


def _shares_payload(folder_id: str) -> dict:
    parent = db.conn.fetch_one("SELECT parent_id FROM workspace_folders WHERE id = %s", (int(folder_id),)) or {}
    users = db.conn.fetch_all("SELECT user_id, role FROM workspace_folder_shares WHERE folder_id = %s ORDER BY created_at", (int(folder_id),)) or []
    names = {str(u["id"]): u.get("name") or u.get("username") or "" for u in (db.conn.fetch_all(
        "SELECT id, name, username FROM users WHERE id = ANY(%s)", ([str(r["user_id"]) for r in users],)) or [])} if users else {}
    dept_names = {str(d["id"]): d["name"] for d in (db.get_departments() or [])}
    depts = db.conn.fetch_all("SELECT department_id, role FROM workspace_folder_dept_shares WHERE folder_id = %s ORDER BY created_at", (int(folder_id),)) or []
    return {
        "shares": [{"userId": str(r["user_id"]), "role": r["role"], "name": names.get(str(r["user_id"]), "")} for r in users],
        "departments": [{"departmentId": str(d["department_id"]), "role": d["role"], "name": dept_names.get(str(d["department_id"]), str(d["department_id"])),
                         "members": len(store.dept_members([str(d["department_id"])]))} for d in depts],
        # Выдано выше по дереву и действует здесь тоже: видно в окне, но снимается в той папке.
        "inherited": store.inherited_shares(parent.get("parent_id")),
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
    if body.role == "move" and not store.move_ready():
        raise HTTPException(status_code=503, detail="Право «Перемещение» ещё не включено на сервере")
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
    """Порядок папок на одном уровне — как в ids. Папка из другого места переносится сюда (с проверкой на цикл).
    В открытой ветке с правом «перемещение» — так же, но только внутри ветки. На моём верхнем уровне верх чужой
    ветки лежит сам по себе: его место не трогаем."""
    roles = _scope(me.user_id)
    parent = int(body.parentId) if body.parentId else None
    owners = {me.user_id}
    if body.parentId:
        owners.add(str(_arrange(body.parentId, me.user_id, roles)["owner_id"]))
    for index, folder_id in enumerate(body.ids):
        if not body.parentId:
            row = db.conn.fetch_one("SELECT owner_id, parent_id FROM workspace_folders WHERE id = %s", (int(folder_id),)) if str(folder_id).isdigit() else None
            if row and str(row["owner_id"]) != me.user_id and (row["parent_id"] is None or int(row["parent_id"]) not in roles):
                continue
        folder = _arrange(folder_id, me.user_id, roles)
        if not body.parentId and str(folder["owner_id"]) != me.user_id:
            raise HTTPException(status_code=403, detail="Вынести папку из открытой вам ветки может только владелец")
        owners.add(str(folder["owner_id"]))
        target = parent
        if folder.get("parent_id") != parent:
            target = _check_parent(body.parentId, me.user_id, moving=folder, roles=roles) if body.parentId else None
        db.conn.execute_query("UPDATE workspace_folders SET parent_id = %s, position = %s WHERE id = %s", (target, index, int(folder_id)))
    _changed(*owners)
    return {"folders": _folders(me.user_id)}


@router.put("/api/workspace/folders/{folder_id}/order")
def order_items(folder_id: str, body: ItemOrderBody, me: Identity = Depends(current_identity)):
    """Порядок материалов в папке — как в ids. Материал из другого места кладётся в эту папку (правила — _place)."""
    roles = _scope(me.user_id)
    folder = _arrange(folder_id, me.user_id, roles)
    for index, item_id in enumerate(body.ids):
        _place(me.user_id, item_id, folder, index, roles)
    _changed(me.user_id, str(folder["owner_id"]))
    return {"ok": True}


@router.put("/api/workspace/root/order")
def order_root(body: ItemOrderBody, me: Identity = Depends(current_identity)):
    """Порядок материалов вне папок — как в ids. Материал из своей папки при этом из неё выходит, свой — и из
    чужой открытой ветки, куда я его клал."""
    if not store.table_ready("workspace_item_root_order"):
        raise HTTPException(status_code=503, detail="Порядок вне папок ещё не включён на сервере")
    owners = {me.user_id}
    for index, item_id in enumerate(body.ids):
        try:
            store.get_visible(item_id, me.user_id, content=False)
        except WorkspaceError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
        place = store.owner_place(item_id) or {}
        if place.get("folder_owner"):
            owners.add(str(place["folder_owner"]))
        db.conn.execute_query("DELETE FROM workspace_item_folder WHERE user_id = %s AND item_id = %s", (me.user_id, int(item_id)))
        _withdraw(me.user_id, item_id)
        db.conn.execute_query(
            "INSERT INTO workspace_item_root_order (user_id, item_id, position) VALUES (%s, %s, %s) "
            "ON CONFLICT (user_id, item_id) DO UPDATE SET position = EXCLUDED.position",
            (me.user_id, int(item_id), index),
        )
    _changed(*owners)
    return {"ok": True}


@router.put("/api/workspace/items/{item_id}/folder")
def place_item(item_id: str, body: PlaceBody, me: Identity = Depends(current_identity)):
    """Положить в папку (в конец) — свою или открытую с правом «перемещение» (правила — _place); folderId: null — вынуть."""
    try:
        store.get_visible(item_id, me.user_id, content=False)
    except WorkspaceError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc
    owners = {me.user_id}
    if body.folderId:
        roles = _scope(me.user_id)
        folder = _arrange(body.folderId, me.user_id, roles)
        owners.add(str(folder["owner_id"]))
        last = db.conn.fetch_one("SELECT COALESCE(max(position), -1) + 1 AS n FROM workspace_item_folder WHERE user_id = %s AND folder_id = %s",
                                 (str(folder["owner_id"]), int(body.folderId)))
        _place(me.user_id, item_id, folder, last["n"], roles)
    else:
        place = store.owner_place(item_id) or {}
        db.conn.execute_query("DELETE FROM workspace_item_folder WHERE user_id = %s AND item_id = %s", (me.user_id, int(item_id)))
        _withdraw(me.user_id, item_id)
        if place.get("folder_owner"):
            owners.add(str(place["folder_owner"]))
    _changed(*owners)
    return {"folderId": body.folderId or None}
