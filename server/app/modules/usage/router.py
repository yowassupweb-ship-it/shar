"""Статистика посещения разделов: кто, чем и сколько пользуется. Для админки.

Клиент (shared/usage/tracker.ts) считает заходы в раздел и время, пока вкладка видна, окно в фокусе и человек
не простаивает дольше 5 минут, и раз в ~30 секунд присылает накопленное. Храним сводку по дням — человек, день
(по Москве), раздел, заходы, секунды — без истории отдельных кликов.

  POST /api/usage/beat     {items: [{section, visits, seconds}]}  — тело может прийти как text/plain (sendBeacon)
  GET  /api/admin/usage?days=30                                     — только админу
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core import schema
from app.core.db import db
from app.core.security import Identity, current_identity, require_admin

router = APIRouter()
log = logging.getLogger("shar.usage")

SECTION = re.compile(r"^[a-z0-9-]{1,32}$")
MAX_ITEMS = 20
MAX_SECONDS = 900  # за одну посылку (~30 с) больше не набежит; лишнее — ошибка часов клиента
MAX_VISITS = 100

schema.register("usage", """
CREATE TABLE IF NOT EXISTS usage_daily (
    user_id TEXT NOT NULL,
    day DATE NOT NULL,
    section TEXT NOT NULL,
    visits INT NOT NULL DEFAULT 0,
    seconds INT NOT NULL DEFAULT 0,
    last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, day, section)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day);
""")


def _ready() -> bool:
    from app.modules.workspace.store import table_ready

    return table_ready("usage_daily")


@router.post("/api/usage/beat")
async def beat(request: Request, me: Identity = Depends(current_identity)):
    try:
        data = json.loads((await request.body()) or b"{}")
    except ValueError:
        raise HTTPException(status_code=400, detail="Ожидается JSON") from None
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or not _ready():
        return {"ok": True}
    for item in items[:MAX_ITEMS]:
        if not isinstance(item, dict):
            continue
        section = str(item.get("section") or "")
        if not SECTION.match(section):
            continue
        visits = max(0, min(MAX_VISITS, int(item.get("visits") or 0)))
        seconds = max(0, min(MAX_SECONDS, int(item.get("seconds") or 0)))
        if not visits and not seconds:
            continue
        db.conn.execute_query(
            """INSERT INTO usage_daily (user_id, day, section, visits, seconds) VALUES (%s, (now() AT TIME ZONE 'Europe/Moscow')::date, %s, %s, %s)
               ON CONFLICT (user_id, day, section) DO UPDATE SET visits = usage_daily.visits + EXCLUDED.visits,
                   seconds = usage_daily.seconds + EXCLUDED.seconds, last_at = now()""",
            (me.user_id, section, visits, seconds))
    return {"ok": True}


@router.get("/api/admin/usage")
def usage_report(days: int = 30, me: Identity = Depends(require_admin)):
    """Разделы (люди, заходы, время), люди (время всего и по разделам, последняя активность) и по дням — за период."""
    days = max(1, min(365, days))
    if not _ready():
        return {"days": days, "ready": False, "sections": [], "users": [], "daily": []}
    since = "(now() AT TIME ZONE 'Europe/Moscow')::date - %s::int + 1"
    rows = db.conn.fetch_all(
        f"""SELECT user_id, section, sum(visits)::int AS visits, sum(seconds)::int AS seconds, max(last_at)::text AS last_at,
                   count(DISTINCT day)::int AS active_days
            FROM usage_daily WHERE day >= {since} GROUP BY user_id, section""", (days,)) or []
    daily = db.conn.fetch_all(
        f"""SELECT day::text AS day, count(DISTINCT user_id)::int AS users, sum(seconds)::int AS seconds
            FROM usage_daily WHERE day >= {since} GROUP BY day ORDER BY day""", (days,)) or []
    sections: dict[str, dict[str, Any]] = {}
    people: dict[str, dict[str, Any]] = {}
    for r in rows:
        s = sections.setdefault(r["section"], {"section": r["section"], "users": 0, "visits": 0, "seconds": 0})
        s["users"] += 1
        s["visits"] += r["visits"]
        s["seconds"] += r["seconds"]
        p = people.setdefault(r["user_id"], {"userId": r["user_id"], "visits": 0, "seconds": 0, "lastAt": "", "activeDays": 0, "sections": {}})
        p["visits"] += r["visits"]
        p["seconds"] += r["seconds"]
        p["lastAt"] = max(p["lastAt"], r["last_at"] or "")
        p["activeDays"] = max(p["activeDays"], r["active_days"])
        p["sections"][r["section"]] = {"visits": r["visits"], "seconds": r["seconds"]}
    if people:
        names = {str(u["id"]): u for u in (db.conn.fetch_all(
            "SELECT id, name, username, department, avatar FROM users WHERE id = ANY(%s)", (list(people),)) or [])}
        for uid, p in people.items():
            u = names.get(uid) or {}
            p.update({"name": u.get("name") or u.get("username") or uid, "department": u.get("department") or "", "avatar": u.get("avatar") or ""})
    return {
        "days": days, "ready": True,
        "sections": sorted(sections.values(), key=lambda s: -s["seconds"]),
        "users": sorted(people.values(), key=lambda p: -p["seconds"]),
        "daily": daily,
    }
