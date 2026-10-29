"""Режимы разрешений агента «Ядра»: что он делает сам, а что — только с согласия человека.

Кто-то хочет «под ключ», кто-то боится, что агент натворит лишнего. Человек выбирает режим в Настройки → Ядро:

  auto      под ключ: сам делает всё, что можно человеку; спрашивает только перед удалением
  careful   осторожно (по умолчанию): ещё спрашивает перед тем, что касается других людей — задачи коллегам, приглашения
            в календарь и «всем», запись во внешние API, подключение и удаление API
  ask       спрашивать всегда: любое изменение — только с разрешения

Правило держит сервер, а не совесть агента: инструмент MCP, которому в этом режиме нужно разрешение, без одобренного
approval_id не выполнится. Агент зовёт request_permission — под его ответом появляется карточка «Разрешить / Запретить»,
он заканчивает ход и ждёт. «Разрешить» выдаёт одноразовое разрешение на этот инструмент (живёт час), и агент продолжает.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from app.core import schema
from app.core.db import db

MODES = {
    "auto": {"label": "Под ключ", "hint": "Делает сам, спрашивает только перед удалением"},
    "careful": {"label": "Осторожно", "hint": "Спрашивает перед удалением и тем, что касается других людей"},
    "ask": {"label": "Спрашивать всегда", "hint": "Любое изменение — только с вашего разрешения"},
}
DEFAULT = "careful"

# Удаление и необратимое — с разрешением в любом режиме, кроме «под ключ» (там хватает confirm: true от агента).
ALWAYS_ASK = {"delete_item", "calendar_delete", "task_delete", "file_delete", "integration_delete", "agent_disconnect"}
# Касается других людей или внешних систем.
SOCIAL = {"integration_save"}
# Не изменения: чтение, память и навыки агента, вопросы человеку, открыть окно.
FREE = {"request_permission", "ask_user", "open_in_shar", "profile_note", "profile_write", "memory_add", "skill_write"}

schema.register("core_permissions", """
CREATE TABLE IF NOT EXISTS core_settings (
    user_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'careful',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS core_approvals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    message_id TEXT NOT NULL DEFAULT '',
    tool TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ
);
""")


def mode_of(user_id: str) -> str:
    row = db.conn.fetch_one("SELECT mode FROM core_settings WHERE user_id = %s", (user_id,))
    mode = (row or {}).get("mode") or DEFAULT
    return mode if mode in MODES else DEFAULT


def set_mode(user_id: str, mode: str) -> None:
    db.conn.execute_query(
        "INSERT INTO core_settings (user_id, mode) VALUES (%s, %s) ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()",
        (user_id, mode))


def _others(ids: Any, me: str) -> bool:
    return any(str(x) != me for x in (ids or []))


def reason(mode: str, tool: dict[str, Any], args: dict[str, Any], me: str) -> Optional[str]:
    """Почему этому вызову нужно согласие человека (None — можно сразу)."""
    name = tool["name"]
    if name in FREE:
        return None
    writes = tool["level"] != "read" or (name == "integration_call" and str(args.get("method") or "GET").upper() != "GET")
    if not writes and name not in ALWAYS_ASK:
        return None
    if mode == "auto":
        return None
    if name in ALWAYS_ASK:
        return "удаление"
    if mode == "ask":
        return "любое изменение в режиме «Спрашивать всегда»"
    if name in SOCIAL:
        return "подключение API компании"
    if name == "integration_call":
        return "запись во внешний сервис"
    if name in ("task_create", "task_update") and _others(args.get("assignee_ids"), me):
        return "задача другим людям"
    if name in ("calendar_create", "calendar_update") and (_others(args.get("participants"), me) or args.get("shared_with_all")):
        return "событие с другими людьми"
    return None


def request(user_id: str, message_id: str, tool: str, summary: str) -> str:
    approval_id = uuid.uuid4().hex[:16]
    db.conn.execute_query("INSERT INTO core_approvals (id, user_id, message_id, tool, summary) VALUES (%s, %s, %s, %s, %s)",
                          (approval_id, user_id, message_id, tool, summary[:500]))
    from app.modules.core_chat.router import update_agent_message

    update_agent_message(message_id, props={
        "ask": {"kind": "permission", "question": summary[:500], "approvalId": approval_id, "tool": tool},
        "actions": [{"label": "Разрешить", "value": "Разрешить"}, {"label": "Запретить", "value": "Запретить"}],
    })
    return approval_id


def decide(approval_id: str, user_id: str, allow: bool) -> Optional[dict]:
    return db.conn.fetch_one(
        "UPDATE core_approvals SET status = %s, decided_at = now() WHERE id = %s AND user_id = %s AND status = 'pending' RETURNING *",
        ("granted" if allow else "denied", approval_id, user_id))


def consume(approval_id: Any, user_id: str, tool: str) -> bool:
    """Одноразово: разрешение на этот инструмент, выданное за последний час, гасится при использовании."""
    if not approval_id:
        return False
    return bool(db.conn.fetch_one(
        "UPDATE core_approvals SET status = 'used' WHERE id = %s AND user_id = %s AND tool = %s AND status = 'granted' "
        "AND decided_at > now() - interval '1 hour' RETURNING id", (str(approval_id), user_id, tool)))


def view() -> list[dict]:
    return [{"id": k, **v} for k, v in MODES.items()]
