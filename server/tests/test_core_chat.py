"""«Ядро»: доступ (админ или выданный инструмент), чаты, сообщения, вложения, вопрос агента, отмена, история, демо."""

from __future__ import annotations

import time
import uuid

from app.core.db import db


def _send(c, thread_id, body, **extra):
    r = c.post(f"/api/core/threads/{thread_id}/messages", json={"id": uuid.uuid4().hex, "body": body, **extra})
    assert r.status_code == 201, r.text
    return r.json()["message"]


def test_closed_for_everyone_but_admin_until_granted(admin, anna, users):
    assert anna.get("/api/core/threads").status_code == 403
    assert admin.get("/api/core/threads").status_code == 200
    db.update_user(users.ids["anna"], {"enabledTools": ["core"]})
    try:
        assert anna.get("/api/core/threads").status_code == 200
        assert anna.get("/api/core/catalog").json()["demo"] is False
    finally:
        db.update_user(users.ids["anna"], {"enabledTools": []})


def test_threads_messages_and_privacy(admin, boris, users):
    thread = admin.post("/api/core/threads", json={}).json()["thread"]
    assert thread["title"] == "Новый чат" and thread["messages"] == 0
    first = _send(admin, thread["id"], "Собери сводку по туру в Карелию")
    # Повтор той же отправки по id — не дубль.
    again = admin.post(f"/api/core/threads/{thread['id']}/messages", json={"id": first["id"], "body": "Собери сводку по туру в Карелию"})
    assert again.json()["message"]["id"] == first["id"]
    listed = {t["id"]: t for t in admin.get("/api/core/threads").json()["threads"]}
    assert listed[thread["id"]]["title"].startswith("Собери сводку") and listed[thread["id"]]["messages"] == 1
    # Ответ с цитатой.
    reply = _send(admin, thread["id"], "Только без Кижей", replyTo=first["id"])
    assert reply["props"]["replyTo"]["id"] == first["id"]
    # Переименовать и убрать в архив.
    assert admin.patch(f"/api/core/threads/{thread['id']}", json={"title": "Карелия"}).json()["thread"]["title"] == "Карелия"
    admin.patch(f"/api/core/threads/{thread['id']}", json={"archived": True})
    assert thread["id"] not in {t["id"] for t in admin.get("/api/core/threads").json()["threads"]}
    assert thread["id"] in {t["id"] for t in admin.get("/api/core/threads?archived=true").json()["threads"]}
    # Чужой чат не виден даже тому, кому «Ядро» включено.
    db.update_user(users.ids["boris"], {"enabledTools": ["core"]})
    try:
        assert boris.get(f"/api/core/threads/{thread['id']}/messages").status_code == 404
        assert boris.post(f"/api/core/threads/{thread['id']}/messages", json={"id": uuid.uuid4().hex, "body": "x"}).status_code == 404
    finally:
        db.update_user(users.ids["boris"], {"enabledTools": []})


def test_attachments_only_own_uploads_and_empty_rejected(admin):
    thread = admin.post("/api/core/threads", json={}).json()["thread"]
    assert admin.post(f"/api/core/threads/{thread['id']}/messages", json={"id": uuid.uuid4().hex, "body": "  "}).status_code == 400
    msg = _send(admin, thread["id"], "", attachments=[
        {"name": "программа.pdf", "key": "uploads/123e4567-e89b-12d3-a456-426614174000.pdf", "size": 1024, "type": "application/pdf"},
        {"name": "чужое", "key": "https://evil.example/x.exe", "size": 1, "type": ""},
    ])
    atts = msg["props"]["attachments"]
    assert len(atts) == 1 and all(a["url"].startswith("/api/uploads/") for a in atts)


def test_history_paging(admin):
    thread = admin.post("/api/core/threads", json={}).json()["thread"]
    for i in range(55):
        _send(admin, thread["id"], f"сообщение {i}")
    page = admin.get(f"/api/core/threads/{thread['id']}/messages").json()
    assert len(page["messages"]) == 50 and page["hasMore"] is True and page["messages"][-1]["body"] == "сообщение 54"
    older = admin.get(f"/api/core/threads/{thread['id']}/messages", params={"before": page["messages"][0]["createdAt"]}).json()
    assert [m["body"] for m in older["messages"]] == [f"сообщение {i}" for i in range(5)] and older["hasMore"] is False


def test_demo_reply_ask_and_cancel(admin, users, monkeypatch):
    from app.modules.core_chat import router as Y

    monkeypatch.setattr(Y.time, "sleep", lambda _s: None)
    thread = admin.post("/api/core/threads", json={}).json()["thread"]
    _send(admin, thread["id"], "/demo")
    msgs = admin.get(f"/api/core/threads/{thread['id']}/messages").json()["messages"]
    agent = next(m for m in msgs if m["role"] == "agent")
    assert agent["status"] == "done" and agent["props"]["steps"] and agent["props"]["work"]["output_tokens"] > 0
    assert agent["props"]["ask"] and len(agent["props"]["actions"]) == 3
    # Ответ кнопкой: вопрос помечен, ответ — обычным сообщением с цитатой; второй раз — нельзя.
    r = admin.post(f"/api/core/messages/{agent['id']}/answer", json={"value": "Пока ничего не делай"})
    assert r.status_code == 200 and r.json()["message"]["props"]["replyTo"]["id"] == agent["id"]
    assert admin.post(f"/api/core/messages/{agent['id']}/answer", json={"value": "ещё"}).status_code == 409
    # Отмена: только пока агент работает.
    working = Y.post_agent_message(users.ids["admin"], thread["id"], "Агент", status="working", props={"steps": []})
    assert admin.post(f"/api/core/messages/{working['id']}/cancel").status_code == 200
    assert Y.update_agent_message(working["id"], body="поздно", status="done") is None
    assert admin.post(f"/api/core/messages/{agent['id']}/cancel").status_code == 404
    # Демо отвечает только админу и только по команде.
    _send(admin, thread["id"], "просто текст")
    time.sleep(0.05)
    assert sum(1 for m in admin.get(f"/api/core/threads/{thread['id']}/messages").json()["messages"] if m["role"] == "agent") == 2

