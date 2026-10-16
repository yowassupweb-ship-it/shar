"""Сквозной поиск: сообщения только из своих чатов, материалы — по правилам «Офиса»."""

from __future__ import annotations

import uuid


def test_search_respects_access(users, anna, boris, clara):
    tag = "лимонад" + uuid.uuid4().hex[:6]
    chat = anna.post("/api/chats", json={"participantIds": [users.ids["boris"]], "isGroup": False}).json()["id"]
    sent = anna.post(f"/api/chats/{chat}/messages", json={"authorId": "x", "content": f"Купить {tag} к пятнице"})
    assert sent.status_code == 200, sent.text

    found = boris.get("/api/search", params={"q": tag}).json()
    assert [m["chatId"] for m in found["messages"]] == [chat]
    assert tag in found["messages"][0]["snippet"]
    assert clara.get("/api/search", params={"q": tag}).json()["messages"] == []

    note = anna.post("/api/workspace/items", json={"kind": "note", "title": "План", "content": f"тут {tag} и ещё"}).json()["item"]
    assert [i["id"] for i in anna.get("/api/search", params={"q": tag}).json()["items"]] == [note["id"]]
    assert boris.get("/api/search", params={"q": tag}).json()["items"] == []  # заметка личная
    anna.put(f"/api/workspace/items/{note['id']}/shares", json={"userId": users.ids["boris"], "role": "view"})
    assert [i["id"] for i in boris.get("/api/search", params={"q": tag}).json()["items"]] == [note["id"]]


def test_search_short_and_special_queries(anna):
    assert all(v == [] for v in anna.get("/api/search", params={"q": "я"}).json().values())
    assert anna.get("/api/search", params={"q": "100%_\\"}).status_code == 200
    assert anna.get("/api/search").status_code == 200


def test_search_escapes_like_wildcards(anna):
    tag = uuid.uuid4().hex[:6]
    chat = anna.post("/api/chats", json={"participantIds": [], "isGroup": False}).json()["id"]
    anna.post(f"/api/chats/{chat}/messages", json={"authorId": "x", "content": f"скидка 50% {tag}"})
    anna.post(f"/api/chats/{chat}/messages", json={"authorId": "x", "content": f"скидка 500 {tag}"})
    found = anna.get("/api/search", params={"q": "50% " + tag}).json()["messages"]
    assert len(found) == 1 and "50%" in found[0]["snippet"]


def test_search_files_and_attachments(users, anna, boris, clara):
    tag = "накладная" + uuid.uuid4().hex[:6]
    made = anna.post("/api/cloud/files", json={"name": f"{tag}.pdf", "url": "/api/uploads/x.pdf"})
    assert made.status_code == 200, made.text
    file_id = made.json()["id"]
    assert [f["id"] for f in anna.get("/api/search", params={"q": tag}).json()["files"]] == [file_id]
    assert boris.get("/api/search", params={"q": tag}).json()["files"] == []
    shared = anna.put(f"/api/cloud/files/{file_id}/access", json={"sharedWith": [users.ids["boris"]]})
    assert shared.status_code == 200, shared.text
    assert [f["id"] for f in boris.get("/api/search", params={"q": tag}).json()["files"]] == [file_id]
    assert clara.get("/api/search", params={"q": tag}).json()["files"] == []

    chat = anna.post("/api/chats", json={"participantIds": [users.ids["boris"]], "isGroup": False}).json()["id"]
    sent = anna.post(f"/api/chats/{chat}/messages", json={
        "authorId": "x", "content": "вот", "attachments": [{"url": "/api/uploads/y.xlsx", "name": f"{tag}-отчёт.xlsx", "size": 10, "type": "file"}]})
    assert sent.status_code == 200, sent.text
    for who in (anna, boris):
        got = who.get("/api/search", params={"q": tag + "-отчёт"}).json()["attachments"]
        assert [a["chatId"] for a in got] == [chat] and got[0]["name"].endswith(".xlsx")
    assert clara.get("/api/search", params={"q": tag + "-отчёт"}).json()["attachments"] == []


def test_search_events_respect_visibility(users, anna, boris, clara):
    tag = "планёрка" + uuid.uuid4().hex[:6]
    made = anna.post("/api/events", json={"title": f"Большая {tag}", "startDate": "2026-11-02T10:00:00", "endDate": "2026-11-02T11:00:00",
                                          "participants": [users.ids["boris"]]})
    assert made.status_code == 200, made.text
    event_id = made.json()["id"]
    assert [e["id"] for e in anna.get("/api/search", params={"q": tag}).json()["events"]] == [event_id]
    assert [e["id"] for e in boris.get("/api/search", params={"q": tag}).json()["events"]] == [event_id]
    assert clara.get("/api/search", params={"q": tag}).json()["events"] == []


def test_search_mail_only_my_accounts(users, anna, boris):
    from app.core.db import db
    tag = "счёт" + uuid.uuid4().hex[:6]
    account = str(uuid.uuid4())
    db.conn.execute_query(
        """INSERT INTO email_accounts (id, user_id, name, email, imap_host, imap_port, smtp_host, smtp_port, username, password_enc)
           VALUES (%s, %s, 'test', 'a@example.org', 'imap.example.org', 993, 'smtp.example.org', 465, 'a', 'x')""",
        (account, users.ids["anna"]),
    )
    db.conn.execute_query(
        """INSERT INTO email_messages (id, account_id, uid, folder, subject, from_addr, from_name, body_text, date)
           VALUES (%s, %s, '1', 'INBOX', %s, 'b@example.org', 'Борис', 'оплатите до пятницы', now())""",
        (str(uuid.uuid4()), account, f"Нужен {tag}"),
    )
    got = anna.get("/api/search", params={"q": tag}).json()["mail"]
    assert len(got) == 1 and got[0]["accountId"] == account and got[0]["folder"] == "INBOX"
    assert boris.get("/api/search", params={"q": tag}).json()["mail"] == []
    assert len(anna.get("/api/search", params={"q": "оплатите до"}).json()["mail"]) >= 1
