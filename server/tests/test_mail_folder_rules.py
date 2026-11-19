"""Свои папки почты с правилами: письма раскладываются по папкам и уходят из «Входящих»."""

from __future__ import annotations

import uuid


def _account(user_id: str) -> str:
    from app.core.db import db

    acc = db.add_email_account({"user_id": user_id, "name": "Тест", "email": f"t{uuid.uuid4().hex[:6]}@x.ru", "imap_host": "imap.x.ru",
                                "smtp_host": "smtp.x.ru", "username": "u", "password_enc": ""})
    return str(acc["id"])


def _msg(acc: str, uid: str, subject: str, from_addr: str, to: str = "me@x.ru", read: bool = False, folder: str = "INBOX") -> None:
    from app.core.db import db

    db.conn.execute_query(
        "INSERT INTO email_messages (account_id, uid, folder, subject, from_addr, from_name, to_addrs, is_read, date) "
        "VALUES (%s, %s, %s, %s, %s, '', %s::jsonb, %s, now())",
        (acc, uid, folder, subject, from_addr, f'["{to}"]', read))


def _subjects(client, acc: str, folder: str) -> set[str]:
    r = client.get("/api/mail/messages", params={"accountId": acc, "folder": folder, "light": "true"})
    assert r.status_code == 200, r.text
    return {m["subject"] for m in r.json()}


def test_rules_route_mail_out_of_inbox(users, anna, boris):
    from app.modules.mail import folder_rules

    acc = _account(users.ids["anna"])
    _msg(acc, "1", "Счёт №5", "buh@romashka.ru")
    _msg(acc, "2", "Привет", "friend@mail.ru")
    _msg(acc, "3", "Заявка на тур", "site@vs-travel.ru", to="sales@x.ru")
    _msg(acc, "4", "Рассылка", "news@shop.ru", read=True)

    folder = anna.post("/api/mail/folders", json={"name": "Бухгалтерия"}).json()["id"]
    r = anna.put(f"/api/mail/smart-folders/{folder}", json={"name": "Бухгалтерия", "rules": [
        {"field": "from", "text": "romashka.ru"}, {"field": "subject", "text": "заявка"}, {"field": "to", "text": "SALES@"}, {"field": "from", "text": "  "}]})
    assert r.status_code == 200, r.text

    assert _subjects(anna, acc, f"custom:{folder}") == {"Счёт №5", "Заявка на тур"}
    assert _subjects(anna, acc, "INBOX") == {"Привет", "Рассылка"}  # разложенное ушло из «Входящих»

    folders = anna.get("/api/mail/smart-folders", params={"accountId": acc}).json()
    mine = next(f for f in folders if f["id"] == folder)
    assert mine["unread"] == 2 and len(mine["rules"]) == 3  # пустое правило отброшено
    assert {(r["field"], r["text"]) for r in mine["rules"]} >= {("from", "romashka.ru"), ("subject", "заявка")}
    assert folder_rules.routed_unread_in_inbox(acc, users.ids["anna"]) == 2

    # чужую папку не правят и чужой ящик не читают
    assert boris.put(f"/api/mail/smart-folders/{folder}", json={"name": "Взлом"}).status_code == 404
    assert boris.get("/api/mail/smart-folders", params={"accountId": acc}).status_code in (403, 404)

    # правила убрали — всё снова во «Входящих»
    anna.put(f"/api/mail/smart-folders/{folder}", json={"rules": []})
    assert len(_subjects(anna, acc, "INBOX")) == 4


def test_old_patterns_without_prefix_mean_sender():
    from app.modules.mail.folder_rules import compose, parse

    assert parse("boss@corp.ru") == ("from", "boss@corp.ru")
    assert parse("subject:Счёт") == ("subject", "Счёт")
    assert parse(compose("to", " a@b ")) == ("to", "a@b")
    assert parse("http://x") == ("from", "http://x")
