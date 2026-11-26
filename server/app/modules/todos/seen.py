"""«Новое» у задач — как у материалов «Офиса» (workspace/store.is_new_sql): задачу поручил другой человек, а этот
её ещё не открывал. Открыл — метка снимается (POST /api/todos/{id}/seen).

Таблица task_seen на проде появляется отдельным шагом схемы: без неё метки просто нет (table_ready).
Считаем «новое» только для задач, созданных после первого обращения после выкатки, — иначе все старые
непрочитанные задачи разом стали бы «новыми».
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

from app.core import schema
from app.core.db import db

log = logging.getLogger(__name__)

NEW_SINCE_KEY = "tasks:new_since"

schema.register("task_seen", """
CREATE TABLE IF NOT EXISTS task_seen (
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, user_id)
)
""")


def ready() -> bool:
    try:
        from app.modules.workspace.store import table_ready

        return table_ready("task_seen")
    except Exception:
        return False


def new_since() -> str:
    from app.core import kv

    value = kv.get(NEW_SINCE_KEY) or {}
    if not value.get("at"):
        now = db.conn.fetch_one("SELECT now()::text AS t")["t"]
        value = kv.update(NEW_SINCE_KEY, {}, lambda cur: cur if (cur or {}).get("at") else {"at": now})
    return str(value["at"])


def _assignees(t: dict) -> set[str]:
    ids = {str(i) for i in (t.get("assignedToIds") or t.get("assigned_to_ids") or []) if i}
    one = t.get("assignedToId") or t.get("assigned_to_id")
    if one:
        ids.add(str(one))
    return ids


def flag_new(tasks: Iterable[dict], user_id: str) -> None:
    """Пометить isNew у задач (camelCase, как отдаёт /api/todos): мне поручил кто-то другой, создана после выкатки,
    я её не открывал."""
    if not ready():
        return
    items = list(tasks)
    try:
        since = new_since()
        rows = db.conn.fetch_all("SELECT task_id FROM task_seen WHERE user_id = %s", (user_id,)) or []
        seen = {str(r["task_id"]) for r in rows}
        fresh = db.conn.fetch_all("SELECT id FROM tasks WHERE created_at > %s::timestamptz", (since,)) or []
        recent = {str(r["id"]) for r in fresh}
    except Exception as exc:
        log.debug("task seen flags failed: %s", exc)
        return
    for t in items:
        tid = str(t.get("id") or "")
        by = str(t.get("assignedById") or t.get("authorId") or "")
        t["isNew"] = bool(tid in recent and tid not in seen and user_id in _assignees(t) and by and by != user_id)


def mark(task_id: str, user_id: str) -> None:
    if not ready():
        return
    db.conn.execute_query(
        "INSERT INTO task_seen (task_id, user_id, seen_at) VALUES (%s, %s, now()) "
        "ON CONFLICT (task_id, user_id) DO UPDATE SET seen_at = now()",
        (str(task_id), user_id),
    )
