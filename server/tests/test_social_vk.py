"""ВКонтакте: подключение сообщества, подтверждение адреса, сообщения и комментарии, ответ клиенту.
Сеть не трогаем: вызовы API ВКонтакте подменены."""

from __future__ import annotations

import itertools
import random

import pytest

from app.modules.social import vk

GROUP = 4242
_ids = itertools.count(500)


class FakeVk:
    """Запоминает вызовы и отвечает так, как ответил бы ВКонтакте."""

    def __init__(self):
        self.calls = []

    def __call__(self, token, method, **params):
        self.calls.append((method, params))
        if method == "groups.getById":
            return {"groups": [{"id": GROUP, "name": "Вокруг света", "screen_name": "vokrugsveta"}]}
        if method == "groups.getCallbackConfirmationCode":
            return {"code": "a1b2c3"}
        if method == "groups.getCallbackServers":
            return {"items": []}
        if method == "groups.addCallbackServer":
            return {"server_id": 7}
        if method == "users.get":
            return [{"id": int(params["user_ids"]), "first_name": "Мария", "last_name": "Орлова", "screen_name": "m_orlova"}]
        if method == "wall.getById":
            return {"items": [{"text": "Байкал зимой: старт продаж"}]}
        if method == "messages.send":
            return 1001
        if method == "wall.createComment":
            return {"comment_id": 55}
        if method in ("photos.getMessagesUploadServer", "docs.getMessagesUploadServer"):
            return {"upload_url": "https://upload.vk.test/x"}
        if method == "photos.saveMessagesPhoto":
            return [{"owner_id": -GROUP, "id": 5, "access_key": "k"}]
        if method == "docs.save":
            return {"type": "doc", "doc": {"owner_id": -GROUP, "id": 9}}
        return 1


@pytest.fixture()
def fake_vk(monkeypatch):
    fake = FakeVk()
    monkeypatch.setattr(vk, "call", fake)
    return fake


@pytest.fixture()
def vk_account(fake_vk, admin, users):
    chat = admin.post("/api/chats", json={"participantIds": [users.ids["anna"]], "isGroup": True, "title": "ВК"}).json()["id"]
    r = admin.post("/api/social/accounts", json={"platform": "vk", "token": "vk1.a.group-token"})
    assert r.status_code == 200, r.text
    acc = r.json()["account"]
    assert acc["title"] == "Вокруг света" and acc["botUsername"] == "vokrugsveta"
    from app.core.db import db

    row = db.conn.fetch_one("SELECT secret, extra FROM social_accounts WHERE id = %s", (acc["id"],))
    assert row["extra"] == {"groupId": GROUP, "confirmation": "a1b2c3", "serverId": 7}
    db.conn.execute_query("UPDATE social_accounts SET default_chat_id = %s WHERE id = %s", (chat, acc["id"]))
    settings = next(p for m, p in fake_vk.calls if m == "groups.setCallbackSettings")
    assert settings["message_new"] == 1 and settings["wall_reply_new"] == 1 and settings["server_id"] == 7
    return {**acc, "secret": row["secret"], "chat": chat, "hook": f"/api/social/hook/{acc['id']}/{row['secret']}"}


def social_cards(user, chat_id):
    msgs = user.get(f"/api/chats/{chat_id}/messages").json()
    msgs = msgs.get("messages", msgs) if isinstance(msgs, dict) else msgs
    return [m for m in msgs if (m.get("metadata") or {}).get("card", {}).get("kind") == "social"]


def test_confirmation_and_secret(client, vk_account):
    r = client.post(vk_account["hook"], json={"type": "confirmation", "group_id": GROUP})
    assert r.status_code == 200 and r.text == "a1b2c3"
    assert client.post(vk_account["hook"], json={"type": "confirmation", "group_id": 1}).status_code == 404
    bad = {"type": "message_new", "group_id": GROUP, "secret": "wrong", "object": {"message": {"id": 1, "from_id": 5, "peer_id": 5, "text": "x"}}}
    assert client.post(vk_account["hook"], json=bad).status_code == 404


