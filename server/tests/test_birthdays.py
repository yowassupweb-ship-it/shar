"""Дни рождения: свой день рождения, список, поздравления — один раз в день."""

from __future__ import annotations

from datetime import datetime


def test_birthday_crud_and_validation(users, anna, boris):
    assert anna.put("/api/birthdays/me", json={"day": 31, "month": 2}).status_code == 400
    assert anna.put("/api/birthdays/me", json={"day": 1, "month": 1, "year": 2090}).status_code == 400
    r = anna.put("/api/birthdays/me", json={"day": 29, "month": 2})  # без года — допустимо
    assert r.status_code == 200, r.text
    assert r.json()["mine"]["day"] == 29
    seen = boris.get("/api/birthdays").json()
    assert any(b["userId"] == users.ids["anna"] for b in seen["items"])
    assert seen["mine"] is None
    assert anna.delete("/api/birthdays/me").json()["mine"] is None


def test_birthday_notice_once(users, anna, client):
    from app.core.db import db
    from app.modules.birthdays.router import TZ, notify_today

    anna.put("/api/birthdays/me", json={"day": 14, "month": 3, "year": 1990})
    day = datetime(2031, 3, 14, 10, 0, tzinfo=TZ)
    assert notify_today(datetime(2031, 3, 14, 8, 0, tzinfo=TZ)) == 0   # до 9 утра — рано
    first = notify_today(day)
    assert first >= 2  # все сотрудники, включая именинницу
    assert notify_today(day) == 0  # повторный проход ничего не шлёт
    rows = db.conn.fetch_all("SELECT content FROM messages WHERE content LIKE %s", ("%день рождения:%41%",)) or []
    assert rows
    # 29 февраля в невисокосный год — 28-го.
    anna.put("/api/birthdays/me", json={"day": 29, "month": 2})
    assert notify_today(datetime(2031, 2, 28, 12, 0, tzinfo=TZ)) >= 1
    anna.delete("/api/birthdays/me")
