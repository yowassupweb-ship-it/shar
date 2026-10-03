"""Настройки, которыми админ управляет из интерфейса (сейчас — Telegram-уведомления).

Секреты наружу не отдаются: GET возвращает маску и признак «задано». При сохранении
пустое значение или маска означают «не менять», явный null — стереть."""

from __future__ import annotations

from typing import Any, Dict

from app.core.db import db

SECRET_FIELDS = ("telegramBotToken", "telegramProxy")
TEXT_FIELDS = ("telegramChatId",)
BOOL_FIELDS = ("telegramNotifications", "errorNotification")
MASK = "••••"


def mask(value: str) -> str:
    return f"{MASK}{value[-4:]}" if value and len(value) > 8 else (MASK if value else "")


def read() -> Dict[str, Any]:
    stored = db.get_settings() or {}
    out: Dict[str, Any] = {}
    for key in SECRET_FIELDS:
        raw = str(stored.get(key) or "")
        out[key] = mask(raw)
        out[f"{key}Set"] = bool(raw)
    for key in TEXT_FIELDS:
        out[key] = str(stored.get(key) or "")
    for key in BOOL_FIELDS:
        out[key] = bool(stored.get(key, key == "errorNotification"))
    return out


def write(patch: Dict[str, Any]) -> Dict[str, Any]:
    updates: Dict[str, Any] = {}
    for key in SECRET_FIELDS:
        if key not in patch:
            continue
        value = patch[key]
        if value is None:
            updates[key] = ""
        elif isinstance(value, str) and value.strip() and not value.startswith(MASK):
            updates[key] = value.strip()
    for key in TEXT_FIELDS:
        if key in patch and isinstance(patch[key], str):
            updates[key] = patch[key].strip()
    for key in BOOL_FIELDS:
        if key in patch:
            updates[key] = bool(patch[key])
    if updates:
        db.update_settings(updates)
    return read()
