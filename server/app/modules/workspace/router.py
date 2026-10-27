"""Заметки, документы, таблицы и презентации: список, правка, доступ, ссылки.

  GET    /api/workspace/items?kind=&q=&templates=      список (без содержимого)
  POST   /api/workspace/items                          создать {kind, title?, content?, meta?, templateId?}
  GET    /api/workspace/items/{id}                     целиком
  PATCH  /api/workspace/items/{id}                     {title?, content?, meta?, pinned?, isTemplate?, accessLevel?, accessMode?, baseUpdatedAt?}
  DELETE /api/workspace/items/{id}                     только владелец
  GET    /api/workspace/items/{id}/shares              кому выдано: поимённо и отделам
  PUT    /api/workspace/items/{id}/shares              {userId | departmentId, role: "view"|"edit"|null}
  GET    /api/workspace/items/{id}/links               ссылки без входа
  POST   /api/workspace/items/{id}/links               {mode, regenerate?}
  DELETE /api/workspace/items/{id}/links/{mode}        отозвать

  POST   /api/workspace/items/{id}/presence            {state: join|beat|leave, editing}: кто сейчас в материале
  GET    /api/workspace/items/{id}/versions            история версий
  GET    /api/workspace/items/{id}/versions/{vid}      содержимое версии
  POST   /api/workspace/items/{id}/versions            {label?}: сохранить версию сейчас
  POST   /api/workspace/items/{id}/versions/{vid}/restore   вернуть версию (текущее состояние тоже остаётся в истории)

  GET|PATCH /api/share/workspace/{token}               то же по ссылке, без входа (public.py)
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.db import db
from app.core.security import Identity, current_identity
from app.modules.workspace import store
from app.modules.workspace.store import WorkspaceError, ACCESS_LEVELS, ACCESS_MODES, KINDS

router = APIRouter()


def _raise(exc: WorkspaceError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.message)


class ItemCreate(BaseModel):
    kind: Literal["note", "table", "document", "presentation"]
    title: str = ""
    content: str = ""
    meta: Optional[dict[str, Any]] = None
    templateId: Optional[str] = None


class ItemPatch(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    meta: Optional[dict[str, Any]] = None
    pinned: Optional[bool] = None
    isTemplate: Optional[bool] = None
    accessLevel: Optional[str] = None
    accessMode: Optional[str] = None
    baseUpdatedAt: Optional[str] = None


class ShareBody(BaseModel):
    userId: Optional[str] = None
    departmentId: Optional[str] = None
    role: Optional[Literal["view", "edit"]] = None


class PresenceBody(BaseModel):
    state: Literal["join", "beat", "leave"] = "beat"
    editing: bool = False


class VersionBody(BaseModel):
    label: str = ""


class LinkBody(BaseModel):
    mode: Literal["view", "edit"]
    regenerate: bool = False


@router.get("/api/workspace/items")
def list_items(kind: Optional[str] = None, q: str = "", templates: bool = False, limit: int = 300, me: Identity = Depends(current_identity)):
    if kind is not None and kind not in KINDS:
        raise HTTPException(status_code=400, detail="Неизвестный вид материала")
    where = [store.visible_sql("i")]
    params: list[Any] = store.visible_params(me.user_id)
    if kind:
        where.append("i.kind = %s")
        params.append(kind)
    if templates:
        where.append("i.is_template")
    # Поиск: все слова в любом порядке и форме, совпадение в названии выше, кусок текста — у совпадения (store.search_sql).
    match, match_params, rank, rank_params, hit, hit_params = store.search_sql(q)
    if match:
        where.append(match)
        params += match_params
    depts = params[2]  # visible_params уже посчитал отделы смотрящего…
    shared_ids = params[3]  # …и открытые ему чужие папки
    folder_roles = store.shared_folder_roles(me.user_id, depts) if shared_ids else {}
    params.append(max(1, min(limit, 1000)))
    # Ручной порядок вне папок — когда его таблица уже есть в базе (на проде схему применяют вручную).
    root_order = store.table_ready("workspace_item_root_order")
    root_select = "ro.position AS root_position" if root_order else "NULL::float AS root_position"
    root_join = "LEFT JOIN workspace_item_root_order ro ON ro.item_id = i.id AND ro.user_id = %s " if root_order else ""
    # Новое (мне открыли доступ, а я ещё не открывал) — первым, выше закреплённого.
    order = f"{rank} DESC, i.updated_at DESC" if match else "is_new DESC, i.pinned DESC, i.updated_at DESC"
    rows = db.conn.fetch_all(
        f"SELECT {store.LIST_COLUMNS}, {store.is_new_sql('i')} AS is_new, {hit} AS hit, "
        # Своя раскладка; нет её — место в открытой мне папке владельца (общая раскладка у всех, кому открыта).
        "COALESCE(f.folder_id, CASE WHEN ofo.folder_id = ANY(%s) THEN ofo.folder_id END)::text AS folder_id, "
        "CASE WHEN f.folder_id IS NOT NULL THEN f.position ELSE ofo.position END AS folder_position, "
        f"ofo.folder_id AS owner_folder_id, {root_select} "
        f"FROM workspace_items i LEFT JOIN workspace_item_folder f ON f.item_id = i.id AND f.user_id = %s "
        f"LEFT JOIN workspace_item_folder ofo ON ofo.item_id = i.id AND ofo.user_id = i.owner_id {root_join}"
        f"WHERE {' AND '.join(where)} ORDER BY {order} LIMIT %s",
        tuple(store.is_new_params(me.user_id, depts) + hit_params + [shared_ids, me.user_id] + ([me.user_id] if root_order else [])
              + params[:-1] + (rank_params if match else []) + params[-1:]),
    ) or []
    owner_ids = sorted({str(r["owner_id"]) for r in rows})
    owners = {str(u["id"]): u for u in (db.conn.fetch_all("SELECT id, name, username FROM users WHERE id = ANY(%s)", (owner_ids,)) or [])} if owner_ids else {}
    # Кто сейчас в материале — аватарки на строке списка (себя не показываем).
    present_now = store.viewers_many([str(r["id"]) for r in rows], exclude=me.user_id)
    return {"items": [{**store.present(row, me.user_id, depts=depts, owners=owners, folder_roles=folder_roles),
                       "viewers": present_now.get(str(row["id"]), []),
                       **({"snippet": store.search_snippet(row.get("hit"), row.get("snippet") or "")} if match and row.get("hit") else {})}
                      for row in rows]}


class PresenceListBody(BaseModel):
    ids: list[str] = Field(max_length=1000)


@router.post("/api/workspace/presence")
def presence_for_list(body: PresenceListBody, me: Identity = Depends(current_identity)):
    """Кто сейчас в материалах списка — для периодического обновления аватарок (присутствие истекает без события)."""
    ids = [i for i in body.ids if str(i).isdigit()]
    if not ids:
        return {"viewers": {}}
    visible = db.conn.fetch_all(
        f"SELECT i.id::text AS id FROM workspace_items i WHERE i.id = ANY(%s) AND {store.visible_sql('i')}",
        (list(map(int, ids)), *store.visible_params(me.user_id)),
    ) or []
    return {"viewers": store.viewers_many([r["id"] for r in visible], exclude=me.user_id)}


@router.post("/api/workspace/items", status_code=201)
def create_item(body: ItemCreate, me: Identity = Depends(current_identity)):
    content = body.content
    title = body.title.strip()[:200]
    meta = store.clean_meta(body.kind, body.meta)
    if body.templateId:
        # Новая презентация из шаблона: берёт его содержимое, название и размер колоды.
        source = store.get_visible(body.templateId, me.user_id) if store.get_row(body.templateId) else None
        if source is None or source["kind"] != body.kind:
            raise HTTPException(status_code=404, detail="Шаблон не найден")
        content = content or source["content"]
        title = title or source["title"]
    try:
        store.validate_content(body.kind, content)
    except WorkspaceError as exc:
        raise _raise(exc) from exc
    row = db.conn.fetch_one(
        """INSERT INTO workspace_items (kind, title, text_content, meta, owner_id)
           VALUES (%s, %s, %s, %s, %s) RETURNING id""",
        (body.kind, title, store.text_of(body.kind, content), store.as_json(meta), me.user_id),
    )
    item_id = int(row["id"])
    try:
        sets, values, new_key = store.content_sets(item_id, content)
        if store.via_ready() and store.EDIT_VIA.get():
            sets, values = [*sets, "updated_via = %s"], [*values, store.EDIT_VIA.get()]
        db.conn.execute_query(f"UPDATE workspace_items SET {', '.join(sets)} WHERE id = %s", tuple(values + [item_id]))
    except WorkspaceError as exc:
        db.conn.execute_query("DELETE FROM workspace_items WHERE id = %s", (item_id,))
        raise _raise(exc) from exc
    return {"item": store.present(store.get_row(str(item_id)), me.user_id, with_content=True)}


@router.get("/api/workspace/items/{item_id}")
def get_item(item_id: str, me: Identity = Depends(current_identity)):
    try:
        row = store.get_visible(item_id, me.user_id)
        if str(row["owner_id"]) != me.user_id:
            store.mark_seen(item_id, me.user_id)
        return {"item": store.present(row, me.user_id, with_content=True)}
    except WorkspaceError as exc:
        raise _raise(exc) from exc


@router.patch("/api/workspace/items/{item_id}")
def patch_item(item_id: str, body: ItemPatch, me: Identity = Depends(current_identity)):
    try:
        row = store.get_visible(item_id, me.user_id)
        perms = store.permissions(row, me.user_id)
        fields = body.model_dump(exclude_unset=True)
        owner_only = {"pinned", "isTemplate", "accessLevel", "accessMode"} & fields.keys()
        if owner_only and not perms["isOwner"]:
            raise WorkspaceError(403, "Это может менять только владелец")
        if not perms["canEdit"]:
            raise WorkspaceError(403, "Материал открыт только для просмотра")
        sets: list[str] = []
        params: list[Any] = []
        if "title" in fields and fields["title"] is not None:
            sets.append("title = %s")
            params.append(fields["title"].strip()[:200])
        new_key = ""
        if "content" in fields and fields["content"] is not None:
            store.validate_content(row["kind"], fields["content"])
            content_parts, content_values, new_key = store.content_sets(int(item_id), fields["content"])
            sets += content_parts + ["text_content = %s"]
            params += content_values + [store.text_of(row["kind"], fields["content"])]
            sets.append("updated_by = %s")
            params.append(me.user_id)
            if store.via_ready():
                sets.append("updated_via = %s")
                params.append(store.EDIT_VIA.get())
        if "meta" in fields and fields["meta"] is not None:
            sets.append("meta = %s")
            params.append(store.as_json({**(row["meta"] or {}), **store.clean_meta(row["kind"], fields["meta"])}))
        if "pinned" in fields and fields["pinned"] is not None:
            sets.append("pinned = %s")
            params.append(fields["pinned"])
        if "isTemplate" in fields and fields["isTemplate"] is not None:
            sets.append("is_template = %s")
            params.append(fields["isTemplate"])
        if "accessLevel" in fields and fields["accessLevel"] is not None:
            if fields["accessLevel"] not in ACCESS_LEVELS:
                raise WorkspaceError(400, "Неизвестный уровень доступа")
            sets.append("access_level = %s")
            params.append(fields["accessLevel"])
            if fields["accessLevel"] == "all":
                # Открыли всем — для остальных это «новое» с этого момента, а не с даты создания.
                sets.append("shared_all_at = CASE WHEN access_level = 'all' THEN shared_all_at ELSE now() END")
        if "accessMode" in fields and fields["accessMode"] is not None:
            if fields["accessMode"] not in ACCESS_MODES:
                raise WorkspaceError(400, "Неизвестный режим доступа")
            sets.append("access_mode = %s")
            params.append(fields["accessMode"])
        if not sets:
            return {"item": store.present(row, me.user_id)}
        # Метка времени двигается только от правки текста: закрепление, доступ и метка заметки её не трогают,
        # иначе чужая смена доступа ломала бы сохранение того, кто печатает (baseUpdatedAt).
        if "content" in fields or "title" in fields:
            sets.append("updated_at = now()")
        sql = f"UPDATE workspace_items SET {', '.join(sets)} WHERE id = %s"
        params.append(int(item_id))
        # Пока человек печатал, материал мог записать другой (по ссылке, коллега): тогда 409, решает человек.
        if body.baseUpdatedAt and ("content" in fields):
            sql += " AND updated_at::text = %s"
            params.append(body.baseUpdatedAt)
        updated = db.conn.fetch_one(sql + " RETURNING id", tuple(params))
        taken = False
        if updated and "content" in fields:
            taken = store.snapshot(row, me.user_id)  # прежнее содержимое — в историю версий
        if new_key:
            store.finish_content(new_key, "" if taken else (row.get("content_key") or ""), saved=bool(updated))
        if not updated:
            raise WorkspaceError(409, "Материал изменили, пока вы правили")
        if "content" in fields or "title" in fields:
            live = store.get_row(item_id, full=False)
            store.push_to_viewers(item_id, {"type": "workspace_changed", "reason": "content", "itemId": item_id, "kind": row["kind"], "updatedAt": live["updated_at"],
                                            "by": me.display_name, "byId": me.user_id}, exclude=me.user_id)
        if {"accessLevel", "accessMode", "title"} & fields.keys():
            fresh = store.get_row(item_id, full=False)
            reason = "shared" if fresh["access_level"] == "all" and "accessLevel" in fields else "changed"
            everyone = store.audience(fresh) | (store.audience({**fresh, "access_level": "all"}) if fresh["access_level"] != "all" and "accessLevel" in fields else set())
            store.announce(everyone, fresh, reason, actor=me.user_id, exclude=me.user_id)
        return {"item": store.present(store.get_row(item_id, full=False), me.user_id)}
    except WorkspaceError as exc:
        raise _raise(exc) from exc


@router.delete("/api/workspace/items/{item_id}")
def delete_item(item_id: str, me: Identity = Depends(current_identity)):
    try:
        row = store.get_visible(item_id, me.user_id)
        if not store.permissions(row, me.user_id)["isOwner"]:
            raise WorkspaceError(403, "Удалить может только владелец")
    except WorkspaceError as exc:
        raise _raise(exc) from exc
    who = store.audience(row)
    db.conn.execute_query("DELETE FROM workspace_items WHERE id = %s", (int(item_id),))
    store.drop_objects(int(item_id))
    store.announce(who, row, "changed", actor=me.user_id, exclude=me.user_id)
    return {"ok": True}


def _owned(item_id: str, me: Identity) -> dict[str, Any]:
    try:
        row = store.get_visible(item_id, me.user_id, content=False)
        if not store.permissions(row, me.user_id)["isOwner"]:
            raise WorkspaceError(403, "Доступом управляет только владелец")
        return row
    except WorkspaceError as exc:
        raise _raise(exc) from exc


@router.get("/api/workspace/items/{item_id}/shares")
def list_shares(item_id: str, me: Identity = Depends(current_identity)):
    _owned(item_id, me)
    return _shares_payload(item_id)


def _shares_payload(item_id: str) -> dict[str, Any]:
    rows = db.conn.fetch_all("SELECT user_id, role FROM workspace_item_shares WHERE item_id = %s ORDER BY created_at", (int(item_id),)) or []
    out = []
    for row in rows:
        user = db.get_user_by_id(str(row["user_id"])) or {}
        out.append({"userId": row["user_id"], "role": row["role"], "name": user.get("name") or user.get("username") or ""})
    names = {str(d["id"]): d["name"] for d in (db.get_departments() or [])}
    depts = db.conn.fetch_all("SELECT department_id, role FROM workspace_item_dept_shares WHERE item_id = %s ORDER BY created_at", (int(item_id),)) or []
    departments = [{"departmentId": d["department_id"], "role": d["role"], "name": names.get(str(d["department_id"]), d["department_id"]),
                    "members": len(store.dept_members([str(d["department_id"])]))} for d in depts]
    placed = db.conn.fetch_one("SELECT x.folder_id FROM workspace_item_folder x JOIN workspace_items i ON i.id = x.item_id "
                               "WHERE x.item_id = %s AND x.user_id = i.owner_id", (int(item_id),)) or {}
    return {"shares": out, "departments": departments, "inherited": store.inherited_shares(placed.get("folder_id"))}


@router.put("/api/workspace/items/{item_id}/shares")
def set_share(item_id: str, body: ShareBody, me: Identity = Depends(current_identity)):
    row = _owned(item_id, me)
    if bool(body.userId) == bool(body.departmentId):
        raise HTTPException(status_code=400, detail="Укажите человека или отдел")
    if body.userId:
        if body.userId == str(row["owner_id"]):
            raise HTTPException(status_code=400, detail="Владельцу доступ выдавать не нужно")
        if not db.get_user_by_id(body.userId):
            raise HTTPException(status_code=404, detail="Человек не найден")
        affected = {body.userId}
        table, column, key = "workspace_item_shares", "user_id", body.userId
    else:
        if not db.get_department(body.departmentId):
            raise HTTPException(status_code=404, detail="Отдел не найден")
        affected = store.dept_members([body.departmentId])
        table, column, key = "workspace_item_dept_shares", "department_id", body.departmentId
    if body.role is None:
        db.conn.execute_query(f"DELETE FROM {table} WHERE item_id = %s AND {column} = %s", (int(item_id), key))
    else:
        db.conn.execute_query(
            f"""INSERT INTO {table} (item_id, {column}, role) VALUES (%s, %s, %s)
               ON CONFLICT (item_id, {column}) DO UPDATE SET role = EXCLUDED.role""",
            (int(item_id), key, body.role),
        )
    # Человек (или весь отдел) получает материал в свой список сразу, без обновления страницы.
    store.announce(affected, row, "shared" if body.role else "changed", actor=me.user_id, exclude=me.user_id)
    return _shares_payload(item_id)


@router.post("/api/workspace/items/{item_id}/presence")
def set_presence(item_id: str, body: PresenceBody, me: Identity = Depends(current_identity)):
    try:
        row = store.get_visible(item_id, me.user_id, content=False)
    except WorkspaceError as exc:
        raise _raise(exc) from exc
    editing = body.editing and store.permissions(row, me.user_id)["canEdit"]
    before = sorted((v["userId"], v["editing"]) for v in store.viewer_list(item_id))
    if body.state == "leave":
        store.presence.leave(item_id, me.user_id)
    else:
        store.presence.touch(item_id, me.user_id, editing)
    viewers = store.viewer_list(item_id)
    if before != sorted((v["userId"], v["editing"]) for v in viewers):
        store.push_to_viewers(item_id, {"type": "workspace_presence", "itemId": item_id, "viewers": viewers}, exclude=me.user_id)
        # И всем, кто видит материал в своём списке, — аватарки на строке обновятся сразу.
        store.announce_presence(row, viewers)
    return {"viewers": viewers}


def _who(user_id: str, names: dict[str, str]) -> str:
    if user_id == "link":
        return "По ссылке"
    if user_id not in names:
        names[user_id] = ((db.get_user_by_id(user_id) or {}).get("name") if user_id else "") or ""
    return names[user_id]


def _version_view(row: dict[str, Any], names: dict[str, str]) -> dict[str, Any]:
    """Версия — состояние материала: кто его сделал (savedBy) и как (savedVia: '' — сам, иначе «агент «…»»)."""
    by = str(row["saved_by"] or "")
    return {"id": str(row["id"]), "title": row["title"], "label": row["label"], "size": row["content_size"], "createdAt": row["created_at"],
            "savedBy": by, "savedByName": _who(by, names), "savedVia": row.get("saved_via") or ""}


@router.get("/api/workspace/items/{item_id}/versions")
def list_versions(item_id: str, me: Identity = Depends(current_identity)):
    try:
        row = store.get_visible(item_id, me.user_id, content=False)
    except WorkspaceError as exc:
        raise _raise(exc) from exc
    via = ", saved_via" if store.via_ready() else ""
    rows = db.conn.fetch_all(
        f"""SELECT id, title, label, content_size, saved_by, created_at::text AS created_at{via} FROM workspace_item_versions
           WHERE item_id = %s ORDER BY id DESC LIMIT 80""", (int(item_id),)) or []
    names: dict[str, str] = {}
    editor = str(row.get("updated_by") or row["owner_id"])
    return {
        "versions": [_version_view(r, names) for r in rows],
        "current": {"updatedAt": row["updated_at"], "title": row["title"], "savedBy": editor, "savedByName": _who(editor, names),
                    "savedVia": row.get("updated_via") or ""},
        "canRestore": bool(store.permissions(row, me.user_id)["canEdit"]),
    }


def _version(item_id: str, version_id: str) -> dict[str, Any]:
    if not version_id.isdigit():
        raise HTTPException(status_code=404, detail="Версия не найдена")
    via = ", saved_via" if store.via_ready() else ""
    row = db.conn.fetch_one(
        f"""SELECT id, title, label, content, content_key, content_size, saved_by, created_at::text AS created_at{via}
           FROM workspace_item_versions WHERE id = %s AND item_id = %s""", (int(version_id), int(item_id)))
    if not row:
        raise HTTPException(status_code=404, detail="Версия не найдена")
    return row


@router.get("/api/workspace/items/{item_id}/versions/{version_id}")
def get_version(item_id: str, version_id: str, me: Identity = Depends(current_identity)):
    try:
        store.get_visible(item_id, me.user_id, content=False)
        row = _version(item_id, version_id)
        return {"version": {**_version_view(row, {}), "content": store.version_content(row)}}
    except WorkspaceError as exc:
        raise _raise(exc) from exc


@router.post("/api/workspace/items/{item_id}/versions")
def save_version(item_id: str, body: VersionBody, me: Identity = Depends(current_identity)):
    try:
        row = store.get_visible(item_id, me.user_id)
        if not store.permissions(row, me.user_id)["canEdit"]:
            raise WorkspaceError(403, "Материал открыт только для просмотра")
        store.snapshot(row, me.user_id, force=True, label=body.label.strip() or "Сохранено вручную", keep_object=True)
        return list_versions(item_id, me)
    except WorkspaceError as exc:
        raise _raise(exc) from exc


@router.post("/api/workspace/items/{item_id}/versions/{version_id}/restore")
def restore_version(item_id: str, version_id: str, me: Identity = Depends(current_identity)):
    try:
        row = store.get_visible(item_id, me.user_id)
        if not store.permissions(row, me.user_id)["canEdit"]:
            raise WorkspaceError(403, "Материал открыт только для просмотра")
        version = _version(item_id, version_id)
        content = store.version_content(version)
        store.validate_content(row["kind"], content)
        parts, values, new_key = store.content_sets(int(item_id), content)
        via = ", updated_via = %s" if store.via_ready() else ""
        updated = db.conn.fetch_one(
            f"UPDATE workspace_items SET {', '.join(parts)}, text_content = %s, title = %s, updated_by = %s, updated_at = now(){via} WHERE id = %s RETURNING id",
            tuple(values + [store.text_of(row["kind"], content), version["title"] or row["title"], me.user_id,
                            *([store.EDIT_VIA.get()] if via else []), int(item_id)]),
        )
        taken = bool(updated) and store.snapshot(row, me.user_id, force=True, label="Перед восстановлением")
        if new_key:
            store.finish_content(new_key, "" if taken else (row.get("content_key") or ""), saved=bool(updated))
        fresh = store.get_row(item_id, full=False)
        store.push_to_viewers(item_id, {"type": "workspace_changed", "reason": "content", "itemId": item_id, "kind": row["kind"], "updatedAt": fresh["updated_at"],
                                        "by": me.display_name, "byId": me.user_id}, exclude=me.user_id)
        store.announce(store.audience(fresh), fresh, "changed", actor=me.user_id, exclude=me.user_id)
        return {"item": store.present(store.get_row(item_id), me.user_id, with_content=True)}
    except WorkspaceError as exc:
        raise _raise(exc) from exc


def _links(item_id: str) -> list[dict[str, Any]]:
    rows = db.conn.fetch_all(
        "SELECT token, mode, created_at::text AS created_at, last_used_at::text AS last_used_at FROM workspace_item_links WHERE item_id = %s ORDER BY mode",
        (int(item_id),),
    ) or []
    return [{"token": r["token"], "mode": r["mode"], "createdAt": r["created_at"], "lastUsedAt": r["last_used_at"]} for r in rows]


@router.get("/api/workspace/items/{item_id}/links")
def list_links(item_id: str, me: Identity = Depends(current_identity)):
    _owned(item_id, me)
    return {"links": _links(item_id)}


@router.post("/api/workspace/items/{item_id}/links")
def create_link(item_id: str, body: LinkBody, me: Identity = Depends(current_identity)):
    _owned(item_id, me)
    existing = db.conn.fetch_one("SELECT token FROM workspace_item_links WHERE item_id = %s AND mode = %s", (int(item_id), body.mode))
    if existing and not body.regenerate:
        link = next(item for item in _links(item_id) if item["mode"] == body.mode)
        return {"link": link, "links": _links(item_id)}
    token = store.new_token()
    # Перевыпуск — новый токен на то же место: старая ссылка сразу перестаёт открываться.
    db.conn.execute_query(
        """INSERT INTO workspace_item_links (token, item_id, mode, created_by) VALUES (%s, %s, %s, %s)
           ON CONFLICT (item_id, mode) DO UPDATE SET token = EXCLUDED.token, created_by = EXCLUDED.created_by, created_at = now(), last_used_at = NULL""",
        (token, int(item_id), body.mode, me.user_id),
    )
    links = _links(item_id)
    return {"link": next(item for item in links if item["mode"] == body.mode), "links": links}


@router.delete("/api/workspace/items/{item_id}/links/{mode}")
def revoke_link(item_id: str, mode: str, me: Identity = Depends(current_identity)):
    _owned(item_id, me)
    if mode not in ("view", "edit"):
        raise HTTPException(status_code=400, detail="Режим — view или edit")
    db.conn.execute_query("DELETE FROM workspace_item_links WHERE item_id = %s AND mode = %s", (int(item_id), mode))
    return {"links": _links(item_id)}
