"""Уведомления модуля «Соцсети»: кому и куда приходит новое сообщение или комментарий клиента.

Настройки (app_kv `social_notify`), отдельно для двух вкладок модуля:
  * dialogs / comments → {"to": "all" | "selected", "users": [id, …]} — кому. «Все» — все, у кого
    есть доступ к модулю (админы и те, кому выдан `social`); выбранные — только из них же: снятый
    доступ снимает и уведомления;
  * desktop — уведомление на компьютере (Shar OS, открытая вкладка браузера): событие
    social_message по сокету, показывает клиент;
  * push — web-push тем, у кого Шар сейчас не открыт (телефон, закрытое приложение).
Дублирование в чат Шара — отдельно, в подключениях (источник → чат)."""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.core import kv
from app.core.db import db
from app.core.realtime import sse_manager
from app.modules.calls.presence import _call_presence_count
from app.modules.push import service as push_service

log = logging.getLogger("shar.social.notify")

KEY = "social_notify"
TOOL = "social"
DEFAULT: Dict[str, Any] = {
    "dialogs": {"to": "all", "users": []},
    "comments": {"to": "all", "users": []},
    "desktop": True,
    "push": True,
}


def _rule(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    to = raw.get("to") if raw.get("to") in ("all", "selected") else "all"
    users = [str(u) for u in (raw.get("users") or []) if u][:500]
    return {"to": to, "users": list(dict.fromkeys(users))}


def load() -> Dict[str, Any]:
    data = kv.get(KEY, DEFAULT) or {}
    return {
        "dialogs": _rule(data.get("dialogs")), "comments": _rule(data.get("comments")),
        "desktop": data.get("desktop") is not False, "push": data.get("push") is not False,
    }


def save(body: Dict[str, Any]) -> Dict[str, Any]:
    clean = {
        "dialogs": _rule(body.get("dialogs")), "comments": _rule(body.get("comments")),
        "desktop": body.get("desktop") is not False, "push": body.get("push") is not False,
    }
    kv.update(KEY, DEFAULT, lambda _old: clean)
    return clean


def with_access() -> List[dict]:
    """Кто видит модуль: админы и те, кому он выдан (отключённые — нет)."""
    return [u for u in (db.get_users() or []) if u.get("id") and (
        u.get("role") == "admin" or TOOL in (u.get("enabled_tools") or u.get("enabledTools") or []))]


def recipients(kind: str) -> List[str]:
    rule = load()["comments" if kind == "comments" else "dialogs"]
    allowed = [str(u["id"]) for u in with_access()]
    if rule["to"] == "selected":
        chosen = set(rule["users"])
        return [u for u in allowed if u in chosen]
    return allowed


def new_message(*, dialog_id: str, item_id: str, kind: str, platform: str, platform_label: str,
                client_name: str, source_title: str, text: str) -> None:
    """Сообщение клиента пришло — уведомить по настройкам. Сбой уведомления не мешает приёму."""
    try:
        cfg = load()
        ids = recipients(kind)
        if not ids:
            return
        tab = "comments" if kind == "comments" else "dialogs"
        url = f"/social?{'tab=comments&' if tab == 'comments' else ''}dialog={dialog_id}"
        title = f"{platform_label}: {client_name}" if client_name else platform_label
        body = (f"{source_title}: " if kind == "comments" and source_title else "") + (text or "Вложение")
        if cfg["desktop"]:
            event = {"type": "social_message", "dialogId": dialog_id, "itemId": item_id, "kind": tab,
                     "platform": platform, "title": title, "body": body[:300], "url": url}
            for uid in ids:
                try:
                    sse_manager.push(uid, event)
                except Exception:  # noqa: BLE001
                    pass
        if cfg["push"]:
            # Тем, у кого Шар открыт, хватит уведомления на экране — пуш только тем, кто не в сети.
            offline = [uid for uid in ids if _call_presence_count(uid) <= 0]
            if offline:
                push_service.notify(offline, title=title, body=body[:120], url=url, tag=f"social-{dialog_id}")
    except Exception as e:  # noqa: BLE001
        log.warning("social notify failed: %s", e)
