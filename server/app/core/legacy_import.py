"""Разовый перенос данных из JSON-файлов старого Next (frontend/data/*.json) в Postgres.

Включается переменной SHAR_LEGACY_DATA_DIR (каталог с файлами). Каждый вид данных
переносится только в пустое назначение — повторный запуск ничего не дублирует.
  web_push_subscriptions.json → push_subscriptions
  notification_prefs.json     → push_prefs
  notifications.json          → user_notifications
  requests.json               → app_kv['requests']
В данных, которых нет в этом списке, v2 не нуждается."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from app.config import settings
from app.core import kv
from app.core.db import db
from app.core.db.connection import Json

log = logging.getLogger("shar.legacy_import")


def _read(name: str) -> Any:
    path = Path(settings.legacy_data_dir or ".") / name
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        log.warning("cannot read %s: %s", path, exc)
        return None


def _empty(table: str) -> bool:
    return (db.conn.fetch_one(f"SELECT COUNT(*) AS n FROM {table}") or {}).get("n", 0) == 0  # имя таблицы — константа ниже


def import_legacy_data() -> dict[str, int]:
    if not settings.legacy_data_dir:
        return {}
    result: dict[str, int] = {}

    subs = (_read("web_push_subscriptions.json") or {}).get("subscriptions") or []
    if subs and _empty("push_subscriptions"):
        n = 0
        for item in subs:
            endpoint = str(item.get("endpoint") or "")
            if endpoint.startswith("https://") and item.get("userId"):
                db.conn.execute_query(
                    "INSERT INTO push_subscriptions (endpoint, user_id, subscription, user_agent, platform) VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                    (endpoint, str(item["userId"]), Json(item.get("subscription") or {}), str(item.get("userAgent") or "")[:400], str(item.get("platform") or "")[:80]),
                )
                n += 1
        result["push_subscriptions"] = n

    prefs = (_read("notification_prefs.json") or {}).get("prefs") or {}
    if prefs and _empty("push_prefs"):
        for uid, value in prefs.items():
            db.conn.execute_query("INSERT INTO push_prefs (user_id, prefs) VALUES (%s,%s) ON CONFLICT DO NOTHING", (str(uid), Json(value or {})))
        result["push_prefs"] = len(prefs)

    notes = (_read("notifications.json") or {}).get("notifications") or []
    if notes and _empty("user_notifications"):
        n = 0
        for x in notes:
            if x.get("id") and x.get("toUserId"):
                db.conn.execute_query(
                    "INSERT INTO user_notifications (id, to_user_id, type, todo_id, todo_title, event_id, event_title, from_user_id, from_user_name, message, read, created_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,COALESCE(%s::timestamptz, NOW())) ON CONFLICT DO NOTHING",
                    (str(x["id"]), str(x["toUserId"]), str(x.get("type") or "info"), x.get("todoId"), x.get("todoTitle"), x.get("eventId"),
                     x.get("eventTitle"), x.get("fromUserId"), x.get("fromUserName"), str(x.get("message") or ""), bool(x.get("read")), x.get("createdAt")),
                )
                n += 1
        result["user_notifications"] = n

    requests = _read("requests.json")
    if isinstance(requests, dict) and kv.get("requests") is None:
        kv.set("requests", {"counter": int(requests.get("counter") or 0), "requests": requests.get("requests") or [],
                            "requestDepartmentIds": requests.get("requestDepartmentIds") or []})
        result["requests"] = len(requests.get("requests") or [])

    if result:
        log.info("legacy data imported: %s", result)
    return result
