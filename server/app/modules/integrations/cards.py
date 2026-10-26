"""Карточки из внешних систем в чатах Шара: заявки с сайта, позже — сообщения Telegram и MAX.

Карточка — обычное сообщение чата (его видно в ленте, поиске, превью списка, оно считается
непрочитанным и приходит пушем), но автор у него не сотрудник, а источник: `integration:<имя>`.
На боевой базе messages.author_id ссылается на users, поэтому у источника есть служебная учётка —
отключённая (войти под ней нельзя, в списках людей её нет), с непроходимым паролем. Всё, что нужно для вида карточки, лежит в metadata.card;
content — короткий текст для превью, поиска и пуша.

Ответить на карточку в чате можно как на любое сообщение — это обсуждение внутри команды."""

from __future__ import annotations

import json
import logging
import secrets
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from app.core.db import db
from app.core.realtime import sse_manager
from app.modules.calls.presence import _call_presence_count
from app.modules.chats.cache import _get_chat_cached, _update_chat_cache_field
from app.modules.push import service as push_service

log = logging.getLogger("shar.cards")


def _participants(chat: dict) -> List[str]:
    return [str(u) for u in (chat.get("participant_ids") or chat.get("participantIds") or [])]


_authors: set = set()


def _ensure_author(author_id: str, name: str) -> None:
    """Служебная учётка источника (один раз за процесс; повтор вставки ничего не делает)."""
    if author_id in _authors:
        return
    db.conn.execute_query(
        "INSERT INTO users (id, name, username, email, password, role, is_disabled) VALUES (%s, %s, %s, %s, %s, 'user', true) "
        "ON CONFLICT (id) DO NOTHING",
        (author_id, name, author_id, f"{author_id.replace(':', '-')}@integrations.invalid", "!" + secrets.token_hex(32)),
    )
    _authors.add(author_id)


def post_card(chat_id: str, *, source: str, author_name: str, content: str, card: Dict[str, Any],
              message_id: Optional[str] = None, attachments: Optional[list] = None) -> dict:
    """Положить карточку в чат и разослать её. message_id — свой (повторная доставка того же
    события не создаёт второй карточки: вставка с тем же id ничего не делает)."""
    chat = _get_chat_cached(chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    created = datetime.now(timezone.utc)
    author_id = f"integration:{source}"
    _ensure_author(author_id, author_name)
    row = {
        "id": message_id or str(uuid.uuid4()),
        "chat_id": chat_id,
        "author_id": author_id,
        "author_name": author_name,
        "content": content,
        "mentions": [],
        "reply_to_id": None,
        "created_at": created.isoformat(),
        "updated_at": None,
        "is_edited": False,
        "attachments": attachments or [],
        "metadata": {"card": card},
    }
    if not db.add_message(row, if_new=bool(message_id)):
        existing = db.conn.fetch_one("SELECT id FROM messages WHERE id = %s", (row["id"],)) if message_id else None
        if existing:
            return {"id": row["id"], "duplicate": True}
        raise HTTPException(status_code=500, detail="Failed to save card")
    try:
        db.update_chat(chat_id, {"last_message_id": row["id"], "updated_at": created.isoformat()})
        _update_chat_cache_field(chat_id, "last_message_id", row["id"])
    except Exception as e:
        log.debug("card: last_message update failed: %s", e)

    camel = {
        "id": row["id"], "chatId": chat_id, "authorId": author_id, "authorName": author_name,
        "content": content, "createdAt": created.isoformat(), "updatedAt": None,
        "isEdited": False, "isDeleted": False, "isSystemMessage": False,
        "attachments": row["attachments"], "mentions": [], "replyToId": None, "metadata": row["metadata"],
    }
    try:
        sse_manager.push_to_chat(chat, "", {"type": "new_message", "chatId": chat_id, "messageId": row["id"], "message": camel})
    except Exception as e:
        log.warning("card: SSE push failed for chat %s: %s", chat_id, e)
    _web_push(chat, chat_id, author_name, content)
    return camel


def _web_push(chat: dict, chat_id: str, author_name: str, content: str) -> None:
    """Пуш тем, кто не в сети и не выключил звук у чата (как у обычных сообщений)."""
    try:
        muted = chat.get("muted_by_user") or chat.get("mutedByUser") or {}
        recipients = [u for u in _participants(chat) if not muted.get(u) and _call_presence_count(u) <= 0]
        if not recipients:
            return
        title = chat.get("title") or chat.get("name") or author_name
        push_service.notify(
            recipients, title=f"{author_name} в {title}", body=content[:120],
            url=f"/account?tab=messages&chat={chat_id}", tag=f"chat-{chat_id}", chatId=str(chat_id), senderName=author_name,
        )
    except Exception as e:
        log.debug("card: web push skipped: %s", e)


def update_card(message_id: str, patch: Dict[str, Any]) -> Optional[dict]:
    """Поменять поля карточки (статус, ответственный) и разослать новое состояние участникам чата."""
    row = db.conn.fetch_one("SELECT chat_id, metadata FROM messages WHERE id = %s", (message_id,))
    if not row:
        return None
    meta = dict(row.get("metadata") or {})
    card = {**(meta.get("card") or {}), **patch}
    meta["card"] = card
    db.conn.execute_query("UPDATE messages SET metadata = %s::jsonb WHERE id = %s", (json.dumps(meta, ensure_ascii=False), message_id))
    chat_id = str(row["chat_id"])
    chat = _get_chat_cached(chat_id)
    if chat:
        try:
            sse_manager.push_to_chat(chat, "", {"type": "card_updated", "chatId": chat_id, "messageId": message_id, "card": card})
        except Exception as e:
            log.warning("card: update push failed: %s", e)
    return card

