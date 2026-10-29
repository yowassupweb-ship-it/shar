"""Соцсети: правка и удаление сообщений — своих ответов из Шара и сообщений клиента на площадке.
Сеть не трогаем: вызовы ВКонтакте и MAX подменены."""

from __future__ import annotations

import itertools
import random

import pytest

from app.core.db import db
from app.modules.social import platforms as P
from app.modules.social import router as R
from app.modules.social import vk
from tests.test_social_vk import GROUP, FakeVk, social_cards

_ids = itertools.count(90_000)


@pytest.fixture()
def fake_vk(monkeypatch):
    fake = FakeVk()
    monkeypatch.setattr(vk, "call", fake)
    return fake


@pytest.fixture()
def vk_account(fake_vk, admin, users):
    chat = admin.post("/api/chats", json={"participantIds": [users.ids["anna"]], "isGroup": True, "title": "ВК правки"}).json()["id"]
    acc = admin.post("/api/social/accounts", json={"platform": "vk", "token": "vk1.a.group-token"}).json()["account"]
    db.conn.execute_query("UPDATE social_accounts SET default_chat_id = %s WHERE id = %s", (chat, acc["id"]))
    secret = db.conn.fetch_one("SELECT secret FROM social_accounts WHERE id = %s", (acc["id"],))["secret"]
    return {**acc, "secret": secret, "chat": chat, "hook": f"/api/social/hook/{acc['id']}/{secret}"}


def _event(account, kind, obj):
    return {"type": kind, "group_id": GROUP, "secret": account["secret"], "object": obj}


def _messages(user, dialog_id):
    return user.get(f"/api/social/dialogs/{dialog_id}").json()["messages"]


def test_vk_subscribes_to_edits(fake_vk, vk_account):
    settings = next(p for m, p in fake_vk.calls if m == "groups.setCallbackSettings")
    assert settings["message_edit"] == 1 and settings["wall_reply_edit"] == 1 and settings["wall_reply_delete"] == 1


def test_vk_edit_and_delete_own_reply(client, admin, anna, fake_vk, vk_account):
    user = 8_000_000 + random.randrange(1_000_000)  # тестовая база живёт между прогонами
    assert client.post(vk_account["hook"], json=_event(vk_account, "message_new", {"message": {"id": next(_ids), "from_id": user, "peer_id": user, "text": f"Есть места? {user}"}})).text == "ok"
    dialog = next(d for d in admin.get("/api/social/dialogs?platform=vk").json()["dialogs"] if d["lastText"] == f"Есть места? {user}")
    assert admin.post(f"/api/social/dialogs/{dialog['id']}/messages", json={"text": "Да, есть"}).status_code == 200
    out = next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "out")
    assert out["canEdit"] and out["canDelete"] and not out["edited"]
    assert not next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "in")["canEdit"]  # чужое не правим

    assert anna.patch(f"/api/social/messages/{out['id']}", json={"text": "x"}).status_code == 403  # нет раздела
    r = admin.patch(f"/api/social/messages/{out['id']}", json={"text": "Да, есть два места"})
    assert r.status_code == 200, r.text
    assert r.json()["message"]["text"] == "Да, есть два места" and r.json()["message"]["edited"] is True
    edit = next(p for m, p in reversed(fake_vk.calls) if m == "messages.edit")
    assert edit["peer_id"] == user and edit["message_id"] == "1001" and edit["message"] == "Да, есть два места"

    # Эхо своей же правки от ВКонтакте ничего не меняет; правка во ВКонтакте — доходит до Шара.
    assert client.post(vk_account["hook"], json=_event(vk_account, "message_edit", {"id": 1001, "peer_id": user, "from_id": -GROUP, "text": "Да, есть два места"})).text == "ok"
    assert client.post(vk_account["hook"], json=_event(vk_account, "message_edit", {"id": 1001, "peer_id": user, "from_id": -GROUP, "text": "Да, три места"})).text == "ok"
    assert next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "out")["text"] == "Да, три места"

    r = admin.delete(f"/api/social/messages/{out['id']}")
    assert r.status_code == 200, r.text
    assert r.json()["message"]["deleted"] is True and r.json()["message"]["canEdit"] is False
    deleted = next(p for m, p in reversed(fake_vk.calls) if m == "messages.delete")
    assert deleted == {"message_ids": "1001", "delete_for_all": 1}
    assert admin.delete(f"/api/social/messages/{out['id']}").status_code == 409
    got = admin.get(f"/api/social/dialogs/{dialog['id']}").json()
    assert got["dialog"]["lastText"] == "Сообщение удалено"


