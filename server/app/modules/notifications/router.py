"""Список уведомлений пользователя (раньше — data/notifications.json в старом Next).

Читает и помечает прочитанными только свои. Создаются уведомления кодом сервера
(задачи, календарь) в чате «Уведомления»; внешние системы шлют их через
/api/integrations/notifications."""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core import schema
from app.core.db import db
from app.core.security import Identity, current_identity

router = APIRouter()

schema.register("user_notifications", """
CREATE TABLE IF NOT EXISTS user_notifications (
    id             TEXT PRIMARY KEY,
    to_user_id     TEXT NOT NULL,
    type           TEXT NOT NULL DEFAULT 'info',
    todo_id        TEXT,
    todo_title     TEXT,
    event_id       TEXT,
    event_title    TEXT,
    from_user_id   TEXT,
    from_user_name TEXT,
    message        TEXT NOT NULL DEFAULT '',
    read           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications (to_user_id, created_at DESC)""")

MAX_PER_USER = 500


def _out(row: dict) -> dict:
    created = row.get("created_at")
    return {
        "id": row["id"], "type": row["type"],
        "todoId": row.get("todo_id"), "todoTitle": row.get("todo_title"),
        "eventId": row.get("event_id"), "eventTitle": row.get("event_title"),
        "fromUserId": row.get("from_user_id"), "fromUserName": row.get("from_user_name"),
        "toUserId": row["to_user_id"], "message": row.get("message") or "",
        "read": bool(row.get("read")),
        "createdAt": created.isoformat() if hasattr(created, "isoformat") else created,
    }


@router.get("/api/notifications")
def list_notifications(me: Identity = Depends(current_identity)):
    rows = db.conn.fetch_all(
        "SELECT * FROM user_notifications WHERE to_user_id = %s ORDER BY created_at DESC LIMIT %s", (me.user_id, MAX_PER_USER)
    )
    return [_out(r) for r in rows or []]


class MarkRead(BaseModel):
    id: Optional[str] = None
    markAllRead: bool = False
    markByTodo: bool = False
    todoId: Optional[str] = None


@router.put("/api/notifications")
def mark_read(body: MarkRead, me: Identity = Depends(current_identity)):
    """Пометить прочитанным: одно (id), все свои или все по задаче — только свои."""
    if body.markAllRead:
        db.conn.execute_query("UPDATE user_notifications SET read = TRUE WHERE to_user_id = %s", (me.user_id,))
    elif body.markByTodo and body.todoId:
        db.conn.execute_query("UPDATE user_notifications SET read = TRUE WHERE to_user_id = %s AND todo_id = %s", (me.user_id, body.todoId))
    elif body.id:
        db.conn.execute_query("UPDATE user_notifications SET read = TRUE WHERE id = %s AND to_user_id = %s", (body.id, me.user_id))
    return {"success": True}


def create_notification(to_user_id: str, *, type: str = "info", message: str = "", id: Optional[str] = None, **fields) -> None:  # noqa: A002
    """Для кода сервера: добавить запись и обрезать список до MAX_PER_USER."""
    import uuid
    db.conn.execute_query(
        "INSERT INTO user_notifications (id, to_user_id, type, todo_id, todo_title, event_id, event_title, from_user_id, from_user_name, message) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING",
        (id or str(uuid.uuid4()), to_user_id, type, fields.get("todo_id"), fields.get("todo_title"), fields.get("event_id"),
         fields.get("event_title"), fields.get("from_user_id"), fields.get("from_user_name"), message),
    )
    db.conn.execute_query(
        "DELETE FROM user_notifications WHERE to_user_id = %s AND id NOT IN "
        "(SELECT id FROM user_notifications WHERE to_user_id = %s ORDER BY created_at DESC LIMIT %s)",
        (to_user_id, to_user_id, MAX_PER_USER),
    )


__all__: List[str] = ["router", "create_notification"]
