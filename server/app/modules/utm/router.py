"""Генератор UTM: общие пресеты и личная история ссылок.

Пресеты — один общий список (раньше общий JSON-файл Next), история — у каждого своя
(/api/tracked-posts; в старом бэкенде эти маршруты вызывали несуществующие методы базы
и отвечали 500). Хранилище — app_kv, правка атомарна."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core import kv
from app.core.security import Identity, current_identity

router = APIRouter()

PRESETS_KEY = "utm:presets"
MAX_PRESETS = 100
MAX_HISTORY = 300

DEFAULT_PRESETS: List[Dict[str, str]] = [
    {"id": "yandex", "name": "Яндекс", "source": "yandex", "medium": "cpc", "color": "bg-yellow-500/20 text-yellow-400 border-yellow-500/30", "description": "Яндекс.Директ"},
    {"id": "google", "name": "Google", "source": "google", "medium": "cpc", "color": "bg-blue-500/20 text-blue-400 border-blue-500/30", "description": "Google Ads"},
    {"id": "vk", "name": "VK", "source": "vk", "medium": "social", "color": "bg-sky-500/20 text-sky-400 border-sky-500/30", "description": "ВКонтакте"},
    {"id": "tg", "name": "Telegram", "source": "telegram", "medium": "social", "color": "bg-cyan-500/20 text-cyan-400 border-cyan-500/30", "description": "Telegram"},
    {"id": "dzen", "name": "Дзен", "source": "dzen", "medium": "social", "color": "bg-orange-500/20 text-orange-400 border-orange-500/30", "description": "Яндекс.Дзен"},
    {"id": "email", "name": "Email", "source": "email", "medium": "email", "color": "bg-purple-500/20 text-purple-400 border-purple-500/30", "description": "Email-рассылка"},
    {"id": "qr", "name": "QR", "source": "qr", "medium": "offline", "color": "bg-green-500/20 text-green-400 border-green-500/30", "description": "Оффлайн (QR-код)"},
]


@router.get("/api/utm-presets")
def get_presets(me: Identity = Depends(current_identity)):
    stored = kv.get(PRESETS_KEY)
    return stored if isinstance(stored, list) and stored else DEFAULT_PRESETS


@router.post("/api/utm-presets")
def save_presets(presets: List[Dict[str, Any]] = Body(...), me: Identity = Depends(current_identity)):
    if len(presets) > MAX_PRESETS:
        raise HTTPException(status_code=400, detail="Слишком много пресетов")
    clean = [{k: str(v)[:200] for k, v in p.items() if isinstance(v, (str, int, float))} for p in presets if isinstance(p, dict)]
    kv.set(PRESETS_KEY, clean)
    return {"success": True, "presets": clean}


@router.delete("/api/utm-presets")
def reset_presets(me: Identity = Depends(current_identity)):
    kv.set(PRESETS_KEY, DEFAULT_PRESETS)
    return {"success": True, "presets": DEFAULT_PRESETS}


def _history_key(uid: str) -> str:
    return f"utm:history:{uid}"


@router.get("/api/tracked-posts")
def list_history(me: Identity = Depends(current_identity)):
    return kv.get(_history_key(me.user_id), []) or []


@router.post("/api/tracked-posts")
def add_history(item: Dict[str, Any] = Body(...), me: Identity = Depends(current_identity)):
    entry = {k: v for k, v in item.items() if k in {"platform", "postUrl", "title", "utmTemplate", "utmUrl", "clicks", "views", "conversions", "users", "frequency", "avgTime"}}
    entry = {k: (v[:2000] if isinstance(v, str) else v) for k, v in entry.items()}
    entry.update(id=str(uuid.uuid4()), createdAt=datetime.now(timezone.utc).isoformat())

    def add(state: Any) -> List[Dict[str, Any]]:
        return [entry, *(state or [])][:MAX_HISTORY]

    kv.update(_history_key(me.user_id), [], add)
    return entry


@router.delete("/api/tracked-posts/{post_id}")
def remove_history(post_id: str, me: Identity = Depends(current_identity)):
    holder = {"found": False}

    def drop(state: Any) -> List[Dict[str, Any]]:
        kept = [p for p in (state or []) if str(p.get("id")) != post_id]
        holder["found"] = len(kept) != len(state or [])
        return kept

    kv.update(_history_key(me.user_id), [], drop)
    if not holder["found"]:
        raise HTTPException(status_code=404, detail="Не найдено")
    return {"success": True}
