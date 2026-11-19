"""Личные контакты: видит владелец и те, кому он открыл доступ (человеку или отделу); права view/edit."""

from __future__ import annotations

import uuid


def _make(owner, name="Иван Петров", **extra) -> str:
    r = owner.post("/api/contacts/personal", json={"name": name, "company": "ООО Ромашка", "phone": "+7 900 000-00-00", **extra})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _ids(client) -> set[str]:
    r = client.get("/api/contacts/personal")
    assert r.status_code == 200, r.text
    assert r.json()["ready"] is True
    return {c["id"] for c in r.json()["contacts"]}


def _dept(admin, name, parent=None):
    r = admin.post("/api/departments", json={"name": f"{name}-{uuid.uuid4().hex[:4]}", **({"parentId": parent} if parent else {})})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_private_until_shared_then_follows_level(users, anna, boris, clara):
    cid = _make(anna)
    assert cid in _ids(anna)
    assert cid not in _ids(boris) and cid not in _ids(clara)  # пока не открыт — чужому не виден
    assert boris.patch(f"/api/contacts/personal/{cid}", json={"note": "взлом"}).status_code == 404

    r = anna.put(f"/api/contacts/personal/{cid}/shares", json={"userId": users.ids["boris"], "role": "view"})
    assert r.status_code == 200, r.text
    assert cid in _ids(boris) and cid not in _ids(clara)
    mine = {c["id"]: c for c in boris.get("/api/contacts/personal").json()["contacts"]}[cid]
    assert mine["mine"] is False and mine["role"] == "view" and mine["ownerName"]

    # только просмотр: ни править, ни удалять, ни управлять доступом
    assert boris.patch(f"/api/contacts/personal/{cid}", json={"note": "взлом"}).status_code == 403
    assert boris.delete(f"/api/contacts/personal/{cid}").status_code == 403
    assert boris.get(f"/api/contacts/personal/{cid}/shares").status_code == 403
    assert boris.put(f"/api/contacts/personal/{cid}/shares", json={"userId": users.ids["clara"], "role": "view"}).status_code == 403

    anna.put(f"/api/contacts/personal/{cid}/shares", json={"userId": users.ids["boris"], "role": "edit"})
    r = boris.patch(f"/api/contacts/personal/{cid}", json={"note": "Позвонить во вторник"})
    assert r.status_code == 200 and r.json()["note"] == "Позвонить во вторник"
    assert boris.delete(f"/api/contacts/personal/{cid}").status_code == 403  # удаляет только владелец

    # закрыли доступ — снова не виден
    anna.put(f"/api/contacts/personal/{cid}/shares", json={"userId": users.ids["boris"], "role": None})
    assert cid not in _ids(boris)


def test_admin_does_not_see_personal_contacts(users, admin, anna):
    cid = _make(anna, "Личный")
    assert cid not in _ids(admin)  # личные данные: администратор их не получает автоматически


def test_share_with_department_includes_subdepartments(users, admin, anna, boris, clara):
    from app.core.db import db

    parent = _dept(admin, "Продажи")
    child = _dept(admin, "Продажи-юг", parent)
    other = _dept(admin, "Бухгалтерия")
    db.update_user(users.ids["boris"], {"departmentIds": [child]})
    db.update_user(users.ids["clara"], {"departmentIds": [other]})

    cid = _make(anna, "Отделу")
    r = anna.put(f"/api/contacts/personal/{cid}/shares", json={"departmentId": parent, "role": "view"})
    assert r.status_code == 200, r.text
    assert r.json()["departments"][0]["departmentId"] == parent
    assert cid in _ids(boris) and cid not in _ids(clara)

    anna.put(f"/api/contacts/personal/{cid}/shares", json={"departmentId": parent, "role": None})
    assert cid not in _ids(boris)


def test_validation_and_owner_rules(users, anna, boris):
    assert anna.post("/api/contacts/personal", json={"phone": "123"}).status_code == 400  # нужно имя или организация
    cid = _make(anna, "Проверка")
    assert anna.patch(f"/api/contacts/personal/{cid}", json={"name": "", "company": ""}).status_code == 400
    me = users.ids["anna"]
    assert anna.put(f"/api/contacts/personal/{cid}/shares", json={"userId": me, "role": "view"}).status_code == 400
    assert anna.put(f"/api/contacts/personal/{cid}/shares", json={"userId": "нет-такого", "role": "view"}).status_code == 404
    assert anna.put(f"/api/contacts/personal/{cid}/shares", json={"userId": users.ids["boris"], "departmentId": "x", "role": "view"}).status_code == 400
    assert anna.put(f"/api/contacts/personal/{cid}/shares", json={"userId": users.ids["boris"], "role": "owner"}).status_code == 400
    assert anna.get("/api/contacts/personal/abc/shares").status_code == 404

    assert anna.delete(f"/api/contacts/personal/{cid}").status_code == 200
    assert cid not in _ids(anna)


def test_requires_login(client):
    assert client.get("/api/contacts/personal").status_code in (401, 403)


_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def test_website_persons_and_avatar(users, anna, boris):
    cid = _make(anna, website="romashka.ru", persons=[
        {"name": "Ольга", "position": "Бухгалтер", "phone": "+7 901"},
        {"name": "", "phone": "", "email": ""},  # пустая строка формы — выкидывается
        {"name": "Пётр", "email": "petr@romashka.ru"},
    ])
    card = {c["id"]: c for c in anna.get("/api/contacts/personal").json()["contacts"]}[cid]
    assert card["website"] == "https://romashka.ru"
    assert [p["name"] for p in card["persons"]] == ["Ольга", "Пётр"] and card["persons"][0]["position"] == "Бухгалтер"
    assert card["avatar"] == ""

    r = anna.patch(f"/api/contacts/personal/{cid}", json={"persons": [{"name": "Ольга", "phone": "+7 902"}]})
    assert r.status_code == 200, r.text
    assert r.json()["persons"] == [{"name": "Ольга", "position": "", "phone": "+7 902", "email": "", "telegram": "", "note": ""}]
    assert r.json()["website"] == "https://romashka.ru"  # не трогали — осталось
    assert anna.patch(f"/api/contacts/personal/{cid}", json={"website": "ftp://x"}).status_code == 400

    # фото: не картинка — 400; картинка — адрес /api/avatars/pc<id>_…, файл отдаётся
    assert anna.post(f"/api/contacts/personal/{cid}/avatar", files={"file": ("a.txt", b"hello", "text/plain")}).status_code == 400
    r = anna.post(f"/api/contacts/personal/{cid}/avatar", files={"file": ("a.png", _PNG, "image/png")})
    assert r.status_code == 200, r.text
    url = r.json()["avatar"]
    assert url.startswith(f"/api/avatars/pc{cid}_") and anna.get(url).status_code == 200

    # просмотр — фото не поменять; чужому — не видно вовсе
    assert boris.post(f"/api/contacts/personal/{cid}/avatar", files={"file": ("a.png", _PNG, "image/png")}).status_code == 404
    anna.put(f"/api/contacts/personal/{cid}/shares", json={"userId": users.ids["boris"], "role": "view"})
    assert boris.post(f"/api/contacts/personal/{cid}/avatar", files={"file": ("a.png", _PNG, "image/png")}).status_code == 403

    r = anna.delete(f"/api/contacts/personal/{cid}/avatar")
    assert r.status_code == 200 and r.json()["avatar"] == "" and anna.get(url).status_code == 404