def test_vk_client_edits_and_deletes_comment(client, admin, anna, fake_vk, vk_account):
    user, post, cid = 9_000_000 + random.randrange(1_000_000), next(_ids), next(_ids)
    comment = {"id": cid, "from_id": user, "post_id": post, "owner_id": -GROUP, "text": f"Сколько стоит? {user}"}
    assert client.post(vk_account["hook"], json=_event(vk_account, "wall_reply_new", comment)).text == "ok"
    dialog = next(d for d in admin.get("/api/social/dialogs?kind=comments").json()["dialogs"] if d["lastText"] == f"Сколько стоит? {user}")

    # Комментарий сообщества ключ сообщества править не может — в Шаре кнопок нет, ручка объясняет.
    assert admin.post(f"/api/social/dialogs/{dialog['id']}/messages", json={"text": "От 40 000 ₽"}).status_code == 200
    out = next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "out")
    assert out["canEdit"] is False and out["canDelete"] is False
    assert admin.patch(f"/api/social/messages/{out['id']}", json={"text": "x"}).status_code == 409

    edited = {**comment, "text": f"А сколько стоит на двоих? {user}"}
    assert client.post(vk_account["hook"], json=_event(vk_account, "wall_reply_edit", edited)).text == "ok"
    msg = next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "in")
    assert msg["text"] == f"А сколько стоит на двоих? {user}" and msg["edited"] is True
    card = next(c["metadata"]["card"] for c in social_cards(anna, vk_account["chat"]) if c["metadata"]["card"].get("dialogId") == dialog["id"])
    assert card["text"] == f"А сколько стоит на двоих? {user}" and card["edited"] is True

    gone = {"owner_id": -GROUP, "id": cid, "deleter_id": user, "post_id": post}
    assert client.post(vk_account["hook"], json=_event(vk_account, "wall_reply_delete", gone)).text == "ok"
    assert next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "in")["deleted"] is True
    card = next(c["metadata"]["card"] for c in social_cards(anna, vk_account["chat"]) if c["metadata"]["card"].get("dialogId") == dialog["id"])
    assert card["deleted"] is True

    assert client.post(vk_account["hook"], json=_event(vk_account, "wall_reply_restore", edited)).text == "ok"
    assert next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "in")["deleted"] is False


class FakeMax:
    def __init__(self):
        self.calls = []
        self.fail = ""

    def __call__(self, token, method, path, *, params=None, body=None):
        self.calls.append((method, path, params, body))
        if path == "/me":
            return {"name": "ВС бот", "username": "vs_bot"}
        if path == "/subscriptions" and method == "GET":
            return {"subscriptions": [{"url": f"https://shar.test/api/social/hook/{self.account}/s"}, {"url": "https://other.test/hook"}]}
        if path.startswith("/chats/"):
            return {"title": "Вокруг света"}
        if path.startswith("/messages/") and method == "GET":
            return {"body": {"text": "Новый тур в Карелию"}}
        if method in ("PUT", "DELETE"):
            return {"success": False, "message": self.fail} if self.fail else {"success": True}
        if path.endswith("/comments"):
            return {"message": {"body": {"mid": f"c-{next(_ids)}"}}}
        if path == "/messages":
            return {"message": {"body": {"mid": f"m-{next(_ids)}"}}}
        return {}

    account = ""


@pytest.fixture()
def max_account(monkeypatch, admin):
    fake = FakeMax()
    monkeypatch.setattr(P, "max_call", fake)
    acc = admin.post("/api/social/accounts", json={"platform": "max", "token": "max-token"}).json()["account"]
    secret = db.conn.fetch_one("SELECT secret FROM social_accounts WHERE id = %s", (acc["id"],))["secret"]
    fake.account = acc["id"]
    return {**acc, "fake": fake, "hook": f"/api/social/hook/{acc['id']}/{secret}"}


