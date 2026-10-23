"""Соцсети: подключение бота, вебхук с секретом, источник → чат, карточка без дублей, ответ клиенту.
Сеть не трогаем: вызовы Telegram подменены."""

from __future__ import annotations

import itertools

import pytest

from app.modules.social import platforms as P

_ids = itertools.count(1000)


def tg_comment(text="Сколько стоит тур?", post_text="Новый тур на Байкал", mid=None):
    mid = mid or next(_ids)
    return {"update_id": mid, "message": {
        "message_id": mid, "chat": {"id": -1001234567890, "type": "supergroup", "title": "Обсуждение канала"},
        "from": {"id": 42, "first_name": "Ольга", "username": "olga"}, "text": text, "message_thread_id": 7,
        "reply_to_message": {"message_id": 7, "is_automatic_forward": True, "text": post_text,
                             "sender_chat": {"id": -1009, "title": "Вокруг света", "username": "vokrugsveta"},
                             "forward_origin": {"type": "channel", "chat": {"id": -1009, "title": "Вокруг света", "username": "vokrugsveta"}, "message_id": 555}},
    }}


def tg_business(text="Здравствуйте, есть места?", mid=None):
    mid = mid or next(_ids)
    return {"update_id": mid, "business_message": {
        "message_id": mid, "business_connection_id": "bc-1", "chat": {"id": 77, "type": "private", "first_name": "Иван"},
        "from": {"id": 77, "first_name": "Иван", "last_name": "Петров"}, "text": text,
    }}


def test_parse_comment_and_business():
    inc = P.tg_parse(tg_comment(mid=900))
    assert inc.chat_type == "comments" and inc.chat_title == "Вокруг света"
    assert inc.link == "https://t.me/vokrugsveta/555?comment=900"
    assert inc.context == "Новый тур на Байкал" and inc.author_name == "Ольга"

    inc = P.tg_parse(tg_business(mid=901))
    assert inc.chat_type == "business" and inc.business_connection_id == "bc-1" and inc.author_name == "Иван Петров"
    # Владелец бизнес-аккаунта сам написал клиенту — это не входящее.
    own = tg_business(mid=902)
    own["business_message"]["from"] = {"id": 1, "first_name": "Менеджер"}
    assert P.tg_parse(own) is None
    # Копия поста в группе обсуждения и сообщения ботов не входящие.
    assert P.tg_parse({"message": {"message_id": 1, "chat": {"id": -100, "type": "supergroup"}, "from": {"id": 1}, "text": "x", "is_automatic_forward": True}}) is None
    assert P.tg_parse({"message": {"message_id": 1, "chat": {"id": 5, "type": "private"}, "from": {"id": 5, "is_bot": True}, "text": "x"}}) is None


@pytest.fixture()
def account(monkeypatch, admin):
    monkeypatch.setattr(P, "tg_connect", lambda token, hook, secret: {"botUsername": "vs_bot", "botName": "ВС бот"})
    r = admin.post("/api/social/accounts", json={"platform": "telegram", "token": "123:abc"})
    assert r.status_code == 200, r.text
    from app.core.db import db

    acc = r.json()["account"]
    acc["secret"] = db.conn.fetch_one("SELECT secret FROM social_accounts WHERE id = %s", (acc["id"],))["secret"]
    return acc


@pytest.fixture()
def social_chat(users, admin):
    r = admin.post("/api/chats", json={"participantIds": [users.ids["anna"]], "isGroup": True, "title": "Соцсети"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def cards(user, chat_id):
    msgs = user.get(f"/api/chats/{chat_id}/messages").json()
    msgs = msgs.get("messages", msgs) if isinstance(msgs, dict) else msgs
    return [m for m in msgs if (m.get("metadata") or {}).get("card", {}).get("kind") == "social"]


def test_access(anna, clara, account):
    assert anna.get("/api/social/accounts").status_code == 403
    assert clara.post("/api/social/accounts", json={"platform": "telegram", "token": "x"}).status_code == 403


def test_webhook_routes_and_dedupes(client, admin, anna, account, social_chat):
    hook = f"/api/social/hook/{account['id']}/{account['secret']}"
    assert client.post(f"/api/social/hook/{account['id']}/wrong", json=tg_comment()).status_code == 404

    # Источник ещё никуда не направлен — сообщение только в ленте раздела.
    first = tg_comment(text="Первый")
    assert client.post(hook, json=first).status_code == 200
    acc = admin.get("/api/social/accounts").json()["accounts"]
    src = next(a for a in acc if a["id"] == account["id"])["sources"]
    assert [(s["title"], s["type"]) for s in src] == [("Вокруг света", "comments")]
    assert any(i["text"] == "Первый" and i["chatId"] is None for i in admin.get("/api/social/items").json()["items"])

    r = admin.put(f"/api/social/accounts/{account['id']}/sources/{src[0]['extChatId']}", json={"chatId": social_chat})
    assert r.status_code == 200, r.text
    second = tg_comment(text="Второй")
    for _ in range(2):  # Telegram повторил доставку
        assert client.post(hook, json=second).status_code == 200
    got = [c for c in cards(anna, social_chat) if c["metadata"]["card"]["text"] == "Второй"]
    assert len(got) == 1
    card = got[0]["metadata"]["card"]
    assert card["link"].startswith("https://t.me/vokrugsveta/555?comment=") and card["status"] == "new"
    assert got[0]["authorName"] == "Telegram"


def test_reply_goes_to_client(monkeypatch, client, admin, anna, clara, account, social_chat):
    from app.core.db import db

    db.conn.execute_query("UPDATE social_accounts SET default_chat_id = %s WHERE id = %s", (social_chat, account["id"]))
    hook = f"/api/social/hook/{account['id']}/{account['secret']}"
    upd = tg_business(text="Есть места на май?")
    assert client.post(hook, json=upd).status_code == 200
    card_msg = next(c for c in cards(anna, social_chat) if c["metadata"]["card"]["text"] == "Есть места на май?")
    item_id = card_msg["metadata"]["card"]["itemId"]

    sent = []
    monkeypatch.setattr(P, "tg_reply", lambda token, chat, mid, text, bc: sent.append((token, chat, mid, text, bc)) or "1")
    assert clara.post(f"/api/social/items/{item_id}/reply", json={"text": "Да"}).status_code == 403
    assert anna.post(f"/api/social/items/{item_id}/reply", json={"text": "  "}).status_code == 400
    r = anna.post(f"/api/social/items/{item_id}/reply", json={"text": "Да, есть, пишу подробности"})
    assert r.status_code == 200, r.text
    assert sent == [("123:abc", "77", str(upd["business_message"]["message_id"]), "Да, есть, пишу подробности", "bc-1")]
    card = next(c for c in cards(anna, social_chat) if c["id"] == card_msg["id"])["metadata"]["card"]
    assert card["status"] == "answered" and card["answers"][0]["text"] == "Да, есть, пишу подробности"

    def boom(*a):
        raise P.PlatformError("Telegram: Forbidden: bot was blocked by the user")

    monkeypatch.setattr(P, "tg_reply", boom)
    r = anna.post(f"/api/social/items/{item_id}/reply", json={"text": "ещё"})
    assert r.status_code == 502 and "blocked" in r.json()["detail"]