def test_message_and_wall_comment(client, anna, fake_vk, vk_account):
    mid = next(_ids)
    msg = {"type": "message_new", "group_id": GROUP, "secret": vk_account["secret"], "event_id": f"e{mid}",
           "object": {"message": {"id": mid, "from_id": 31, "peer_id": 31, "text": "Есть места на ноябрь?"}}}
    for _ in range(2):  # ВКонтакте повторил событие
        r = client.post(vk_account["hook"], json=msg)
        assert r.status_code == 200 and r.text == "ok"
    cid = next(_ids)
    wall = {"type": "wall_reply_new", "group_id": GROUP, "secret": vk_account["secret"],
            "object": {"id": cid, "from_id": 31, "post_id": 900, "owner_id": -GROUP, "text": "Сколько стоит?"}}
    assert client.post(vk_account["hook"], json=wall).text == "ok"
    photo = {"type": "photo_comment_new", "group_id": GROUP, "secret": vk_account["secret"],
             "object": {"id": next(_ids), "from_id": 31, "photo_id": 12, "photo_owner_id": -GROUP, "text": "Красиво!"}}
    assert client.post(vk_account["hook"], json=photo).text == "ok"

    cards = social_cards(anna, vk_account["chat"])
    by_text = {c["metadata"]["card"]["text"]: c["metadata"]["card"] for c in cards}
    assert [c["metadata"]["card"]["text"] for c in cards].count("Есть места на ноябрь?") == 1
    dm = by_text["Есть места на ноябрь?"]
    assert dm["authorName"] == "Мария Орлова" and dm["sourceType"] == "private" and dm["link"] == f"https://vk.com/gim{GROUP}?sel=31"
    comment = by_text["Сколько стоит?"]
    assert comment["link"] == f"https://vk.com/wall-{GROUP}_900?reply={cid}" and comment["context"] == "Байкал зимой: старт продаж"
    assert comment["canReply"] is True and by_text["Красиво!"]["canReply"] is False

    r = anna.post(f"/api/social/items/{dm['itemId']}/reply", json={"text": "Да, есть"})
    assert r.status_code == 200, r.text
    send = next(p for m, p in fake_vk.calls if m == "messages.send")
    assert send["peer_id"] == 31 and send["message"] == "Да, есть"
    r = anna.post(f"/api/social/items/{comment['itemId']}/reply", json={"text": "От 48 900 ₽"})
    assert r.status_code == 200, r.text
    created = next(p for m, p in fake_vk.calls if m == "wall.createComment")
    assert created == {"owner_id": -GROUP, "post_id": 900, "from_group": GROUP, "message": "От 48 900 ₽", "reply_to_comment": cid}
    r = anna.post(f"/api/social/items/{by_text['Красиво!']['itemId']}/reply", json={"text": "Спасибо"})
    assert r.status_code == 502 and "только на самом сайте" in r.json()["detail"]


