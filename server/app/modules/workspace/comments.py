"""Комментарии к документам и таблицам «Офиса», как в Google Docs.

Ветка — комментарий верхнего уровня (anchor: к чему он привязан) и ответы на него (parent_id). Привязка:
  документ — {"kind": "text", "quote": "выделенный текст"}
  таблица  — {"kind": "cell", "sheet": "Лист1", "cell": "B3"}
Видеть и писать комментарии может каждый, кому виден материал (как «комментатор» в Google Docs); править текст —
автор, закрывать («решено») — любой из них, удалять — автор и владелец материала. Таблицы в базе может ещё не быть
(схему на проде применяют вручную): тогда комментариев нет, а запись отвечает понятной ошибкой.
"""
from __future__ import annotations

from typing import Any, Optional

from app.core import schema
from app.core.db import db
from app.modules.workspace import store
from app.modules.workspace.store import WorkspaceError

MAX_BODY = 4000
MAX_PER_ITEM = 2000
MAX_QUOTE = 500

schema.register("workspace_comments", """
CREATE TABLE IF NOT EXISTS workspace_item_comments (
    id BIGSERIAL PRIMARY KEY,
    item_id BIGINT NOT NULL REFERENCES workspace_items(id) ON DELETE CASCADE,
    parent_id BIGINT REFERENCES workspace_item_comments(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL,
    body TEXT NOT NULL,
    anchor JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolved BOOLEAN NOT NULL DEFAULT false,
    resolved_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspace_item_comments_item ON workspace_item_comments(item_id, id);
""")


def ready() -> bool:
    return store.table_ready("workspace_item_comments")


def _clean_anchor(anchor: Any) -> dict[str, Any]:
    if not isinstance(anchor, dict):
        return {}
    kind = anchor.get("kind")
    if kind == "text":
        return {"kind": "text", "quote": str(anchor.get("quote") or "")[:MAX_QUOTE]}
    if kind == "cell":
        cell = str(anchor.get("cell") or "").upper()[:12]
        if not cell:
            return {}
        return {"kind": "cell", "sheet": str(anchor.get("sheet") or "")[:60], "cell": cell}
    return {}


def _present(row: dict[str, Any], users: dict[str, dict[str, Any]]) -> dict[str, Any]:
    author = users.get(str(row["author_id"])) or {}
    resolver = users.get(str(row.get("resolved_by") or "")) or {}
    return {
        "id": row["id"], "parentId": row["parent_id"], "body": row["body"], "anchor": row["anchor"] or {},
        "authorId": str(row["author_id"]), "authorName": author.get("name") or author.get("username") or "",
        "authorAvatar": author.get("avatar") or "",
        "resolved": bool(row["resolved"]), "resolvedByName": (resolver.get("name") or resolver.get("username") or "") if row["resolved"] else "",
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


_COLUMNS = ("id::text AS id, parent_id::text AS parent_id, author_id, body, anchor, resolved, resolved_by, "
            "created_at::text AS created_at, updated_at::text AS updated_at")


def _users(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    ids = sorted({str(r["author_id"]) for r in rows} | {str(r["resolved_by"]) for r in rows if r.get("resolved_by")})
    if not ids:
        return {}
    return {str(u["id"]): u for u in (db.conn.fetch_all("SELECT id, name, username, avatar FROM users WHERE id = ANY(%s)", (ids,)) or [])}


def list_comments(item_id: str) -> list[dict[str, Any]]:
    """Все комментарии материала плоским списком по порядку создания (ответы ссылаются на ветку через parentId)."""
    if not ready() or not str(item_id).isdigit():
        return []
    rows = db.conn.fetch_all(f"SELECT {_COLUMNS} FROM workspace_item_comments WHERE item_id = %s ORDER BY id", (int(item_id),)) or []
    users = _users(rows)
    return [_present(r, users) for r in rows]


def _get(item_id: str, comment_id: str) -> dict[str, Any]:
    row = db.conn.fetch_one(f"SELECT {_COLUMNS} FROM workspace_item_comments WHERE id = %s AND item_id = %s",
                            (int(comment_id), int(item_id))) if str(comment_id).isdigit() else None
    if not row:
        raise WorkspaceError(404, "Комментарий не найден")
    return row


def add_comment(item_id: str, user_id: str, body: str, anchor: Any = None, parent_id: Optional[str] = None) -> dict[str, Any]:
    if not ready():
        raise WorkspaceError(503, "Комментарии появятся после обновления сервера")
    text = (body or "").strip()
    if not text:
        raise WorkspaceError(400, "Пустой комментарий")
    if len(text) > MAX_BODY:
        raise WorkspaceError(413, "Комментарий слишком длинный")
    count = db.conn.fetch_one("SELECT count(*) AS n FROM workspace_item_comments WHERE item_id = %s", (int(item_id),))["n"]
    if count >= MAX_PER_ITEM:
        raise WorkspaceError(400, "Слишком много комментариев")
    parent = None
    if parent_id:
        root = _get(item_id, parent_id)
        if root["parent_id"]:
            raise WorkspaceError(400, "Отвечать можно только на ветку")
        parent = int(parent_id)
    row = db.conn.fetch_one(
        f"INSERT INTO workspace_item_comments (item_id, parent_id, author_id, body, anchor) VALUES (%s, %s, %s, %s, %s) RETURNING {_COLUMNS}",
        (int(item_id), parent, user_id, text, store.as_json({} if parent else _clean_anchor(anchor))),
    )
    return _present(row, _users([row]))


def change_comment(item_id: str, comment_id: str, user_id: str, *, body: Optional[str] = None, resolved: Optional[bool] = None) -> dict[str, Any]:
    if not ready():
        raise WorkspaceError(503, "Комментарии появятся после обновления сервера")
    row = _get(item_id, comment_id)
    sets: list[str] = []
    params: list[Any] = []
    if body is not None:
        if str(row["author_id"]) != user_id:
            raise WorkspaceError(403, "Править можно только свой комментарий")
        text = body.strip()
        if not text or len(text) > MAX_BODY:
            raise WorkspaceError(400, "Комментарий пустой или слишком длинный")
        sets += ["body = %s", "updated_at = now()"]
        params.append(text)
    if resolved is not None:
        if row["parent_id"]:
            raise WorkspaceError(400, "Закрывается вся ветка")
        sets += ["resolved = %s", "resolved_by = %s"]
        params += [resolved, user_id if resolved else ""]
    if not sets:
        return _present(row, _users([row]))
    params.append(int(comment_id))
    fresh = db.conn.fetch_one(f"UPDATE workspace_item_comments SET {', '.join(sets)} WHERE id = %s RETURNING {_COLUMNS}", tuple(params))
    return _present(fresh, _users([fresh]))


def delete_comment(item_id: str, comment_id: str, user_id: str, *, is_owner: bool) -> None:
    if not ready():
        raise WorkspaceError(503, "Комментарии появятся после обновления сервера")
    row = _get(item_id, comment_id)
    if str(row["author_id"]) != user_id and not is_owner:
        raise WorkspaceError(403, "Удалить может автор или владелец материала")
    db.conn.execute_query("DELETE FROM workspace_item_comments WHERE id = %s", (int(comment_id),))


def announce(item_id: str, kind: str, comment: Optional[dict[str, Any]], *, by: str, by_id: str) -> None:
    """Открывшим материал — обновить панель комментариев (себе не шлём)."""
    store.push_to_viewers(item_id, {"type": "workspace_comments", "itemId": str(item_id), "action": kind, "commentId": (comment or {}).get("id"),
                                    "by": by, "byId": by_id}, exclude=by_id)
