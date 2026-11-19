"""Личные контакты: записная книжка человека (клиенты, подрядчики, знакомые) с доступом, как у документов.

Сотрудники компании — это users, их показывает раздел «Контакты» сам. Здесь — то, что человек заводит себе: внешние люди и
организации. Видит запись её владелец и те, кому он открыл доступ: поимённо или целому отделу (с подразделами).
Уровни: view — читать, edit — ещё и править. Удаляет запись и управляет доступом только владелец. Администратор чужие
личные контакты не видит: это личные данные, а не рабочий справочник.

Карточка «по-взрослому»: фото (аватар), сайт и сколько угодно контактных лиц — у организации бывают бухгалтер, директор,
менеджер, у каждого свой телефон и почта. Лица хранятся массивом в той же записи (persons JSONB): отдельно их не ищут и не
делятся ими — они часть карточки.

Новые таблицы и столбцы на проде появляются отдельным шагом схемы; пока их нет, список пуст (или без новых полей),
а запись возвращает 503 (table_ready / column_ready).
"""

from __future__ import annotations

import io
import json
import logging
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.security import Identity, current_identity

router = APIRouter()
log = logging.getLogger("shar.contacts")

LEVELS = ("view", "edit")
TABLES = ("personal_contacts", "personal_contact_shares", "personal_contact_dept_shares")
FIELDS = ("name", "company", "position", "phone", "email", "telegram", "note")
EXTRA = ("website", "avatar", "persons")
PERSON_FIELDS = ("name", "position", "phone", "email", "telegram", "note")
MAX_PERSONS = 30

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

# Сайт, фото и контактные лица — отдельным шагом: на проде столбцы добавляют вручную, до этого карточка живёт без них.
schema.register("personal_contacts_extra", """
ALTER TABLE personal_contacts ADD COLUMN IF NOT EXISTS website TEXT NOT NULL DEFAULT '';
ALTER TABLE personal_contacts ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '';
ALTER TABLE personal_contacts ADD COLUMN IF NOT EXISTS persons JSONB NOT NULL DEFAULT '[]'::jsonb;
""")


def _store():
    from app.modules.workspace import store  # поздний импорт: workspace тянет S3

    return store


def ready() -> bool:
    store = _store()
    return all(store.table_ready(t) for t in TABLES)


def extra_ready() -> bool:
    store = _store()
    return all(store.column_ready("personal_contacts", c) for c in EXTRA)


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


class PersonBody(BaseModel):
    """Контактное лицо организации: бухгалтер, директор, менеджер."""
    name: str = Field(default="", max_length=200)
    position: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=100)
    email: str = Field(default="", max_length=200)
    telegram: str = Field(default="", max_length=100)
    note: str = Field(default="", max_length=1000)


class ContactBody(BaseModel):
    name: str = Field(default="", max_length=200)
    company: str = Field(default="", max_length=200)
    position: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=100)
    email: str = Field(default="", max_length=200)
    telegram: str = Field(default="", max_length=100)
    note: str = Field(default="", max_length=5000)
    website: str = Field(default="", max_length=300)
    persons: list[PersonBody] = Field(default_factory=list, max_length=MAX_PERSONS)