def test_dialogs_group_client_messages(client, admin, anna, fake_vk, vk_account):
    hook, secret = vk_account["hook"], vk_account["secret"]
    user = 7_000_000 + random.randrange(1_000_000)  # тестовая база живёт между прогонами
    for text in ("Здравствуйте", f"Есть туры на Алтай? {user}"):
        mid = next(_ids)
        assert client.post(hook, json={"type": "message_new", "group_id": GROUP, "secret": secret,
                                       "object": {"message": {"id": mid, "from_id": user, "peer_id": user, "text": text}}}).text == "ok"
    post = next(_ids)
    assert client.post(hook, json={"type": "wall_reply_new", "group_id": GROUP, "secret": secret,
                                   "object": {"id": next(_ids), "from_id": user, "post_id": post, "owner_id": -GROUP, "text": f"А цена? {user}"}}).text == "ok"
    assert client.post(hook, json={"type": "photo_comment_new", "group_id": GROUP, "secret": secret,
                                   "object": {"id": next(_ids), "from_id": user, "photo_id": post, "photo_owner_id": -GROUP, "text": f"Где это? {user}"}}).text == "ok"

    assert anna.get("/api/social/dialogs").status_code == 403  # раздел — только по выдаче
    dialogs = admin.get("/api/social/dialogs?filter=waiting&platform=vk").json()["dialogs"]
    # Вкладки раздела: личные и беседы отдельно от комментариев.
    assert {d["kind"] for d in admin.get("/api/social/dialogs?kind=comments").json()["dialogs"]} == {"comments"}
    assert "comments" not in {d["kind"] for d in admin.get("/api/social/dialogs?kind=dialogs").json()["dialogs"]}
    mine = [d for d in dialogs if d["lastText"] in (f"Есть туры на Алтай? {user}", f"А цена? {user}", f"Где это? {user}")]
    assert sorted(d["kind"] for d in mine) == ["comments", "comments", "private"]
    dm = next(d for d in mine if d["kind"] == "private")
    assert dm["platform"] == "vk" and dm["title"] == "Мария Орлова" and dm["waiting"] is True

    r = admin.post(f"/api/social/dialogs/{dm['id']}/messages", json={"text": "Есть, на май"})
    assert r.status_code == 200, r.text
    assert next(p for m, p in reversed(fake_vk.calls) if m == "messages.send")["peer_id"] == user
    got = admin.get(f"/api/social/dialogs/{dm['id']}").json()
    assert [(m["direction"], m["text"]) for m in got["messages"]] == [("in", "Здравствуйте"), ("in", f"Есть туры на Алтай? {user}"), ("out", "Есть, на май")]
    assert got["dialog"]["waiting"] is False and got["canReply"] is True
    assert dm["id"] not in [d["id"] for d in admin.get("/api/social/dialogs?filter=waiting").json()["dialogs"]]

    photo = next(d for d in mine if d["lastText"] == f"Где это? {user}")
    assert admin.get(f"/api/social/dialogs/{photo['id']}").json()["canReply"] is False
    assert admin.post(f"/api/social/dialogs/{photo['id']}/messages", json={"text": "Байкал"}).status_code == 409


def test_notifications_follow_settings(monkeypatch, client, admin, anna, users, fake_vk, vk_account):
    from app.modules.social import notify as N

    events, pushes = [], []
    monkeypatch.setattr(N.sse_manager, "push", lambda uid, ev: events.append((uid, ev)) if ev.get("type") == "social_message" else None)
    # Карточка в чате (дублирование включено в фикстуре) шлёт свои пуши — считаем только пуши модуля.
    monkeypatch.setattr(N.push_service, "notify", lambda ids, **kw: pushes.append((list(ids), kw)) if kw.get("tag", "").startswith("social-") else None)
    monkeypatch.setattr(N, "_call_presence_count", lambda uid: 0)  # никто не в сети — пуш всем получателям
    a, an = users.ids["admin"], users.ids["anna"]

    assert anna.get("/api/social/notify").status_code == 403
    r = admin.put("/api/social/notify", json={"dialogs": {"to": "all"}, "comments": {"to": "selected", "users": [an]}, "desktop": True, "push": True})
    assert r.status_code == 200
    people = [p["id"] for p in admin.get("/api/social/notify").json()["people"]]
    assert a in people and an not in people  # выбирать можно только тех, у кого есть доступ

    hook, secret, user = vk_account["hook"], vk_account["secret"], 9_000_000 + random.randrange(1_000_000)
    dm = {"type": "message_new", "group_id": GROUP, "secret": secret, "object": {"message": {"id": next(_ids), "from_id": user, "peer_id": user, "text": "Привет"}}}
    assert client.post(hook, json=dm).text == "ok"
    got = {uid for uid, _ in events}
    assert a in got and an not in got  # у Анны нет доступа к модулю
    ev = next(e for uid, e in events if uid == a)
    assert ev["kind"] == "dialogs" and ev["title"] == "ВКонтакте: Мария Орлова" and ev["url"].startswith("/social?dialog=")
    assert a in pushes[-1][0]

    # Комментарии — только выбранным: Анна выбрана, но доступа нет → никому; выдаём доступ — ей одной.
    events.clear()
    wall = {"type": "wall_reply_new", "group_id": GROUP, "secret": secret, "object": {"id": next(_ids), "from_id": user, "post_id": 77, "owner_id": -GROUP, "text": "Цена?"}}
    assert client.post(hook, json=wall).text == "ok"
    assert events == []
    from app.core.db import db

    db.update_user(an, {"enabledTools": ["social"]})
    try:
        wall["object"]["id"] = next(_ids)
        assert client.post(hook, json=wall).text == "ok"
        assert {uid for uid, _ in events} == {an}
        assert events[0][1]["url"].startswith("/social?tab=comments&dialog=")
        # Выключили «на компьютере» и пуш — тихо.
        admin.put("/api/social/notify", json={"dialogs": {"to": "all"}, "comments": {"to": "selected", "users": [an]}, "desktop": False, "push": False})
        events.clear()
        n = len(pushes)
        wall["object"]["id"] = next(_ids)
        assert client.post(hook, json=wall).text == "ok"
        assert events == [] and len(pushes) == n
    finally:
        db.update_user(an, {"enabledTools": []})
        admin.put("/api/social/notify", json={})


