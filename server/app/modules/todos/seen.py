"""«Новое» у задач — как у материалов «Офиса» (workspace/store.is_new_sql): задачу поручил другой человек, а этот
её ещё не открывал. Открыл — метка снимается (POST /api/todos/{id}/seen).

Комментарии к задаче — как сообщения: у участника задачи комментарии других, оставленные после того, как он её
последний раз открывал, — непрочитанные (unread_comments). Новые задачи + непрочитанные комментарии — число на
кнопке «Задачи» (badge). Участник — заказчик, автор, исполнитель, ответственный за этап цепочки или тот, кто уже
писал в задаче комментарий.

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


# Участник задачи (для комментариев и счётчика): t — строка tasks, %(u)s — человек, %(uj)s — JSON-массив с ним.
PARTICIPANT_SQL = """(t.author_id = %(u)s OR t.assigned_by_id = %(u)s OR t.assigned_to_id = %(u)s
    OR COALESCE(t.assigned_to_ids::jsonb, '[]'::jsonb) @> %(uj)s::jsonb OR t.metadata->'chain'->>'owner' = %(u)s
    OR EXISTS (SELECT 1 FROM task_comments m WHERE m.task_id = t.id AND m.author_id = %(u)s))"""


def _comments_ready() -> bool:
    try:
        from app.modules.workspace.store import table_ready

        return table_ready("task_comments")
    except Exception:
        return False


def _params(user_id: str) -> dict:
    import json

    return {"u": user_id, "uj": json.dumps([user_id]), "since": new_since()}


def unread_comments(user_id: str) -> dict[str, int]:
    """{task_id: сколько непрочитанных комментариев} — только задачи, где человек участник."""
    if not (ready() and _comments_ready()):
        return {}
    try:
        rows = db.conn.fetch_all(f"""
            SELECT c.task_id, count(*)::int AS n FROM task_comments c
            JOIN tasks t ON t.id = c.task_id
            LEFT JOIN task_seen s ON s.task_id = c.task_id AND s.user_id = %(u)s
            WHERE c.author_id <> %(u)s AND c.created_at > COALESCE(s.seen_at, %(since)s::timestamptz) AND {PARTICIPANT_SQL}
            GROUP BY c.task_id""", _params(user_id)) or []
    except Exception as exc:
        log.debug("unread comments failed: %s", exc)
        return {}
    return {str(r["task_id"]): int(r["n"]) for r in rows}


def badge(user_id: str) -> dict[str, int]:
    """Число на кнопке «Задачи»: новые поручения + непрочитанные комментарии."""
    if not ready():
        return {"count": 0, "newTasks": 0, "comments": 0}
    try:
        row = db.conn.fetch_one("""
            SELECT count(*)::int AS n FROM tasks t
            WHERE t.created_at > %(since)s::timestamptz
              AND (t.assigned_to_id = %(u)s OR COALESCE(t.assigned_to_ids::jsonb, '[]'::jsonb) @> %(uj)s::jsonb)
              AND COALESCE(NULLIF(t.assigned_by_id, ''), t.author_id, '') NOT IN ('', %(u)s)
              AND NOT EXISTS (SELECT 1 FROM task_seen s WHERE s.task_id = t.id AND s.user_id = %(u)s)""", _params(user_id))
        fresh = int((row or {}).get("n") or 0)
    except Exception as exc:
        log.debug("tasks badge failed: %s", exc)
        fresh = 0
    comments = sum(unread_comments(user_id).values())
    return {"count": fresh + comments, "newTasks": fresh, "comments": comments}


def mark(task_id: str, user_id: str) -> None:
    if not ready():
        return
    db.conn.execute_query(
        "INSERT INTO task_seen (task_id, user_id, seen_at) VALUES (%s, %s, now()) "
        "ON CONFLICT (task_id, user_id) DO UPDATE SET seen_at = now()",
        (str(task_id), user_id),
    )
