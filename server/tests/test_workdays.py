"""Производственный календарь: разбор xmlcalendar.ru, запасной isdayoff.ru, кэш, «предварительно»."""

from __future__ import annotations

import random

import pytest

from app.modules.calendar import workdays as W

# Фрагмент настоящего 2026 года с xmlcalendar.ru: 9 января и 31 декабря — перенесённые выходные,
# 8 мая и 3 ноября — сокращённые.
XML_2026 = {"year": 2026, "months": [
    {"month": 1, "days": "1,2,3,4,5,6,7,8,9+,10,11,17,18,24,25,31"}, {"month": 2, "days": "1,7,8,14,15,21,22,23,28"},
    {"month": 3, "days": "1,7,8,9+,14,15,21,22,28,29"}, {"month": 4, "days": "4,5,11,12,18,19,25,26,30*"},
    {"month": 5, "days": "1,2,3,8*,9,10,11+,16,17,23,24,30,31"}, {"month": 6, "days": "6,7,11*,12,13,14,20,21,27,28"},
    {"month": 7, "days": "4,5,11,12,18,19,25,26"}, {"month": 8, "days": "1,2,8,9,15,16,22,23,29,30"},
    {"month": 9, "days": "5,6,12,13,19,20,26,27"}, {"month": 10, "days": "3,4,10,11,17,18,24,25,31"},
    {"month": 11, "days": "1,3*,4,7,8,14,15,21,22,28,29"}, {"month": 12, "days": "5,6,12,13,19,20,26,27,31+"},
]}


class Resp:
    def __init__(self, status, payload=None, text=""):
        self.status_code, self._payload, self.text = status, payload, text

    def json(self):
        return self._payload


@pytest.fixture()
def year():
    # Свой год на тест: кэш в app_kv живёт между прогонами.
    return random.randrange(2040, 2099)


def test_xmlcalendar_parsed(monkeypatch, admin):
    monkeypatch.setattr(W.requests, "get", lambda url, timeout: Resp(200, XML_2026) if "xmlcalendar" in url else Resp(500))
    from app.core import kv

    kv.update("workdays:2026", None, lambda _o: None)
    r = admin.get("/api/calendar/workdays?year=2026")
    assert r.status_code == 200
    cal = r.json()
    assert cal["source"] == "xmlcalendar.ru" and cal["provisional"] is False
    off, short = set(cal["off"]), set(cal["short"])
    assert {"2026-01-01", "2026-01-09", "2026-05-11", "2026-12-31"} <= off
    assert "2026-01-12" not in off and "2026-05-08" in short and "2026-05-08" not in off
    assert cal["names"]["2026-01-07"] == "Рождество Христово"
    assert cal["names"]["2026-12-31"] == "Перенесённый выходной"
    assert cal["names"]["2026-02-23"] == "День защитника Отечества"


def test_isdayoff_fallback_and_cache(monkeypatch, admin, year):
    from datetime import date

    days = W._days(year)
    codes = "".join("1" if d.weekday() >= 5 or (d.month, d.day) in W.HOLIDAYS else ("2" if (d.month, d.day) == (2, 22) else "0") for d in days)
    calls = []

    def fake(url, timeout):
        calls.append(url)
        return Resp(404) if "xmlcalendar" in url else Resp(200, text=codes)

    monkeypatch.setattr(W.requests, "get", fake)
    cal = admin.get(f"/api/calendar/workdays?year={year}").json()
    assert cal["source"] == "isdayoff.ru" and date(year, 1, 1).isoformat() in cal["off"]
    n = len(calls)
    assert admin.get(f"/api/calendar/workdays?year={year}").json()["source"] == "isdayoff.ru"
    assert len(calls) == n  # сутки — из кэша, без запросов


def test_sources_down_provisional(monkeypatch, admin, year):
    def down(url, timeout):
        raise W.requests.ConnectionError("down")

    monkeypatch.setattr(W.requests, "get", down)
    cal = admin.get(f"/api/calendar/workdays?year={year}").json()
    assert cal["provisional"] is True
    assert f"{year}-01-01" in cal["off"] and f"{year}-06-12" in cal["off"]
    assert admin.get("/api/calendar/workdays?year=1900").status_code == 400
