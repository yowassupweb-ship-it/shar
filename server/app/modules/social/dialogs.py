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
ALTER TABLE social_dialogs ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '';
ALTER TABLE social_dialogs ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ;
ALTER TABLE social_dialogs ADD COLUMN IF NOT EXISTS handled_by TEXT;
"""

# «Ждёт ответа» — последнее сообщение от клиента и никто не отметил, что вопрос закрыт (ответили не из Шара).
WAITING_SQL = "last_dir = 'in' AND handled_at IS NULL"


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
        """INSERT INTO social_dialogs (id, account_id, dialog_key, kind, title, client_name, client_username, source_title, context, link, chat_id, last_text, last_dir, last_at, avatar)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'in',now(),%s)
           ON CONFLICT (account_id, dialog_key) DO UPDATE SET
             title = EXCLUDED.title, client_name = EXCLUDED.client_name, client_username = EXCLUDED.client_username,
             source_title = EXCLUDED.source_title, context = COALESCE(NULLIF(EXCLUDED.context, ''), social_dialogs.context),
             link = COALESCE(EXCLUDED.link, social_dialogs.link), chat_id = COALESCE(EXCLUDED.chat_id, social_dialogs.chat_id),
             avatar = COALESCE(NULLIF(EXCLUDED.avatar, ''), social_dialogs.avatar),
             last_text = EXCLUDED.last_text, last_dir = 'in', last_at = now(), handled_at = NULL, handled_by = NULL""",
        (dialog_id, account["id"], key, inc.chat_type, title, inc.author_name, inc.author_username, inc.chat_title,
         inc.context, inc.link, chat_id, _preview(inc.text, inc.media), inc.author_avatar),
    )
    return dialog_id


def record_out(dialog_id: str, account_id: str, ext_chat_id: str, ext_message_id: str, text: str, user_id: str, user_name: str,
               files: Optional[List[str]] = None) -> dict:
    """Ответ сотрудника — сообщение диалога; диалог больше не ждёт ответа. ext_message_id — id отправленного
    сообщения на площадке (по нему же отзеркаленный ответ не задвоится); files — имена вложений."""
    media = [f"📎 {n}" for n in files or []]
    data = {"text": text, "author_name": user_name, "media": media, "sent_id": ext_message_id}
    row = db.conn.fetch_one(
        "INSERT INTO social_items (id, account_id, ext_chat_id, ext_message_id, data, status, dialog_id, direction, author_user_id) "
        "VALUES (%s,%s,%s,%s,%s::jsonb,'answered',%s,'out',%s) "
        "ON CONFLICT (account_id, ext_chat_id, ext_message_id) DO UPDATE SET author_user_id = EXCLUDED.author_user_id, data = EXCLUDED.data "
        "RETURNING id",
        (str(uuid.uuid4()), account_id, ext_chat_id, f"out-{ext_message_id}" if ext_message_id else f"out-{uuid.uuid4()}",
         json.dumps(data, ensure_ascii=False), dialog_id, user_id),
    ) or {}
    db.conn.execute_query("UPDATE social_dialogs SET last_text = %s, last_dir = 'out', last_at = now(), handled_at = NULL, handled_by = NULL WHERE id = %s",
                          (_preview(text, media), dialog_id))
    return {"id": row.get("id"), "direction": "out", "text": text, "media": media, "authorName": user_name, "authorUserId": user_id}


def dialog_id_for(account_id: str, key: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"shar:social-dialog:{account_id}:{key}"))


def record_history(account_id: str, dialog_id: str, inc: Incoming, direction: str, at, author_name: str = "") -> bool:
    """Старое или отправленное не из Шара сообщение — в историю диалога, без карточки и уведомлений.
    Повтор (сообщение уже есть) ничего не меняет. Возвращает True, если сообщение новое."""
    data = dict(inc.__dict__)
    if direction == "out":
        data = {"text": inc.text, "author_name": author_name or "Сообщество", "media": inc.media, "images": inc.images, "sent_id": inc.ext_message_id}
        ext_id = f"out-{inc.ext_message_id}"
    else:
        ext_id = inc.ext_message_id
    item_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"shar:social:{account_id}:{inc.ext_chat_id}:{inc.ext_message_id}")) if direction == "in" else str(uuid.uuid4())
    row = db.conn.fetch_one(
        "INSERT INTO social_items (id, account_id, ext_chat_id, ext_message_id, data, status, dialog_id, direction, created_at) "
        "VALUES (%s,%s,%s,%s,%s::jsonb,'answered',%s,%s,%s) ON CONFLICT DO NOTHING RETURNING id",
        (item_id, account_id, inc.ext_chat_id, ext_id, json.dumps(data, ensure_ascii=False), dialog_id, direction, at),
    )
    return bool(row)


def refresh_last(dialog_id: str, recent_hours: int = 48) -> None:
    """Последнее сообщение диалога → список. Старый неотвеченный вопрос не считаем «ждущим»: после
    подгрузки истории в списке не должно оказаться сотен давно забытых диалогов."""
    last = db.conn.fetch_one("SELECT data, direction, created_at FROM social_items WHERE dialog_id = %s ORDER BY created_at DESC LIMIT 1", (dialog_id,))
    if not last:
        return
    data = last.get("data") or {}
    db.conn.execute_query(
        "UPDATE social_dialogs SET last_text = %s, last_dir = %s, last_at = %s, "
        "handled_at = CASE WHEN %s = 'in' AND %s < now() - make_interval(hours => %s) THEN now() ELSE NULL END WHERE id = %s",
        (_preview(data.get("text") or "", data.get("media") or []), last["direction"], last["created_at"],
         last["direction"], last["created_at"], recent_hours, dialog_id),
    )


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
        "clientUsername": row.get("client_username") or "", "avatar": row.get("avatar") or "", "sourceTitle": row.get("source_title") or "",
        "context": row.get("context") or "", "link": row.get("link"), "chatId": row.get("chat_id"),
        "lastText": row.get("last_text") or "", "lastDir": row.get("last_dir") or "in",
        "lastAt": row["last_at"].isoformat() if hasattr(row.get("last_at"), "isoformat") else None,
        "waiting": (row.get("last_dir") or "in") == "in" and not row.get("handled_at"),
        "handled": bool(row.get("handled_at")),
        "handledAt": row["handled_at"].isoformat() if hasattr(row.get("handled_at"), "isoformat") else None,
    }


def set_handled(dialog_id: str, handled: bool, user_id: str) -> None:
    """Отметка «ответ дан»: клиенту ответили не из Шара (на сайте, по телефону) или отвечать не нужно.
    Новое сообщение клиента снимает отметку."""
    db.conn.execute_query(
        "UPDATE social_dialogs SET handled_at = CASE WHEN %s THEN now() ELSE NULL END, handled_by = CASE WHEN %s THEN %s ELSE NULL END WHERE id = %s",
        (handled, handled, user_id, dialog_id),
    )


def ensure_private(account: dict, peer_id: str, name: str, username: str, chat_id: Optional[str], kind: str = "private", avatar: str = "") -> str:
    """Личный диалог с человеком (его создают и входящие сообщения: ключ — id собеседника). Нужен, когда
    сообщество пишет первым — например, автору комментария. Возвращает id диалога."""
    dialog_id = dialog_id_for(account["id"], peer_id)
    db.conn.execute_query(
        """INSERT INTO social_dialogs (id, account_id, dialog_key, kind, title, client_name, client_username, source_title, chat_id, last_text, last_dir, last_at, avatar)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'','out',now(),%s)
           ON CONFLICT (account_id, dialog_key) DO UPDATE SET avatar = COALESCE(NULLIF(EXCLUDED.avatar, ''), social_dialogs.avatar)""",
        (dialog_id, account["id"], peer_id, kind, name, name, username, name, chat_id, avatar),
    )
    return dialog_id
