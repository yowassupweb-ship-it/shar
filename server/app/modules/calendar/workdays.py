"""Производственный календарь России: нерабочие дни, переносы, сокращённые предпраздничные дни.

Источник — открытые данные xmlcalendar.ru (собираются по постановлениям Правительства о переносе
выходных; там же год вперёд, как только постановление вышло), запасной — isdayoff.ru. Год
кэшируется в app_kv и перечитывается раз в сутки: новое постановление (перенос, внеплановый
выходной) Шар подхватит сам. Источники недоступны — отдаём прошлый кэш, а если его нет —
обычные выходные и праздники по ст. 112 ТК РФ с пометкой «предварительно».

Ответ: off — нерабочие дни (выходные и праздники, с переносами), short — сокращённые рабочие,
workWeekend — рабочие субботы/воскресенья (перенос), names — названия праздничных дней."""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException

from app.core import kv
from app.core.security import Identity, current_identity

router = APIRouter()
log = logging.getLogger("shar.workdays")

TTL = timedelta(hours=24)
TIMEOUT = 8
XMLCAL = "https://xmlcalendar.ru/data/ru/{year}/calendar.json"
ISDAYOFF = "https://isdayoff.ru/api/getdata?year={year}&cc=ru&pre=1"

# Праздники по ст. 112 ТК РФ (месяц, день) → название.
HOLIDAYS = {
    (1, 1): "Новый год", (1, 2): "Новогодние каникулы", (1, 3): "Новогодние каникулы", (1, 4): "Новогодние каникулы",
    (1, 5): "Новогодние каникулы", (1, 6): "Новогодние каникулы", (1, 7): "Рождество Христово", (1, 8): "Новогодние каникулы",
    (2, 23): "День защитника Отечества", (3, 8): "Международный женский день", (5, 1): "Праздник Весны и Труда",
    (5, 9): "День Победы", (6, 12): "День России", (11, 4): "День народного единства",
}


def _days(year: int) -> List[date]:
    d, out = date(year, 1, 1), []
    while d.year == year:
        out.append(d)
        d += timedelta(days=1)
    return out


def _result(year: int, off: set, short: set, transferred: set, source: str, provisional: bool) -> Dict[str, Any]:
    names: Dict[str, str] = {}
    for d in sorted(off):
        name = HOLIDAYS.get((d.month, d.day))
        if name:
            names[d.isoformat()] = name
        elif d in transferred or d.weekday() < 5:
            names[d.isoformat()] = "Перенесённый выходной"
    work_weekend = [d.isoformat() for d in _days(year) if d.weekday() >= 5 and d not in off]
    return {
        "year": year, "source": source, "provisional": provisional,
        "off": sorted(d.isoformat() for d in off), "short": sorted(d.isoformat() for d in short),
        "workWeekend": work_weekend, "names": names,
    }


def _from_xmlcalendar(year: int) -> Optional[Dict[str, Any]]:
    res = requests.get(XMLCAL.format(year=year), timeout=TIMEOUT)
    if res.status_code != 200:
        return None
    data = res.json()
    off, short, transferred = set(), set(), set()
    for m in data.get("months") or []:
        month = int(m["month"])
        for token in str(m.get("days") or "").split(","):
            token = token.strip()
            match = re.fullmatch(r"(\d+)([*+]?)", token)
            if not match:
                continue
            d = date(year, month, int(match.group(1)))
            if match.group(2) == "*":
                short.add(d)  # сокращённый — рабочий
            else:
                off.add(d)
                if match.group(2) == "+":
                    transferred.add(d)
    if len(off) < 100:  # год без выходных — битые данные, не верим
        return None
    return _result(year, off, short, transferred, "xmlcalendar.ru", False)


def _from_isdayoff(year: int) -> Optional[Dict[str, Any]]:
    res = requests.get(ISDAYOFF.format(year=year), timeout=TIMEOUT)
    codes = res.text.strip()
    days = _days(year)
    if res.status_code != 200 or len(codes) != len(days) or not set(codes) <= set("01234"):
        return None
    off = {d for d, c in zip(days, codes) if c == "1"}
    short = {d for d, c in zip(days, codes) if c == "2"}
    return _result(year, off, short, set(), "isdayoff.ru", False)


def _fallback(year: int) -> Dict[str, Any]:
    off = {d for d in _days(year) if d.weekday() >= 5 or (d.month, d.day) in HOLIDAYS}
    return _result(year, off, set(), set(), "ТК РФ без переносов", True)


def _fetch(year: int) -> Optional[Dict[str, Any]]:
    for source in (_from_xmlcalendar, _from_isdayoff):
        try:
            got = source(year)
            if got:
                return got
        except Exception as e:  # noqa: BLE001 — сбой источника: пробуем следующий
            log.warning("workdays %s: %s failed: %s", year, source.__name__, e)
    return None


def year_calendar(year: int) -> Dict[str, Any]:
    key = f"workdays:{year}"
    cached = kv.get(key, None)
    now = datetime.now(timezone.utc)
    fresh = cached and not cached.get("provisional") and now - datetime.fromisoformat(cached["fetchedAt"]) < TTL
    if fresh:
        return cached
    got = _fetch(year)
    if got:
        got["fetchedAt"] = now.isoformat()
        kv.update(key, None, lambda _old: got)
        return got
    if cached:
        return cached  # источники молчат — прошлые данные лучше, чем ничего
    fb = _fallback(year)
    fb["fetchedAt"] = now.isoformat()
    return fb


@router.get("/api/calendar/workdays")
def get_workdays(year: int, me: Identity = Depends(current_identity)):
    if not 2000 <= year <= 2100:
        raise HTTPException(status_code=400, detail="year out of range")
    return year_calendar(year)
