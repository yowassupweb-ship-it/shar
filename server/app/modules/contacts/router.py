"""Личные контакты: записная книжка человека (клиенты, подрядчики, знакомые) с доступом, как у документов.

Сотрудники компании — это users, их показывает раздел «Контакты» сам. Здесь — то, что человек заводит себе: внешние люди и
организации. Видит запись её владелец и те, кому он открыл доступ: поимённо или целому отделу (с подразделами).
Уровни: view — читать, edit — ещё и править. Удаляет запись и управляет доступом только владелец. Администратор чужие
личные контакты не видит: это личные данные, а не рабочий справочник.

Новые таблицы на проде появляются отдельным шагом схемы; пока их нет, список пуст, а запись возвращает 503 (table_ready).
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.security import Identity, current_identity

router = APIRouter()

LEVELS = ("view", "edit")
TABLES = ("personal_contacts", "personal_contact_shares", "personal_contact_dept_shares")
FIELDS = ("name", "company", "position", "phone", "email", "telegram", "note")

schema.register("personal_contacts", """
CREATE TABLE IF NOT EXISTS personal_contacts (
    id BIGSERIAL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    position TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    telegram TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_personal_contacts_owner ON personal_contacts(owner_id);
CREATE TABLE IF NOT EXISTS personal_contact_shares (
    contact_id BIGINT NOT NULL REFERENCES personal_contacts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (contact_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_personal_contact_shares_user ON personal_contact_shares(user_id);
CREATE TABLE IF NOT EXISTS personal_contact_dept_shares (
    contact_id BIGINT NOT NULL REFERENCES personal_contacts(id) ON DELETE CASCADE,
    department_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (contact_id, department_id)
);
CREATE INDEX IF NOT EXISTS idx_personal_contact_dept_shares_dept ON personal_contact_dept_shares(department_id);
""")


def _store():
    from app.modules.workspace import store  # поздний импорт: workspace тянет S3

    return store


def ready() -> bool:
    store = _store()
    return all(store.table_ready(t) for t in TABLES)


def _require_ready() -> None:
    if not ready():
        raise HTTPException(status_code=503, detail="Личные контакты ещё не включены на сервере: нужна схема (выкладка с -Schema)")


# Уровень доступа человека к записи c: owner | edit | view | NULL (не видит). Параметры — _role_params(user_id).
_ROLE_SQL = (
    "CASE WHEN c.owner_id = %s THEN 'owner' "
    "ELSE (SELECT r.role FROM ("
    "SELECT s.role FROM personal_contact_shares s WHERE s.contact_id = c.id AND s.user_id = %s "
    "UNION ALL SELECT d.role FROM personal_contact_dept_shares d WHERE d.contact_id = c.id AND d.department_id = ANY(%s)"
    ") r ORDER BY (r.role = 'edit') DESC LIMIT 1) END"
)


def _role_params(user_id: str) -> list[Any]:
    return [user_id, user_id, _store().user_dept_ids(user_id)]


class ContactBody(BaseModel):
    name: str = Field(default="", max_length=200)
    company: str = Field(default="", max_length=200)
    position: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=100)
    email: str = Field(default="", max_length=200)
    telegram: str = Field(default="", max_length=100)
    note: str = Field(default="", max_length=5000)


class ContactPatch(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    company: Optional[str] = Field(default=None, max_length=200)
    position: Optional[str] = Field(default=None, max_length=200)
    phone: Optional[str] = Field(default=None, max_length=100)
    email: Optional[str] = Field(default=None, max_length=200)
    telegram: Optional[str] = Field(default=None, max_length=100)
    note: Optional[str] = Field(default=None, max_length=5000)


class ShareBody(BaseModel):
    userId: Optional[str] = Field(default=None, max_length=255)
    departmentId: Optional[str] = Field(default=None, max_length=255)
    role: Optional[str] = None  # view | edit | None — закрыть доступ


def _view(row: dict, role: str, names: dict[str, str], shared: int = 0) -> dict:
    return {
        "id": str(row["id"]), **{f: row[f] for f in FIELDS},
        "ownerId": str(row["owner_id"]), "ownerName": names.get(str(row["owner_id"]), ""),
        "mine": role == "owner", "role": role, "shared": shared,
        "createdAt": row["created_at"].isoformat(), "updatedAt": row["updated_at"].isoformat(),
    }


def _names(ids: set[str]) -> dict[str, str]:
    if not ids:
        return {}
    rows = db.conn.fetch_all("SELECT id, name, username FROM users WHERE id = ANY(%s)", (list(ids),)) or []
    return {str(u["id"]): u.get("name") or u.get("username") or "" for u in rows}


def _access(contact_id: str, me: Identity) -> tuple[dict, str]:
    """(запись, уровень: owner | edit | view). Нет записи или она вам не открыта — 404, чтобы не выдавать её существование."""
    _require_ready()
    try:
        cid = int(contact_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Контакт не найден") from None
    row = db.conn.fetch_one(f"SELECT c.*, {_ROLE_SQL} AS my_role FROM personal_contacts c WHERE c.id = %s", (*_role_params(me.user_id), cid))
    if not row or not row["my_role"]:
        raise HTTPException(status_code=404, detail="Контакт не найден")
    return dict(row), row["my_role"]


def _clean(values: dict[str, Optional[str]]) -> dict[str, str]:
    return {k: (v or "").strip() for k, v in values.items() if v is not None}


@router.get("/api/contacts/personal")
def list_personal(me: Identity = Depends(current_identity)):
    if not ready():
        return {"contacts": [], "ready": False}
    rows = db.conn.fetch_all(
        f"SELECT * FROM (SELECT c.*, {_ROLE_SQL} AS my_role, "
        "(SELECT count(*) FROM personal_contact_shares s WHERE s.contact_id = c.id) "
        "+ (SELECT count(*) FROM personal_contact_dept_shares d WHERE d.contact_id = c.id) AS shared_n "
        "FROM personal_contacts c) x WHERE my_role IS NOT NULL ORDER BY lower(name), id",
        tuple(_role_params(me.user_id))) or []
    names = _names({str(r["owner_id"]) for r in rows})
    return {"contacts": [_view(r, r["my_role"], names, int(r["shared_n"]) if r["my_role"] == "owner" else 0) for r in rows], "ready": True}


@router.post("/api/contacts/personal", status_code=201)
def create_personal(body: ContactBody, me: Identity = Depends(current_identity)):
    _require_ready()
    data = _clean(body.model_dump())
    if not (data["name"] or data["company"]):
        raise HTTPException(status_code=400, detail="Укажите имя или организацию")
    row = db.conn.fetch_one(
        "INSERT INTO personal_contacts (owner_id, name, company, position, phone, email, telegram, note) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING *",
        (me.user_id, *(data[f] for f in FIELDS)))
    return _view(dict(row), "owner", _names({me.user_id}))


@router.patch("/api/contacts/personal/{contact_id}")
def update_personal(contact_id: str, body: ContactPatch, me: Identity = Depends(current_identity)):
    row, role = _access(contact_id, me)
    if role == "view":
        raise HTTPException(status_code=403, detail="Контакт открыт вам только на просмотр")
    changes = _clean(body.model_dump(exclude_unset=True))
    merged = {**{f: row[f] for f in FIELDS}, **changes}
    if not (merged["name"] or merged["company"]):
        raise HTTPException(status_code=400, detail="Укажите имя или организацию")
    if changes:
        sets = ", ".join(f"{k} = %s" for k in changes)
        db.conn.execute_query(f"UPDATE personal_contacts SET {sets}, updated_at = now() WHERE id = %s", (*changes.values(), row["id"]))
    fresh = db.conn.fetch_one("SELECT * FROM personal_contacts WHERE id = %s", (row["id"],))
    return _view(dict(fresh), role, _names({str(fresh["owner_id"])}))


@router.delete("/api/contacts/personal/{contact_id}")
def delete_personal(contact_id: str, me: Identity = Depends(current_identity)):
    row, role = _access(contact_id, me)
    if role != "owner":
        raise HTTPException(status_code=403, detail="Удалить контакт может только его владелец")
    db.conn.execute_query("DELETE FROM personal_contacts WHERE id = %s", (row["id"],))
    return {"ok": True}


def _shares_payload(contact_id: int) -> dict:
    users = db.conn.fetch_all("SELECT user_id, role FROM personal_contact_shares WHERE contact_id = %s ORDER BY created_at", (contact_id,)) or []
    depts = db.conn.fetch_all("SELECT department_id, role FROM personal_contact_dept_shares WHERE contact_id = %s ORDER BY created_at", (contact_id,)) or []
    names = _names({str(u["user_id"]) for u in users})
    store = _store()
    out_depts = []
    for d in depts:
        dep = db.get_department(str(d["department_id"])) or {}
        out_depts.append({"departmentId": str(d["department_id"]), "name": dep.get("name") or str(d["department_id"]), "role": d["role"],
                          "members": len(store.dept_members([str(d["department_id"])]))})
    return {"shares": [{"userId": str(u["user_id"]), "name": names.get(str(u["user_id"]), ""), "role": u["role"]} for u in users], "departments": out_depts}


@router.get("/api/contacts/personal/{contact_id}/shares")
def get_shares(contact_id: str, me: Identity = Depends(current_identity)):
    row, role = _access(contact_id, me)
    if role != "owner":
        raise HTTPException(status_code=403, detail="Доступом управляет владелец контакта")
    return _shares_payload(int(row["id"]))


@router.put("/api/contacts/personal/{contact_id}/shares")
def set_share(contact_id: str, body: ShareBody, me: Identity = Depends(current_identity)):
    """Открыть контакт человеку или отделу (или закрыть: role = null)."""
    row, role = _access(contact_id, me)
    if role != "owner":
        raise HTTPException(status_code=403, detail="Доступом управляет владелец контакта")
    if bool(body.userId) == bool(body.departmentId):
        raise HTTPException(status_code=400, detail="Укажите человека или отдел")
    if body.role is not None and body.role not in LEVELS:
        raise HTTPException(status_code=400, detail="Права: просмотр или редактирование")
    if body.userId:
        if body.userId == me.user_id:
            raise HTTPException(status_code=400, detail="Владельцу доступ выдавать не нужно")
        if not db.get_user_by_id(body.userId):
            raise HTTPException(status_code=404, detail="Человек не найден")
        table, column, key = "personal_contact_shares", "user_id", body.userId
    else:
        if not db.get_department(body.departmentId):
            raise HTTPException(status_code=404, detail="Отдел не найден")
        table, column, key = "personal_contact_dept_shares", "department_id", body.departmentId
    if body.role is None:
        db.conn.execute_query(f"DELETE FROM {table} WHERE contact_id = %s AND {column} = %s", (row["id"], key))
    else:
        db.conn.execute_query(
            f"INSERT INTO {table} (contact_id, {column}, role) VALUES (%s, %s, %s) "
            f"ON CONFLICT (contact_id, {column}) DO UPDATE SET role = EXCLUDED.role", (row["id"], key, body.role))
    return _shares_payload(int(row["id"]))
