"""Задачи, календарь, файлы, стикеры, пуши, интеграции, облако, почта, заявки."""

from __future__ import annotations

import json
import uuid

# ── задачи ─────────────────────────────────────────────────────────────────

def test_todos_visibility(users, anna, boris, clara):
    r = anna.post("/api/todos", json={"title": "Секретная задача", "assignedToId": users.ids["boris"], "assignedToIds": [users.ids["boris"]], "authorId": users.ids["clara"]})
    assert r.status_code == 200, r.text
    task = r.json()
    assert task["authorId"] == users.ids["anna"]  # автор — вошедший, не из тела
    tid = task["id"]
    titles = lambda c: [t["title"] for t in c.get("/api/todos").json()["todos"]]  # noqa: E731
    assert "Секретная задача" in titles(anna) and "Секретная задача" in titles(boris)
    assert "Секретная задача" not in titles(clara)           # без userId раньше отдавало всё
    assert clara.get(f"/api/todos?taskId={tid}").status_code == 403
    assert clara.put("/api/todos", json={"id": tid, "title": "взлом"}).status_code == 403
    assert clara.delete(f"/api/todos?id={tid}").status_code == 403
    assert boris.delete(f"/api/todos?id={tid}").status_code == 403          # исполнитель не удаляет
    assert boris.put("/api/todos", json={"id": tid, "status": "in-progress"}).status_code == 200
    assert anna.delete(f"/api/todos?id={tid}").status_code == 200


# ── календарь ──────────────────────────────────────────────────────────────

def test_calendar_owner_rules(users, anna, boris):
    ev = anna.post("/api/events", json={"title": "Личное", "startDateTime": "2030-01-01T10:00:00", "type": "personal", "createdBy": users.ids["boris"], "participants": [], "sharedWithAll": False})
    assert ev.status_code == 200, ev.text
    eid = ev.json()["id"]
    assert ev.json().get("createdBy", users.ids["anna"]) == users.ids["anna"]
    assert boris.get(f"/api/events/{eid}").status_code == 404                  # чужое «только я»
    assert boris.put(f"/api/events/{eid}", json={"title": "x"}).status_code in (403, 404)
    assert boris.delete(f"/api/events/{eid}").status_code in (403, 404)
    assert anna.delete(f"/api/events/{eid}").status_code == 200


def test_event_types_admin_only(admin, anna):
    assert anna.post("/api/event-types", json={"id": "t1", "name": "n", "color": "c", "icon": "i"}).status_code == 403
    assert admin.post("/api/event-types", json={"id": "t-test", "name": "n", "color": "c", "icon": "i"}).status_code == 200
    assert admin.delete("/api/event-types?id=t-test").status_code == 200


# ── файлы ──────────────────────────────────────────────────────────────────

def test_upload_flow_and_hardening(anna, client):
    assert client.post("/api/upload", files={"file": ("a.txt", b"x")}).status_code == 401
    r = anna.post("/api/upload", files={"file": ("доклад.txt", b"hello")})
    assert r.status_code == 200
    url = r.json()["url"]
    assert anna.get(url).content == b"hello"
    assert client.get(url).content == b"hello"                                   # вложения открываются по прямой ссылке
    assert client.get("/api/uploads/..%2f..%2fetc%2fpasswd").status_code in (400, 404)
    bad = anna.post("/api/upload", files={"file": ("x.php\x00.png", b"x")})
    assert bad.status_code == 200 and "\x00" not in bad.json()["url"]
    html = anna.post("/api/upload", files={"file": ("p.html", b"<script>alert(1)</script>")}).json()["url"]
    resp = client.get(html)
    assert "attachment" in resp.headers.get("content-disposition", "") and resp.headers["content-type"].startswith("application/octet-stream")


def test_svg_is_an_image_but_sandboxed(anna, client):
    """SVG рисуется в <img> (нужен image/svg+xml), но прямое открытие адреса не исполняет его скрипты."""
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>'
    url = anna.post("/api/upload", files={"file": ("logo.svg", svg, "image/svg+xml")}).json()["url"]
    resp = client.get(url)
    assert resp.status_code == 200 and resp.headers["content-type"].startswith("image/svg+xml")
    assert resp.headers["content-security-policy"].startswith("sandbox")
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert "attachment" not in resp.headers.get("content-disposition", "")