def test_waiting_badge(client, admin, anna, vk_account):
    assert anna.get("/api/social/waiting").json() == {"dialogs": 0, "comments": 0, "total": 0}  # нет доступа
    before = admin.get("/api/social/waiting").json()
    user = 8_000_000 + random.randrange(1_000_000)
    dm = {"type": "message_new", "group_id": GROUP, "secret": vk_account["secret"], "object": {"message": {"id": next(_ids), "from_id": user, "peer_id": user, "text": "?"}}}
    assert client.post(vk_account["hook"], json=dm).text == "ok"
    after = admin.get("/api/social/waiting").json()
    assert after["dialogs"] == before["dialogs"] + 1 and after["total"] == after["dialogs"] + after["comments"]
    admin.put("/api/social/notify", json={"dialogs": {"to": "selected", "users": []}})
    try:
        assert admin.get("/api/social/waiting").json()["dialogs"] == 0  # диалоги не мои — значок их не считает
    finally:
        admin.put("/api/social/notify", json={})



def test_send_photo_and_file_to_vk_dialog(monkeypatch, client, admin, fake_vk, vk_account):
    uploads = []
    monkeypatch.setattr(vk, "_upload", lambda url, field, name, data, ct: uploads.append((field, name, ct)) or (
        {"photo": "p", "server": 1, "hash": "h"} if field == "photo" else {"file": "f"}))
    user = 6_000_000 + random.randrange(1_000_000)
    dm = {"type": "message_new", "group_id": GROUP, "secret": vk_account["secret"], "object": {"message": {"id": next(_ids), "from_id": user, "peer_id": user, "text": "Пришлите программу"}}}
    assert client.post(vk_account["hook"], json=dm).text == "ok"
    dialog = next(d for d in admin.get("/api/social/dialogs").json()["dialogs"] if d["lastText"] == "Пришлите программу")

    photo = admin.post("/api/upload", files={"file": ("baikal.jpg", bytes([0xFF, 0xD8, 0xFF]) + b"0" * 100, "image/jpeg")}).json()
    doc = admin.post("/api/upload", files={"file": ("programma.pdf", b"%PDF-1.4 test", "application/pdf")}).json()
    atts = [{"url": photo["url"], "name": "baikal.jpg", "type": "image/jpeg"}, {"url": doc["url"], "name": "programma.pdf", "type": "application/pdf"}]

    assert admin.post(f"/api/social/dialogs/{dialog['id']}/messages", json={"attachments": [{"url": "https://evil.test/x", "name": "x"}]}).status_code == 400
    r = admin.post(f"/api/social/dialogs/{dialog['id']}/messages", json={"text": "", "attachments": atts})
    assert r.status_code == 200, r.text
    assert [(f, n) for f, n, _ in uploads] == [("photo", "baikal.jpg"), ("file", "programma.pdf")]
    send = next(p for m, p in reversed(fake_vk.calls) if m == "messages.send")
    assert send["attachment"] == f"photo-{GROUP}_5_k,doc-{GROUP}_9" and "message" not in send
    last = admin.get(f"/api/social/dialogs/{dialog['id']}").json()["messages"][-1]
    assert last["direction"] == "out" and last["media"] == ["📎 baikal.jpg", "📎 programma.pdf"]
