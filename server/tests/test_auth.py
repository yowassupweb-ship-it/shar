"""Вход, сессия, закрытость /api по умолчанию."""

from __future__ import annotations

import uuid


def test_api_is_closed_without_session(client):
    for path in ("/api/users", "/api/chats", "/api/todos", "/api/admin/overview", "/api/push/prefs"):
        assert client.get(path).status_code == 401, path


def test_health_is_public(client):
    r = client.get("/api/v2/health")
    assert r.status_code == 200 and r.json()["db"] == "ok"


def test_login_and_session(users, client):
    r = client.post("/api/auth/login", json={"username": users.ids["anna"], "password": "secret-pass"})
    assert r.status_code == 200 and r.json()["user"]["id"] == users.ids["anna"]
    assert "password" not in r.text
    assert client.get("/api/auth/session").json()["authenticated"] is True
    client.post("/api/auth/logout")
    assert client.get("/api/auth/session").json() == {"authenticated": False}


def test_wrong_password_and_unknown_user_look_the_same(users, client):
    wrong = client.post("/api/auth/login", json={"username": users.ids["anna"], "password": "nope"})
    unknown = client.post("/api/auth/login", json={"username": "nobody-" + uuid.uuid4().hex, "password": "nope"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()


def test_login_is_rate_limited(users, client):
    name = users.ids["clara"]
    codes = [client.post("/api/auth/login", json={"username": name, "password": "bad"}).status_code for _ in range(12)]
    assert 429 in codes
    from app.core.ratelimit import limiter

    limiter.reset(f"login:user:{name.lower()}")


def test_legacy_adopt_endpoint_is_gone(client, users):
    r = client.post("/api/auth/adopt", json={"username": users.ids["anna"]})
    assert r.status_code in (401, 404, 405)


def test_disabled_user_cannot_log_in_and_session_dies(users, admin):
    uid = users.create("dora")
    c = users.login("dora")
    assert c.get("/api/users").status_code == 200
    assert admin.put(f"/api/users/{uid}", json={"isDisabled": True}).status_code == 200
    assert c.get("/api/users").status_code == 401
    assert c.post("/api/auth/login", json={"username": uid, "password": "secret-pass"}).status_code == 401


def test_devices_list_and_revoke_others(users, anna):
    assert anna.get("/api/auth/devices").json()["devices"]
    assert anna.post("/api/auth/devices/revoke-others").status_code == 200
    assert anna.get("/api/auth/session").json()["authenticated"] is True


def test_relogin_replaces_session_and_caps_devices(users):
    """Повторный вход с той же сессией не плодит «призраков»; потолок устройств держится."""
    from app.core import sessions as s
    uid = users.create("loopy")
    device = users.login("loopy")
    old = device.cookies[s.SESSION_COOKIE]
    r = device.post("/api/auth/login", json={"username": uid, "password": "secret-pass"})
    assert r.status_code == 200
    assert device.cookies[s.SESSION_COOKIE] != old
    assert len(s.list_sessions(uid)) == 1  # прежняя заменена, а не добавлена рядом

    for i in range(s.MAX_SESSIONS_PER_USER + 5):  # новые устройства
        s.create_session(uid, uid, user_agent=f"device-{i}")
    s.prune_user_sessions(uid)
    assert len(s.list_sessions(uid)) == s.MAX_SESSIONS_PER_USER