class ContactPatch(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    company: Optional[str] = Field(default=None, max_length=200)
    position: Optional[str] = Field(default=None, max_length=200)
    phone: Optional[str] = Field(default=None, max_length=100)
    email: Optional[str] = Field(default=None, max_length=200)
    telegram: Optional[str] = Field(default=None, max_length=100)
    note: Optional[str] = Field(default=None, max_length=5000)
    website: Optional[str] = Field(default=None, max_length=300)
    persons: Optional[list[PersonBody]] = Field(default=None, max_length=MAX_PERSONS)


class ShareBody(BaseModel):
    userId: Optional[str] = Field(default=None, max_length=255)
    departmentId: Optional[str] = Field(default=None, max_length=255)
    role: Optional[str] = None  # view | edit | None — закрыть доступ


def _persons(raw: Any) -> list[dict[str, str]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = []
    out = []
    for p in raw if isinstance(raw, list) else []:
        if isinstance(p, dict):
            out.append({f: str(p.get(f) or "") for f in PERSON_FIELDS})
    return out


def _clean_persons(persons: list[PersonBody]) -> list[dict[str, str]]:
    """Пустые строки формы (ни имени, ни телефона, ни почты…) выкидываем — это недописанное лицо."""
    out = []
    for p in persons:
        item = {f: (getattr(p, f) or "").strip() for f in PERSON_FIELDS}
        if any(item.values()):
            out.append(item)
    return out


def _site(url: str) -> str:
    url = (url or "").strip()
    if url and "://" not in url:
        url = "https://" + url
    if url and not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Сайт — адрес вида example.ru или https://example.ru")
    return url


def _view(row: dict, role: str, names: dict[str, str], shared: int = 0) -> dict:
    return {
        "id": str(row["id"]), **{f: row[f] for f in FIELDS},
        "website": row.get("website") or "", "avatar": row.get("avatar") or "", "persons": _persons(row.get("persons")),
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


def _clean(values: dict[str, Any]) -> dict[str, Any]:
    """Поля формы → столбцы: строки обрезаны, сайт с протоколом, лица без пустых строк (JSON). Новые поля без схемы — 503."""
    out: dict[str, Any] = {k: (v or "").strip() for k, v in values.items() if v is not None and k in FIELDS}
    website = values.get("website")
    persons = values.get("persons")
    if website is not None or persons is not None:
        if not extra_ready():
            if (website or "").strip() or persons:
                raise HTTPException(status_code=503, detail="Сайт и контактные лица ещё не включены на сервере: нужна схема (выкладка с -Schema)")
            return out
        if website is not None:
            out["website"] = _site(website)
        if persons is not None:
            out["persons"] = json.dumps(_clean_persons([PersonBody(**p) if isinstance(p, dict) else p for p in persons]), ensure_ascii=False)
    return out


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
    cols = list(data)
    row = db.conn.fetch_one(
        f"INSERT INTO personal_contacts (owner_id, {', '.join(cols)}) VALUES (%s, {', '.join(['%s'] * len(cols))}) RETURNING *",
        (me.user_id, *(data[c] for c in cols)))
    return _view(dict(row), "owner", _names({me.user_id}))


@router.patch("/api/contacts/personal/{contact_id}")
def update_personal(contact_id: str, body: ContactPatch, me: Identity = Depends(current_identity)):
    row, role = _access(contact_id, me)
    if role == "view":
        raise HTTPException(status_code=403, detail="Контакт открыт вам только на просмотр")
    changes = _clean(body.model_dump(exclude_unset=True))
    merged = {**{f: row[f] for f in FIELDS}, **{k: v for k, v in changes.items() if k in FIELDS}}
    if not (merged["name"] or merged["company"]):
        raise HTTPException(status_code=400, detail="Укажите имя или организацию")
    if changes:
        sets = ", ".join(f"{k} = %s::jsonb" if k == "persons" else f"{k} = %s" for k in changes)
        db.conn.execute_query(f"UPDATE personal_contacts SET {sets}, updated_at = now() WHERE id = %s", (*changes.values(), row["id"]))
    fresh = db.conn.fetch_one("SELECT * FROM personal_contacts WHERE id = %s", (row["id"],))
    return _view(dict(fresh), role, _names({str(fresh["owner_id"])}))


@router.delete("/api/contacts/personal/{contact_id}")
def delete_personal(contact_id: str, me: Identity = Depends(current_identity)):
    row, role = _access(contact_id, me)
    if role != "owner":
        raise HTTPException(status_code=403, detail="Удалить контакт может только его владелец")
    db.conn.execute_query("DELETE FROM personal_contacts WHERE id = %s", (row["id"],))
    _forget_avatar(int(row["id"]))
    return {"ok": True}


# ── Фото контакта ───────────────────────────────────────────────────────────────
# Лежит рядом с аватарами людей (S3 avatars/ или UPLOAD_DIR/avatars) под именем pc<id>_<uuid>: отдаёт его тот же
# /api/avatars/<file> (имя случайное, как у фото сотрудников). Менять может тот, у кого есть право правки.

def _forget_avatar(contact_id: int) -> None:
    from app.core.storage import s3_storage
    from app.modules.files.avatars import AVATARS_DIR

    try:
        if s3_storage.enabled:
            s3_storage.delete_prefix(f"avatars/pc{contact_id}_")
        for old in AVATARS_DIR.glob(f"pc{contact_id}_*"):
            old.unlink(missing_ok=True)
    except Exception as exc:  # noqa: BLE001 — старое фото не удалилось: не беда, новое уже на месте
        log.warning("contacts: old avatar of %s not removed: %s", contact_id, exc)


def _editable(contact_id: str, me: Identity) -> dict:
    row, role = _access(contact_id, me)
    if role == "view":
        raise HTTPException(status_code=403, detail="Контакт открыт вам только на просмотр")
    if not extra_ready():
        raise HTTPException(status_code=503, detail="Фото контактов ещё не включены на сервере: нужна схема (выкладка с -Schema)")
    return row


@router.post("/api/contacts/personal/{contact_id}/avatar")
def upload_avatar(contact_id: str, file: UploadFile = File(...), me: Identity = Depends(current_identity)):
    from app.core.storage import s3_storage
    from app.modules.files.avatars import AVATARS_DIR, MAX_AVATAR_BYTES, _sniff_image

    row = _editable(contact_id, me)
    data = file.file.read(MAX_AVATAR_BYTES + 1)
    if len(data) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Фото слишком большое: до 5 МБ")
    sniffed = _sniff_image(data[:16])
    if not sniffed:
        raise HTTPException(status_code=400, detail="Нужна картинка: JPG, PNG, GIF или WebP")
    ext, mime = sniffed
    cid = int(row["id"])
    name = f"pc{cid}_{uuid.uuid4().hex}{ext}"
    try:
        _forget_avatar(cid)
        if s3_storage.enabled:
            s3_storage.upload_fileobj(io.BytesIO(data), f"avatars/{name}", mime)
        else:
            (AVATARS_DIR / name).write_bytes(data)
    except Exception:
        log.exception("contacts: avatar upload failed for %s", cid)
        raise HTTPException(status_code=502, detail="Не удалось сохранить фото") from None
    url = f"/api/avatars/{name}"
    db.conn.execute_query("UPDATE personal_contacts SET avatar = %s, updated_at = now() WHERE id = %s", (url, cid))
    fresh = db.conn.fetch_one("SELECT * FROM personal_contacts WHERE id = %s", (cid,))
    return _view(dict(fresh), _access(contact_id, me)[1], _names({str(fresh["owner_id"])}))


@router.delete("/api/contacts/personal/{contact_id}/avatar")
def delete_avatar(contact_id: str, me: Identity = Depends(current_identity)):
    row = _editable(contact_id, me)
    cid = int(row["id"])
    _forget_avatar(cid)
    db.conn.execute_query("UPDATE personal_contacts SET avatar = '', updated_at = now() WHERE id = %s", (cid,))
    fresh = db.conn.fetch_one("SELECT * FROM personal_contacts WHERE id = %s", (cid,))
    return _view(dict(fresh), _access(contact_id, me)[1], _names({str(fresh["owner_id"])}))


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