def test_local_presigned_put_cannot_overwrite(anna):
    pre = anna.post("/api/upload/presign", json={"filename": "f.bin", "content_type": "application/octet-stream"}).json()
    name = pre["presigned_url"].rsplit("/", 1)[1]
    assert anna.put(f"/api/upload/local/{name}", content=b"1").status_code == 200
    assert anna.put(f"/api/upload/local/{name}", content=b"2").status_code == 409
    assert anna.put("/api/upload/local/known-file.txt", content=b"x").status_code == 400
    done = anna.post("/api/upload/complete", json={"key": f"uploads/{name}", "filename": "f.bin", "content_type": "x", "size": 1})
    assert done.status_code == 200
    assert anna.post("/api/upload/complete", json={"key": "private/secret.pdf", "filename": "s", "content_type": "x", "size": 1}).status_code == 400


def test_avatar_only_for_self(users, anna, boris):
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    files = {"file": ("a.png", png, "image/png")}
    assert boris.post("/api/avatars", files=files, data={"userId": users.ids["anna"]}).status_code == 403
    ok = anna.post("/api/avatars", files={"file": ("a.png", png, "image/png")}, data={"userId": users.ids["anna"]})
    assert ok.status_code == 200 and ok.json()["avatarUrl"].startswith("/api/avatars/file/")
    fake = anna.post("/api/avatars", files={"file": ("a.png", b"<html>", "image/png")}, data={"userId": users.ids["anna"]})
    assert fake.status_code == 400
    assert anna.get(ok.json()["avatarUrl"]).content == png
    assert boris.delete(f"/api/avatars?userId={users.ids['anna']}").status_code == 403


def test_sticker_paths_are_validated(anna):
    assert anna.post("/api/stickers/import", json={"setName": "../../etc"}).status_code == 400
    assert anna.delete("/api/stickers/sets/..").status_code in (400, 404, 405)
    assert anna.get("/api/stickers/sets/..%2f..").status_code in (400, 404)
    assert anna.get("/api/stickers/file/ok_set/..%2f..%2fx").status_code in (400, 404)
    assert anna.get("/api/stickers/sets").status_code == 200


# ── пуши ───────────────────────────────────────────────────────────────────

def test_push_subscriptions_belong_to_me(users, anna, boris):
    from app.modules.push import service

    sub = {"endpoint": "https://push.example.test/abc", "keys": {"p256dh": "k", "auth": "a"}}
    if not service.is_configured():
        assert anna.post("/api/push/subscriptions", json={"subscription": sub, "userId": users.ids["boris"]}).status_code == 503
        from app.modules.push import store

        store.upsert_subscription(users.ids["anna"], sub)
    else:
        assert anna.post("/api/push/subscriptions", json={"subscription": sub, "userId": users.ids["boris"]}).status_code == 200
    state = anna.get("/api/push/subscriptions").json()
    assert state["userId"] == users.ids["anna"] and state["count"] == 1
    assert boris.get("/api/push/subscriptions").json()["count"] == 0
    assert boris.delete("/api/push/subscriptions", json={"endpoint": sub["endpoint"]}).json()["removed"] == 0
    assert anna.delete("/api/push/subscriptions", json={"endpoint": sub["endpoint"]}).json()["removed"] == 1


def test_push_prefs_per_user(users, anna, boris):
    assert anna.post("/api/push/prefs", json={"reactions": False}).json() == {"reactions": False}
    assert boris.get("/api/push/prefs").json() == {}


def test_push_notify_rules(users, anna, client):
    body = {"recipientIds": [users.ids["boris"]], "title": "Фишинг", "body": "пройдите по ссылке", "tag": "message"}
    assert client.post("/api/push/notify", json=body).status_code == 401
    assert anna.post("/api/push/notify", json=body).status_code == 403            # произвольный текст с клиента нельзя
    react = {**body, "tag": "reaction-1", "title": "x"}
    assert anna.post("/api/push/notify", json=react).status_code == 200
    ok = client.post("/api/push/notify", json=body, headers={"x-shar-internal-key": "push-key"})
    assert ok.status_code == 200
    assert client.post("/api/push/notify", json=body, headers={"x-shar-internal-key": "wrong"}).status_code == 401


# ── внешний API уведомлений ────────────────────────────────────────────────