def test_max_message_edit_delete_both_ways(client, admin, max_account):
    fake = max_account["fake"]
    sub = next(b for m, p, _, b in fake.calls if p == "/subscriptions" and m == "POST")
    assert {"message_edited", "message_removed", "comment_edited", "comment_removed"} <= set(sub["update_types"])
    chat, mid, user = next(_ids), f"mid.{next(_ids)}", next(_ids)
    new = {"update_type": "message_created", "message": {"sender": {"user_id": user, "name": "Олег"}, "recipient": {"chat_id": chat, "chat_type": "dialog"},
                                                          "body": {"mid": mid, "text": f"Добрый день {user}"}}}
    assert client.post(max_account["hook"], json=new).status_code == 200
    dialog = next(d for d in admin.get("/api/social/dialogs?platform=max").json()["dialogs"] if d["lastText"] == f"Добрый день {user}")
    assert admin.post(f"/api/social/dialogs/{dialog['id']}/messages", json={"text": "Здравствуйте"}).status_code == 200
    out = next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "out")

    r = admin.patch(f"/api/social/messages/{out['id']}", json={"text": "Здравствуйте, Олег"})
    assert r.status_code == 200, r.text
    method, path, params, body = fake.calls[-1]
    assert (method, path) == ("PUT", "/messages") and params["message_id"].startswith("m-")
    assert body == {"text": "Здравствуйте, Олег", "link": {"type": "reply", "mid": mid}}

    fake.fail = "Bot is not admin"
    r = admin.delete(f"/api/social/messages/{out['id']}")
    assert r.status_code == 502 and "права администратора" in r.json()["detail"]
    fake.fail = ""
    assert admin.delete(f"/api/social/messages/{out['id']}").status_code == 200
    assert fake.calls[-1][:2] == ("DELETE", "/messages")

    # Клиент исправил, потом удалил своё сообщение.
    edited = {**new, "update_type": "message_edited", "message": {**new["message"], "body": {"mid": mid, "text": f"Добрый вечер {user}"}}}
    assert client.post(max_account["hook"], json=edited).status_code == 200
    msg = next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "in")
    assert msg["text"] == f"Добрый вечер {user}" and msg["edited"] is True
    assert client.post(max_account["hook"], json={"update_type": "message_removed", "message_id": mid, "chat_id": chat, "user_id": user}).status_code == 200
    assert next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "in")["deleted"] is True
    # Ответить больше не на что: единственное сообщение клиента удалено.
    assert admin.post(f"/api/social/dialogs/{dialog['id']}/messages", json={"text": "Ау"}).status_code == 409


def test_max_comment_edit_limit(client, admin, max_account):
    fake = max_account["fake"]
    cid, user = f"mid.{next(_ids)}", next(_ids)
    comment = {"update_type": "comment_created", "message": {"sender": {"user_id": user, "name": "Ирина"}, "recipient": {"chat_id": -51, "chat_type": "channel", "post_id": "post-7"},
                                                             "body": {"mid": cid, "text": f"Цена? {user}"}}}
    assert client.post(max_account["hook"], json=comment).status_code == 200
    dialog = next(d for d in admin.get("/api/social/dialogs?kind=comments&platform=max").json()["dialogs"] if d["lastText"] == f"Цена? {user}")
    assert admin.post(f"/api/social/dialogs/{dialog['id']}/messages", json={"text": "От 25 000 ₽"}).status_code == 200
    out = next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "out")
    assert out["canEdit"] and out["canDelete"]

    assert admin.patch(f"/api/social/messages/{out['id']}", json={"text": "От 24 000 ₽"}).status_code == 200
    method, path, params, body = fake.calls[-1]
    assert (method, path, body) == ("PUT", "/messages/post-7/comments", {"text": "От 24 000 ₽"}) and params["comment_id"].startswith("c-")
    fake.fail = "comments.timeout_exceeded: too late"
    r = admin.patch(f"/api/social/messages/{out['id']}", json={"text": "От 23 000 ₽"})
    assert r.status_code == 502 and "26 часов" in r.json()["detail"]
    fake.fail = ""

    assert client.post(max_account["hook"], json={"update_type": "comment_removed", "message_id": cid, "chat_id": -51, "post_id": "post-7"}).status_code == 200
    assert next(m for m in _messages(admin, dialog["id"]) if m["direction"] == "in")["deleted"] is True


def test_refresh_subscriptions_once(admin, max_account):
    fake = max_account["fake"]
    db.conn.execute_query("UPDATE social_accounts SET extra = extra - 'events' WHERE platform = 'max'")
    # Сообщества ВКонтакте из других тестов уже подписаны — сюда их не тянем (их сеть здесь не подменена).
    version = len(vk.VK_EVENTS) * 100 + len(P.MAX_UPDATES)
    db.conn.execute_query("UPDATE social_accounts SET extra = extra || %s::jsonb WHERE platform <> 'max'", (f'{{"events": {version}}}',))
    fake.calls.clear()
    R.refresh_subscriptions()
    posted = [(p, b) for m, p, _, b in fake.calls if m == "POST" and p == "/subscriptions"]
    assert posted and all("message_removed" in b["update_types"] for _, b in posted)
    assert any(f"/hook/{max_account['id']}/" in b["url"] for _, b in posted)
    fake.calls.clear()
    R.refresh_subscriptions()
    assert not [c for c in fake.calls if c[0] == "POST"]
