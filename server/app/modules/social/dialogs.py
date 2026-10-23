"""Диалоги с клиентами: все площадки (ВКонтакте, MAX) в одной системе, у каждого диалога — своя.

Диалог — клиент на конкретной площадке:
  * личные сообщения — один диалог на собеседника (внешний чат);
  * беседа — один диалог на беседу;
  * комментарии — один диалог на автора под конкретным постом: ответ уходит ответом на его
    последний комментарий там.
Сообщения диалога — social_items: входящие (direction='in') и ответы сотрудников ('out').
«Ждёт ответа» — последнее сообщение диалога от клиента.

Здесь только хранение и рассылка события social_changed; запросы к площадкам — в router.py."""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Optional

from app.core.db import db
from app.core.realtime import sse_manager
from app.modules.chats.access import participant_ids
from app.modules.chats.cache import _get_chat_cached
from app.modules.social.platforms import Incoming

# Регистрирует router.py — после social_accounts, на которую ссылается.
DDL = """
CREATE TABLE IF NOT EXISTS social_dialogs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
    dialog_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    client_name TEXT NOT NULL DEFAULT '',
    client_username TEXT NOT NULL DEFAULT '',
    source_title TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    link TEXT,
    chat_id TEXT,
    last_text TEXT NOT NULL DEFAULT '',
    last_dir TEXT NOT NULL DEFAULT 'in',
    last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, dialog_key)
);
CREATE INDEX IF NOT EXISTS idx_social_dialogs_last ON social_dialogs (last_at DESC);
ALTER TABLE social_items ADD COLUMN IF NOT EXISTS dialog_id TEXT;
ALTER TABLE social_items ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'in';
ALTER TABLE social_items ADD COLUMN IF NOT EXISTS author_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_social_items_dialog ON social_items (dialog_id, created_at);
"""


def dialog_key(inc: Incoming) -> str:
    if inc.chat_type == "comments":
        return f"{inc.ext_chat_id}:{inc.thread}:{inc.author_id}"
    return inc.ext_chat_id


def _preview(text: str, media: List[str]) -> str:
    return (text or ", ".join(media) or "Вложение").replace("\n", " ")[:200]


def upsert_for_incoming(account: dict, inc: Incoming, chat_id: Optional[str]) -> str:
    """Диалог входящего сообщения (создать или поднять наверх). Возвращает id диалога."""
    key = dialog_key(inc)
    dialog_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"shar:social-dialog:{account['id']}:{key}"))
    title = inc.author_name if inc.chat_type in ("private", "business", "comments") else (inc.chat_title or inc.author_name)
    db.conn.execute_query(
        """INSERT INTO social_dialogs (id, account_id, dialog_key, kind, title, client_name, client_username, source_title, context, link, chat_id, last_text, last_dir, last_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'in',now())
           ON CONFLICT (account_id, dialog_key) DO UPDATE SET
             title = EXCLUDED.title, client_name = EXCLUDED.client_name, client_username = EXCLUDED.client_username,
             source_title = EXCLUDED.source_title, context = COALESCE(NULLIF(EXCLUDED.context, ''), social_dialogs.context),
             link = COALESCE(EXCLUDED.link, social_dialogs.link), chat_id = COALESCE(EXCLUDED.chat_id, social_dialogs.chat_id),
             last_text = EXCLUDED.last_text, last_dir = 'in', last_at = now()""",
        (dialog_id, account["id"], key, inc.chat_type, title, inc.author_name, inc.author_username, inc.chat_title,
         inc.context, inc.link, chat_id, _preview(inc.text, inc.media)),
    )
    return dialog_id


def record_out(dialog_id: str, account_id: str, ext_chat_id: str, ext_message_id: str, text: str, user_id: str, user_name: str,
               files: Optional[List[str]] = None) -> dict:
    """Ответ сотрудника — сообщение диалога; диалог больше не ждёт ответа. files — имена вложений."""
    item_id = str(uuid.uuid4())
    data = {"text": text, "author_name": user_name, "media": [f"📎 {n}" for n in files or []], "sent_id": ext_message_id}
    db.conn.execute_query(
        "INSERT INTO social_items (id, account_id, ext_chat_id, ext_message_id, data, status, dialog_id, direction, author_user_id) "
        "VALUES (%s,%s,%s,%s,%s::jsonb,'answered',%s,'out',%s)",
        (item_id, account_id, ext_chat_id, f"out-{item_id}", json.dumps(data, ensure_ascii=False), dialog_id, user_id),
    )
    db.conn.execute_query("UPDATE social_dialogs SET last_text = %s, last_dir = 'out', last_at = now() WHERE id = %s",
                          (_preview(text, data["media"]), dialog_id))
    return {"id": item_id, "direction": "out", "text": text, "media": data["media"], "authorName": user_name, "authorUserId": user_id}


def notify(dialog_id: str) -> None:
    """Событие social_changed: открытые экраны диалогов обновятся сами. Получатели — кто видит раздел
    (админы и те, кому он выдан) и участники чата, куда идут карточки этого диалога."""
    row = db.conn.fetch_one("SELECT chat_id FROM social_dialogs WHERE id = %s", (dialog_id,)) or {}
    ids = {str(u["id"]) for u in (db.get_users() or [])
           if u.get("id") and (u.get("role") == "admin" or "social" in (u.get("enabled_tools") or u.get("enabledTools") or []))}
    chat = _get_chat_cached(str(row["chat_id"])) if row.get("chat_id") else None
    if chat:
        ids |= set(participant_ids(chat))
    for uid in ids:
        try:
            sse_manager.push(uid, {"type": "social_changed", "dialogId": dialog_id})
        except Exception:  # noqa: BLE001 — уведомление не должно ронять приём сообщения
            pass


def view(row: Dict[str, Any], platforms: Dict[str, str], account: Dict[str, Any]) -> dict:
    return {
        "id": row["id"], "accountId": row["account_id"], "platform": account.get("platform"),
        "platformLabel": platforms.get(account.get("platform") or "", ""), "account": account.get("title") or "",
        "kind": row["kind"], "title": row.get("title") or "", "clientName": row.get("client_name") or "",
        "clientUsername": row.get("client_username") or "", "sourceTitle": row.get("source_title") or "",
        "context": row.get("context") or "", "link": row.get("link"), "chatId": row.get("chat_id"),
        "lastText": row.get("last_text") or "", "lastDir": row.get("last_dir") or "in",
        "lastAt": row["last_at"].isoformat() if hasattr(row.get("last_at"), "isoformat") else None,
        "waiting": (row.get("last_dir") or "in") == "in",
    }
