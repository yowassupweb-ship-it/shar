"""Сквозной поиск (Spotlight в Шаре): всё, что человеку доступно и что нельзя целиком держать на клиенте.

  GET /api/search?q=текст&limit=20
      {messages, items, files, attachments, events, mail}

  messages     сообщения моих чатов (я участник)
  items        материалы «Офиса» — по правилам «Офиса»
  files        файлы облака: мои, выданные мне/моему отделу и лежащие в доступных мне папках
  attachments  вложения в сообщениях моих чатов (поиск по имени файла)
  events       события календаря, которые я вижу (те же правила, что в самом календаре)
  mail         письма моих почтовых ящиков

Чаты, люди и задачи ищет сам клиент по уже загруженным данным — это мгновенно.
Каждый раздел ищется независимо: сбой в одном не должен ронять остальные.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable

from fastapi import APIRouter, Depends

from app.core.db import db
from app.core.security import Identity, current_identity
from app.modules.calendar.router import _can_view_event
from app.modules.workspace import store

router = APIRouter()
logger = logging.getLogger(__name__)

# Символ экранирования в LIKE: обратная косая в SQL-строке капризна, восклицательный знак — нет.
_ESC = "ESCAPE '!'"


def _like(query: str) -> str:
    return "%" + re.sub(r"([!%_])", r"!\1", query) + "%"


def _around(text: str, query: str, width: int = 70) -> str:
    """Кусок текста вокруг первого совпадения — чтобы в результате было видно, где нашлось."""
    flat = re.sub(r"\s+", " ", text or "").strip()
    at = flat.lower().find(query.lower())
    if at < 0:
        return flat[: width * 2]
    start = max(0, at - width)
    end = min(len(flat), at + len(query) + width)
    return ("…" if start else "") + flat[start:end] + ("…" if end < len(flat) else "")


def _section(name: str, fn: Callable[[], list[dict[str, Any]]]) -> list[dict[str, Any]]:
    try:
        return fn()
    except Exception:  # noqa: BLE001 — один сломанный раздел не должен убирать остальные результаты
        logger.exception("[search] раздел %s не отработал", name)
        return []


def _messages(me: Identity, pattern: str, query: str, limit: int) -> list[dict[str, Any]]:
    rows = db.conn.fetch_all(
        f"""SELECT m.id, m.chat_id, m.author_name, m.content, m.created_at::text AS created_at
            FROM messages m
            JOIN chat_participants p ON p.chat_id = m.chat_id AND p.user_id = %s
            WHERE COALESCE(m.is_deleted, false) = false AND m.content ILIKE %s {_ESC}
            ORDER BY m.created_at DESC LIMIT %s""",
        (me.user_id, pattern, limit),
    ) or []
    return [{"id": r["id"], "chatId": r["chat_id"], "authorName": r["author_name"] or "", "createdAt": r["created_at"],
             "snippet": _around(r["content"] or "", query)} for r in rows]


def _items(me: Identity, pattern: str, query: str, limit: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in db.conn.fetch_all(
        f"""SELECT {store.LIST_COLUMNS} FROM workspace_items i
            WHERE {store.visible_sql('i')} AND (i.title ILIKE %s {_ESC} OR i.text_content ILIKE %s {_ESC})
            ORDER BY i.updated_at DESC LIMIT %s""",
        tuple(store.visible_params(me.user_id) + [pattern, pattern, limit]),
    ) or []:
        out.append({"id": row["id"], "kind": row["kind"], "title": row["title"], "snippet": _around(row["snippet"] or "", query, 50),
                    "updatedAt": row["updated_at"], "ownerName": (db.get_user_by_id(str(row["owner_id"])) or {}).get("name") or ""})
    return out


def _files(me: Identity, pattern: str, limit: int) -> list[dict[str, Any]]:
    dept = (db.get_user_by_id(me.user_id) or {}).get("department")
    shared = [me.user_id] + ([f"dept:{dept}"] if dept else [])
    # Файл виден, если он мой, выдан мне (или моему отделу) либо лежит в папке, к которой у меня доступ.
    has_access = " OR ".join(["{t}.owner_id = %s"] + ["COALESCE({t}.shared_with, '[]'::jsonb) @> jsonb_build_array(%s::text)"] * len(shared))
    rows = db.conn.fetch_all(
        f"""SELECT f.id, f.name, f.folder_id, f.size, f.mime_type, f.updated_at::text AS updated_at
            FROM cloud_files f
            WHERE f.name ILIKE %s {_ESC}
              AND (({has_access.format(t='f')})
                   OR EXISTS (SELECT 1 FROM cloud_folders d WHERE d.id = f.folder_id AND ({has_access.format(t='d')})))
            ORDER BY f.updated_at DESC NULLS LAST LIMIT %s""",
        tuple([pattern, me.user_id, *shared, me.user_id, *shared, limit]),
    ) or []
    return [{"id": r["id"], "name": r["name"] or "", "folderId": r["folder_id"], "size": r["size"], "mimeType": r["mime_type"] or "",
             "updatedAt": r["updated_at"]} for r in rows]


def _attachments(me: Identity, pattern: str, limit: int) -> list[dict[str, Any]]:
    rows = db.conn.fetch_all(
        f"""SELECT m.id AS message_id, m.chat_id, m.author_name, m.created_at::text AS created_at,
                   a.value->>'name' AS name, a.value->>'url' AS url, a.value->>'size' AS size
            FROM messages m
            JOIN chat_participants p ON p.chat_id = m.chat_id AND p.user_id = %s
            CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments ELSE '[]'::jsonb END) AS a(value)
            WHERE COALESCE(m.is_deleted, false) = false AND a.value->>'name' ILIKE %s {_ESC}
            ORDER BY m.created_at DESC LIMIT %s""",
        (me.user_id, pattern, limit),
    ) or []
    return [{"messageId": r["message_id"], "chatId": r["chat_id"], "authorName": r["author_name"] or "", "createdAt": r["created_at"],
             "name": r["name"] or "", "url": r["url"] or "", "size": int(r["size"]) if (r["size"] or "").isdigit() else None} for r in rows]


def _events(me: Identity, query: str, limit: int) -> list[dict[str, Any]]:
    needle = query.lower()
    found: list[dict[str, Any]] = []
    for event in db.get_events(entity="event"):
        title = str(event.get("title") or "")
        description = str(event.get("description") or "")
        if needle not in title.lower() and needle not in description.lower():
            continue
        if not _can_view_event(event, me):
            continue
        found.append({"id": event["id"], "title": title, "snippet": _around(description, query, 50) if needle in description.lower() else "",
                      "startDate": str(event.get("start_date") or ""), "endDate": str(event.get("end_date") or "")})
    found.sort(key=lambda e: e["startDate"], reverse=True)
    return found[:limit]


def _mail(me: Identity, pattern: str, query: str, limit: int) -> list[dict[str, Any]]:
    rows = db.conn.fetch_all(
        f"""SELECT m.id::text AS id, m.account_id::text AS account_id, m.folder, m.subject, m.from_name, m.from_addr,
                   m.body_text, m.date::text AS date
            FROM email_messages m
            JOIN email_accounts a ON a.id = m.account_id
            WHERE a.user_id = %s
              AND (m.subject ILIKE %s {_ESC} OR m.from_name ILIKE %s {_ESC} OR m.from_addr ILIKE %s {_ESC} OR m.body_text ILIKE %s {_ESC})
            ORDER BY m.date DESC NULLS LAST LIMIT %s""",
        (me.user_id, pattern, pattern, pattern, pattern, limit),
    ) or []
    return [{"id": r["id"], "accountId": r["account_id"], "folder": r["folder"] or "INBOX", "subject": r["subject"] or "",
             "from": r["from_name"] or r["from_addr"] or "", "date": r["date"],
             "snippet": _around(r["body_text"] or "", query, 50)} for r in rows]


@router.get("/api/search")
def search(q: str = "", limit: int = 20, me: Identity = Depends(current_identity)):
    query = q.strip()[:120]
    empty: dict[str, list] = {"messages": [], "items": [], "files": [], "attachments": [], "events": [], "mail": []}
    if len(query) < 2:
        return empty
    limit = max(1, min(limit, 50))
    pattern = _like(query)
    return {
        "messages": _section("messages", lambda: _messages(me, pattern, query, limit)),
        "items": _section("items", lambda: _items(me, pattern, query, limit)),
        "files": _section("files", lambda: _files(me, pattern, limit)),
        "attachments": _section("attachments", lambda: _attachments(me, pattern, limit)),
        "events": _section("events", lambda: _events(me, query, limit)),
        "mail": _section("mail", lambda: _mail(me, pattern, query, limit)),
    }
