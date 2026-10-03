"""Пользователи и админка: секреты не отдаются, права строго по ролям."""

from __future__ import annotations


def test_passwords_are_never_returned(users, anna, admin):
    for c in (anna, admin):
        assert "password" not in c.get("/api/users").text.lower()
        assert "pbkdf2" not in c.get("/api/users?includePasswords=true&include_disabled=true").text
        assert "pbkdf2" not in c.get(f"/api/users/{users.ids['boris']}").text


def test_passwords_are_stored_hashed(users):
    from app.core.db import db

    assert db.get_user_by_id(users.ids["anna"])["password"].startswith("pbkdf2_sha256$")


def test_user_cannot_escalate_or_edit_others(users, anna, boris):
    me = users.ids["anna"]
    assert anna.put(f"/api/users/{me}", json={"role": "admin"}).status_code == 403
    assert anna.put(f"/api/users/{me}", json={"enabledTools": ["admin"]}).status_code == 403
    assert anna.put(f"/api/users/{users.ids['boris']}", json={"position": "x"}).status_code == 403
    assert anna.put(f"/api/users/{me}", json={"position": "Менеджер", "phone": "123"}).status_code == 200
    assert anna.delete(f"/api/users/{users.ids['boris']}").status_code == 403
    assert anna.post("/api/users", json={"name": "X", "email": "x@x.ru", "password": "secret-pass"}).status_code == 403


def test_non_admin_does_not_see_disabled(users, admin, anna):
    uid = users.create("eve")
    admin.put(f"/api/users/{uid}", json={"isDisabled": True})
    assert uid not in [u["id"] for u in anna.get("/api/users?include_disabled=true").json()]
    assert uid in [u["id"] for u in admin.get("/api/users?include_disabled=true").json()]


def test_password_change_hashes_and_kills_other_sessions(users, client):
    uid = users.create("fred")
    a, b = users.login("fred"), None
    from tests.conftest import UserClient

    b = UserClient(client)
    assert b.post("/api/auth/login", json={"username": uid, "password": "secret-pass"}).status_code == 200
    assert a.put(f"/api/users/{uid}", json={"password": "brand-new-pass"}).status_code == 200
    assert a.get("/api/users").status_code == 200       # текущее устройство осталось
    assert b.get("/api/users").status_code == 401       # остальные вышли
    assert UserClient(client).post("/api/auth/login", json={"username": uid, "password": "brand-new-pass"}).status_code == 200


def test_short_password_rejected(users, anna):
    assert anna.put(f"/api/users/{users.ids['anna']}", json={"password": "123"}).status_code == 422


def test_admin_cannot_lock_self_out(users, admin):
    me = users.ids["admin"]
    assert admin.delete(f"/api/users/{me}").status_code == 400
    assert admin.put(f"/api/users/{me}", json={"isDisabled": True}).status_code == 400
    assert admin.put(f"/api/users/{me}", json={"role": "user"}).status_code == 400


def test_admin_creates_and_deletes(users, admin):
    r = admin.post("/api/users", json={"name": "Новый", "email": "new@test.local", "username": "newbie-x", "password": "start-pass"})
    assert r.status_code == 200 and "password" not in r.text
    uid = r.json()["id"]
    assert admin.post("/api/users", json={"name": "Дубль", "email": "new@test.local", "password": "start-pass"}).status_code == 409
    assert admin.delete(f"/api/users/{uid}").status_code == 200


def test_departments_admin_only(users, admin, anna):
    assert anna.post("/api/departments", json={"name": "Хак"}).status_code == 403
    d = admin.post("/api/departments", json={"name": "Продажи-тест", "color": "#fff"})
    assert d.status_code == 200
    did = d.json()["id"]
    assert anna.get("/api/departments").status_code == 200
    assert anna.put(f"/api/departments?id={did}", json={"name": "x"}).status_code == 403
    assert admin.put(f"/api/departments?id={did}", json={"name": "Продажи-2"}).status_code == 200
    assert admin.delete(f"/api/departments?id={did}").status_code == 200


# ── админка ──────────────────────────────────────────────────────────────

def test_admin_area_requires_admin(anna, admin):
    for path in ("/api/admin/overview", "/api/admin/system", "/api/admin/settings", "/api/admin/audit", "/api/admin/errors", "/api/client-errors"):
        assert anna.get(path).status_code == 403, path
        assert admin.get(path).status_code == 200, path
    assert anna.post("/api/admin/system/echo").status_code == 403


def test_admin_overview(admin):
    o = admin.get("/api/admin/overview").json()
    assert o["users"]["total"] >= 4 and o["users"]["admins"] >= 1 and "online" in o["users"]


def test_reset_password_and_audit(users, admin, client):
    uid = users.create("gina")
    r = admin.post(f"/api/admin/users/{uid}/reset-password")
    temp = r.json()["password"]
    assert len(temp) >= 10 and "password" not in r.json()["user"]
    from tests.conftest import UserClient

    assert UserClient(client).post("/api/auth/login", json={"username": uid, "password": temp}).status_code == 200
    entries = admin.get("/api/admin/audit").json()["entries"]
    assert any(e["action"] == "user.password_reset" and e["target"] == uid for e in entries)
    assert temp not in str(entries)


def test_settings_secrets_are_masked(admin):
    r = admin.put("/api/admin/settings", json={"telegramBotToken": "123456:SECRET-TOKEN-VALUE", "telegramChatId": "-100", "telegramNotifications": True})
    body = r.json()
    assert "SECRET-TOKEN" not in r.text and body["telegramBotTokenSet"] is True and body["telegramBotToken"].startswith("••••")
    # маска, отправленная обратно, токен не затирает
    admin.put("/api/admin/settings", json={"telegramBotToken": body["telegramBotToken"]})
    from app.core.db import db

    assert db.get_settings()["telegramBotToken"] == "123456:SECRET-TOKEN-VALUE"
    assert admin.put("/api/admin/settings", json={"telegramBotToken": None}).json()["telegramBotTokenSet"] is False


def test_system_actions_only_configured(admin):
    assert admin.post("/api/admin/system/echo").json()["output"].strip() == "hello"
    assert admin.post("/api/admin/system/rm-rf").status_code == 404
    assert "echo" in admin.get("/api/admin/system").json()["actions"]


def test_old_settings_routes_are_gone(admin):
    for path in ("/api/settings", "/api/todos/telegram", "/api/test-telegram", "/api/auth/telegram/confirm"):
        assert admin.get(path).status_code in (404, 405), path


def test_request_departments_admin_write(users, admin, anna):
    assert anna.put("/api/request-departments", json={"departmentIds": ["x"]}).status_code == 403
    assert admin.put("/api/request-departments", json={"departmentIds": []}).json() == {"departmentIds": []}
    assert anna.get("/api/request-departments").status_code == 200