def test_integration_api_contract(users, client, boris):
    h = {"x-shar-api-key": "int-key"}
    assert client.get("/api/integrations/users").status_code == 401
    assert client.get("/api/integrations/users", headers={"x-shar-api-key": "bad"}).status_code == 401
    listing = client.get("/api/integrations/users", headers=h).json()
    assert listing["count"] >= 1 and "password" not in json.dumps(listing)
    assert "departments" in client.get("/api/integrations/departments", headers=h).json()

    payload = {"text": "Заказ №1 оплачен", "userIds": [users.ids["boris"]], "title": "Оплата", "documentId": "1",
               "documentType": "order", "actionUrl": "https://manager.example/orders/1", "fromName": "Менеджерка"}
    r = client.post("/api/integrations/notifications", json=payload, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["deliveredCount"] == 1 and r.json()["status"] == "ok"
    chat = boris.get(f"/api/chats/notifications/{users.ids['boris']}").json()
    msgs = boris.get(f"/api/chats/{chat['id']}/messages").json()["messages"]
    mine = [m for m in msgs if "Заказ №1" in m["content"]]
    assert mine and mine[0]["metadata"]["actionUrl"] == "https://manager.example/orders/1" and mine[0]["metadata"]["source"] == "manager"

    assert client.post("/api/integrations/notifications", json={**payload, "actionUrl": "javascript:alert(1)"}, headers=h).status_code == 400
    assert client.post("/api/integrations/notifications", json={"text": "x"}, headers=h).status_code == 400
    # по username/email тоже
    by_name = client.post("/api/integrations/notifications", json={"text": "по логину", "userIds": [users.ids["boris"]]}, headers=h)
    assert by_name.json()["deliveredCount"] == 1


# ── облако ─────────────────────────────────────────────────────────────────

def test_cloud_access(users, anna, boris):
    f = anna.post("/api/cloud/folders", json={"name": "Секреты"}).json()
    assert f["ownerId"] == users.ids["anna"]
    assert boris.get(f"/api/cloud/folders/{f['id']}").status_code == 404
    assert boris.delete(f"/api/cloud/folders/{f['id']}").status_code in (200,)  # владелец проверяется на уровне запроса
    assert anna.get(f"/api/cloud/folders/{f['id']}").status_code == 200        # чужое удаление не сработало
    bad = anna.post("/api/cloud/files", json={"name": "x", "url": "/api/uploads/x", "s3Key": "other/private.pdf"})
    assert bad.status_code == 400
    shared = anna.put(f"/api/cloud/folders/{f['id']}/access", json={"sharedWith": [users.ids["boris"]]})
    assert shared.status_code == 200
    assert boris.get(f"/api/cloud/folders/{f['id']}").status_code == 200


# ── почта ──────────────────────────────────────────────────────────────────

def test_mail_isolation_and_encryption(users, anna, boris):
    r = anna.post("/api/mail/accounts", json={"name": "Рабочая", "email": "a@x.ru", "imapHost": "127.0.0.1", "smtpHost": "127.0.0.1",
                                              "username": "a", "password": "mail-secret-1", "userId": users.ids["boris"]})
    assert r.status_code == 200, r.text
    assert "password" not in r.text.lower()
    aid = r.json()["id"]
    from app.core.db import db

    stored = db.conn.fetch_one("SELECT password_enc, user_id FROM email_accounts WHERE id = %s", (aid,))
    assert stored["user_id"] == users.ids["anna"]
    assert stored["password_enc"].startswith("enc1:") and "mail-secret-1" not in stored["password_enc"]
    from app.modules.mail.crypto import _deobfuscate_pw

    assert _deobfuscate_pw(stored["password_enc"]) == "mail-secret-1"
    assert boris.get(f"/api/mail/messages?accountId={aid}").status_code == 404
    assert boris.get(f"/api/mail/unread?accountId={aid}").status_code == 404
    assert boris.get(f"/api/mail/recipients?accountId={aid}").status_code == 404
    assert boris.get("/api/mail/accounts").json() == []
    assert anna.get(f"/api/mail/messages?accountId={aid}").status_code == 200
    assert boris.get("/api/mail/watch-status").status_code == 403


def test_legacy_base64_mail_password_migrates(users):
    import base64

    from app.core.db import db
    from app.modules.mail.crypto import is_encrypted, migrate_legacy_passwords

    acc = db.add_email_account({"user_id": users.ids["clara"], "name": "Старый", "email": "c@x.ru", "imap_host": "h", "imap_port": 993, "smtp_host": "h",
                                "smtp_port": 587, "username": "c", "password_enc": base64.b64encode(b"old-pass").decode(), "use_ssl": True, "signature": ""})
    assert migrate_legacy_passwords() >= 1
    assert is_encrypted(db.conn.fetch_one("SELECT password_enc FROM email_accounts WHERE id = %s", (acc["id"],))["password_enc"])


# ── заявки, утм, превью, уведомления ───────────────────────────────────────

def test_requests_flow(users, admin, anna, boris, clara):
    d = admin.post("/api/departments", json={"name": f"Бухгалтерия-{uuid.uuid4().hex[:6]}"}).json()
    admin.put(f"/api/users/{users.ids['boris']}", json={"departmentIds": [d["id"]], "department": d["id"]})
    admin.put("/api/request-departments", json={"departmentIds": [d["id"]]})
    r = anna.post("/api/requests", json={"departmentId": d["id"], "creatorId": users.ids["clara"]})
    assert r.status_code == 200, r.text
    req = r.json()["request"]
    assert req["creatorId"] == users.ids["anna"] and users.ids["boris"] in req["participantIds"]
    assert req["number"] >= 1
    assert clara.put(f"/api/requests/{req['id']}", json={"resolved": True}).status_code == 403
    assert boris.put(f"/api/requests/{req['id']}", json={"resolved": True}).status_code == 403   # не создатель
    assert anna.put(f"/api/requests/{req['id']}", json={"resolved": True}).json()["resolved"] is True
    assert req["id"] in [x["id"] for x in anna.get("/api/requests").json()["requests"]]
    assert req["id"] not in [x["id"] for x in clara.get("/api/requests").json()["requests"]]
    second = anna.post("/api/requests", json={"departmentId": d["id"]}).json()["request"]
    assert second["number"] == req["number"] + 1
    assert anna.post("/api/requests", json={"departmentId": "нет-такого"}).status_code == 400
    admin.put("/api/request-departments", json={"departmentIds": []})


def test_utm_presets_and_history(anna, boris):
    assert anna.get("/api/utm-presets").json()[0]["id"] == "yandex"
    anna.post("/api/utm-presets", json=[{"id": "x", "name": "X", "source": "x", "medium": "m"}])
    assert boris.get("/api/utm-presets").json()[0]["id"] == "x"
    assert anna.delete("/api/utm-presets").json()["presets"][0]["id"] == "yandex"
    item = anna.post("/api/tracked-posts", json={"title": "t", "utmUrl": "https://a?utm_source=x", "platform": "p"}).json()
    assert [i["id"] for i in anna.get("/api/tracked-posts").json()] == [item["id"]]
    assert boris.get("/api/tracked-posts").json() == []                        # история личная
    assert boris.delete(f"/api/tracked-posts/{item['id']}").status_code == 404
    assert anna.delete(f"/api/tracked-posts/{item['id']}").status_code == 200


def test_preview_blocks_internal_addresses(anna, client):
    assert client.get("/api/preview?url=http://example.com").status_code == 401
    for url in ("http://127.0.0.1:8100/api/v2/health", "http://169.254.169.254/latest/meta-data", "http://localhost/", "file:///etc/passwd"):
        r = anna.get("/api/preview", params={"url": url})
        assert r.status_code == 200 and r.json()["description"] == "" and r.json()["image"] == ""


def test_notifications_list_is_private(users, anna, boris):
    from app.modules.notifications.router import create_notification

    nid = f"n-{uuid.uuid4().hex[:6]}"
    create_notification(users.ids["anna"], type="new_task", message="Вам задача", id=nid, todo_id="t1")
    items = anna.get("/api/notifications").json()
    assert [i["id"] for i in items] == [nid] and items[0]["read"] is False
    assert boris.get("/api/notifications").json() == []
    boris.put("/api/notifications", json={"id": nid})
    assert anna.get("/api/notifications").json()[0]["read"] is False        # чужая отметка не действует
    anna.put("/api/notifications", json={"markAllRead": True})
    assert anna.get("/api/notifications").json()[0]["read"] is True


def test_client_errors_public_post_admin_read(client, admin, anna):
    assert client.post("/api/client-errors", json={"message": "boom", "extra": {"big": "x" * 10000}}).status_code == 200
    errors = admin.get("/api/client-errors").json()["errors"]
    assert errors and errors[0]["message"] == "boom" and errors[0]["extra"] == {"truncated": True}
    assert anna.get("/api/client-errors").status_code == 403
