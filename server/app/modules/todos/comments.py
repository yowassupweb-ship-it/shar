"""Комментарии к задачам — как у документов «Офиса» (workspace/comments.py): ветка к выделенному тексту задачи
(anchor {"kind": "text", "quote": …}) и ответы на неё, «Решено» убирает ветку в архив.

Видят и пишут все, кому видна задача (участники, папка открыта, админ). Править текст — автор, удалять — автор,
автор задачи или админ. Таблицы на проде может ещё не быть (схема — отдельным шагом): тогда список пуст, а запись
отвечает понятной ошибкой 503.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity
from app.modules.todos import folders
from app.modules.workspace import store

router = APIRouter()

MAX_BODY = 4000
MAX_PER_TASK = 2000
MAX_QUOTE = 500

schema.register("task_comments", """
CREATE TABLE IF NOT EXISTS task_comments (
    id BIGSERIAL PRIMARY KEY,
    task_id TEXT NOT NULL,
    parent_id BIGINT REFERENCES task_comments(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL,
    body TEXT NOT NULL,
    anchor JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolved BOOLEAN NOT NULL DEFAULT false,
    resolved_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, id);
""")

_COLUMNS = ("id::text AS id, parent_id::text AS parent_id, author_id, body, anchor, resolved, resolved_by, "
            "created_at::text AS created_at, updated_at::text AS updated_at")


def ready() -> bool:
    return store.table_ready("task_comments")


def _task_or_404(task_id: str, me: Identity) -> dict:
    # Доступ — тем же правилом, что у самой задачи (todos/router.py). Импорт здесь: router импортирует этот модуль.
    from app.modules.todos.router import _can_access_task
    task = db.get_task(task_id)
    if not task or not _can_access_task(task, me):
        raise HTTPException(status_code=404, detail="Задача не найдена")
    return task


def _users(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    ids = sorted({str(r["author_id"]) for r in rows} | {str(r["resolved_by"]) for r in rows if r.get("resolved_by")})
    if not ids:
        return {}
    return {str(u["id"]): u for u in (db.conn.fetch_all("SELECT id, name, username, avatar FROM users WHERE id = ANY(%s)", (ids,)) or [])}


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


def _clean_anchor(anchor: Any) -> dict[str, Any]:
    if isinstance(anchor, dict) and anchor.get("kind") == "text" and str(anchor.get("quote") or "").strip():
        return {"kind": "text", "quote": str(anchor["quote"])[:MAX_QUOTE]}
    return {}


def _get(task_id: str, comment_id: str) -> dict[str, Any]:
    row = db.conn.fetch_one(f"SELECT {_COLUMNS} FROM task_comments WHERE id = %s AND task_id = %s",
                            (int(comment_id), str(task_id))) if str(comment_id).isdigit() else None
    if not row:
        raise HTTPException(status_code=404, detail="Комментарий не найден")
    return row


def _need_table() -> None:
    if not ready():
        raise HTTPException(status_code=503, detail="Комментарии к задачам появятся после обновления сервера")


def _announce(task: dict, by_id: str, action: str, comment_id: Any) -> None:
    """Участникам задачи и тем, кому открыта папка, — перечитать комментарии (себе не шлём)."""
    recipients: set[str] = set()
    for key in ("author_id", "assigned_to_id", "assigned_by_id"):
        if task.get(key):
            recipients.add(str(task[key]))
    recipients |= {str(x) for x in (task.get("assigned_to_ids") or []) if x}
    recipients |= folders.members(task.get("list_id"))
    recipients.discard(str(by_id))
    payload = {"type": "task_comments", "taskId": str(task.get("id")), "action": action, "commentId": comment_id}
    for uid in recipients:
        try:
            sse_manager.push(uid, payload)
        except Exception:  # noqa: BLE001 - событие — подсказка обновиться, не критично
            pass


class CommentBody(BaseModel):
    body: str = Field(max_length=MAX_BODY * 2)
    anchor: Optional[dict[str, Any]] = None
    parentId: Optional[str] = None


class CommentPatch(BaseModel):
    body: Optional[str] = Field(default=None, max_length=MAX_BODY * 2)
    resolved: Optional[bool] = None


@router.get("/api/todos/{task_id}/comments")
def list_task_comments(task_id: str, me: Identity = Depends(current_identity)):
    _task_or_404(task_id, me)
    if not ready():
        return {"comments": [], "ready": False}
    rows = db.conn.fetch_all(f"SELECT {_COLUMNS} FROM task_comments WHERE task_id = %s ORDER BY id", (str(task_id),)) or []
    users = _users(rows)
    return {"comments": [_present(r, users) for r in rows], "ready": True}


@router.post("/api/todos/{task_id}/comments", status_code=201)
def add_task_comment(task_id: str, body: CommentBody, me: Identity = Depends(current_identity)):
    task = _task_or_404(task_id, me)
    _need_table()
    text = (body.body or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Пустой комментарий")
    if len(text) > MAX_BODY:
        raise HTTPException(status_code=413, detail="Комментарий слишком длинный")
    count = db.conn.fetch_one("SELECT count(*) AS n FROM task_comments WHERE task_id = %s", (str(task_id),))["n"]
    if count >= MAX_PER_TASK:
        raise HTTPException(status_code=400, detail="Слишком много комментариев")
    parent = None
    if body.parentId:
        root = _get(task_id, body.parentId)
        if root["parent_id"]:
            raise HTTPException(status_code=400, detail="Отвечать можно только на ветку")
        parent = int(body.parentId)
    row = db.conn.fetch_one(
        f"INSERT INTO task_comments (task_id, parent_id, author_id, body, anchor) VALUES (%s, %s, %s, %s, %s) RETURNING {_COLUMNS}",
        (str(task_id), parent, me.user_id, text, store.as_json({} if parent else _clean_anchor(body.anchor))),
    )
    comment = _present(row, _users([row]))
    _announce(task, me.user_id, "added", comment["id"])
    return {"comment": comment}


@router.patch("/api/todos/{task_id}/comments/{comment_id}")
def change_task_comment(task_id: str, comment_id: str, body: CommentPatch, me: Identity = Depends(current_identity)):
    task = _task_or_404(task_id, me)
    _need_table()
    row = _get(task_id, comment_id)
    sets: list[str] = []
    params: list[Any] = []
    if body.body is not None:
        if str(row["author_id"]) != me.user_id:
            raise HTTPException(status_code=403, detail="Править можно только свой комментарий")
        text = body.body.strip()
        if not text or len(text) > MAX_BODY:
            raise HTTPException(status_code=400, detail="Комментарий пустой или слишком длинный")
        sets += ["body = %s", "updated_at = now()"]
        params.append(text)
    if body.resolved is not None:
        if row["parent_id"]:
            raise HTTPException(status_code=400, detail="Закрывается вся ветка")
        sets += ["resolved = %s", "resolved_by = %s"]
        params += [body.resolved, me.user_id if body.resolved else ""]
    if not sets:
        return {"comment": _present(row, _users([row]))}
    params.append(int(comment_id))
    fresh = db.conn.fetch_one(f"UPDATE task_comments SET {', '.join(sets)} WHERE id = %s RETURNING {_COLUMNS}", tuple(params))
    comment = _present(fresh, _users([fresh]))
    _announce(task, me.user_id, "changed", comment["id"])
    return {"comment": comment}


@router.delete("/api/todos/{task_id}/comments/{comment_id}")
def delete_task_comment(task_id: str, comment_id: str, me: Identity = Depends(current_identity)):
    task = _task_or_404(task_id, me)
    _need_table()
    row = _get(task_id, comment_id)
    if str(row["author_id"]) != me.user_id and str(task.get("author_id") or "") != me.user_id and not me.is_admin:
        raise HTTPException(status_code=403, detail="Удалить может автор комментария, автор задачи или админ")
    db.conn.execute_query("DELETE FROM task_comments WHERE id = %s", (int(comment_id),))
    _announce(task, me.user_id, "deleted", comment_id)
    return {"ok": True}
