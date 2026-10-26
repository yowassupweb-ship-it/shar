"""Отложенная отправка: только участник, только своё, уходит один раз и от имени автора."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture()
def chat(users, anna):
    r = anna.post("/api/chats", json={"participantIds": [users.ids["boris"]], "isGroup": False})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def later(minutes: int = 60) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


def due_now(scheduled_id: str) -> None:
    from app.core.db import db

    db.conn.execute_query("UPDATE scheduled_messages SET send_at = now() - interval '1 second' WHERE id = %s", (scheduled_id,))


def test_schedule_list_edit_cancel(users, anna, boris, clara, chat):
    assert clara.post(f"/api/chats/{chat}/scheduled", json={"sendAt": later(), "message": {"content": "x"}}).status_code == 403
    assert anna.post(f"/api/chats/{chat}/scheduled", json={"sendAt": later(), "message": {"content": "  "}}).status_code == 400
    assert anna.post(f"/api/chats/{chat}/scheduled", json={"sendAt": later(60 * 24 * 400), "message": {"content": "x"}}).status_code == 400

    r = anna.post(f"/api/chats/{chat}/scheduled", json={"sendAt": later(), "message": {"content": "утром"}})
    assert r.status_code == 201, r.text
    item = r.json()["item"]
    assert item["content"] == "утром"
    assert [i["id"] for i in anna.get(f"/api/chats/{chat}/scheduled").json()["items"]] == [item["id"]]
    assert boris.get(f"/api/chats/{chat}/scheduled").json()["items"] == []  # чужие запланированные не видны

    assert boris.patch(f"/api/scheduled/{item['id']}", json={"content": "взлом"}).status_code == 404
    r = anna.patch(f"/api/scheduled/{item['id']}", json={"content": "вечером", "sendAt": later(120)})
    assert r.status_code == 200 and r.json()["item"]["content"] == "вечером"

    assert boris.delete(f"/api/scheduled/{item['id']}").status_code == 404
    assert anna.delete(f"/api/scheduled/{item['id']}").status_code == 200
    assert anna.get(f"/api/chats/{chat}/scheduled").json()["items"] == []


def test_due_message_is_sent_once_as_author(users, anna, boris, chat):
    from app.modules.chats.scheduled import deliver_due

    item = anna.post(f"/api/chats/{chat}/scheduled", json={"sendAt": later(), "message": {"content": "по таймеру"}}).json()["item"]
    deliver_due()
    assert not any(m["content"] == "по таймеру" for m in boris.get(f"/api/chats/{chat}/messages").json()["messages"])

    due_now(item["id"])
    assert deliver_due() == 1
    assert deliver_due() == 0
    sent = [m for m in boris.get(f"/api/chats/{chat}/messages").json()["messages"] if m["content"] == "по таймеру"]
    assert len(sent) == 1
    assert sent[0]["id"] == item["id"] and sent[0]["authorId"] == users.ids["anna"]
    assert anna.get(f"/api/chats/{chat}/scheduled").json()["items"] == []


def test_send_now(users, anna, boris, chat):
    item = anna.post(f"/api/chats/{chat}/scheduled", json={"sendAt": later(), "message": {"content": "сразу"}}).json()["item"]
    r = anna.post(f"/api/scheduled/{item['id']}/send")
    assert r.status_code == 200, r.text
    assert r.json()["message"]["content"] == "сразу"
    assert anna.post(f"/api/scheduled/{item['id']}/send").status_code == 404


def test_dropped_when_author_left_chat(users, anna, boris, clara):
    from app.core.db import db
    from app.modules.chats.scheduled import deliver_due

    group = anna.post("/api/chats", json={"participantIds": [users.ids["boris"], users.ids["clara"]], "isGroup": True, "title": "Г"}).json()["id"]
    item = clara.post(f"/api/chats/{group}/scheduled", json={"sendAt": later(), "message": {"content": "не дойдёт"}}).json()["item"]
    assert anna.delete(f"/api/chats/{group}/participants/{users.ids['clara']}").status_code == 200
    due_now(item["id"])
    assert deliver_due() == 1
    assert not any(m["content"] == "не дойдёт" for m in anna.get(f"/api/chats/{group}/messages").json()["messages"])
    assert db.conn.fetch_one("SELECT 1 AS x FROM scheduled_messages WHERE id = %s", (item["id"],)) is None
