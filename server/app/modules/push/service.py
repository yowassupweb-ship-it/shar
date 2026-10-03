"""Отправка web-push (VAPID). Вызывается из любого модуля: `push.notify(...)`.

Работает синхронно и внутри пула потоков (отправка идёт в сеть) — из async-кода
вызывать через run_in_threadpool, из sync-кода и фоновых задач — напрямую.
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Iterable

from app.config import settings
from app.modules.push import store

log = logging.getLogger("shar.push")

try:  # pywebpush не обязателен для запуска: без него (или без ключей) пуши просто не уходят
    from pywebpush import WebPushException, webpush
except Exception:  # pragma: no cover - зависит от окружения
    webpush = None  # type: ignore[assignment]
    WebPushException = Exception  # type: ignore[assignment,misc]

_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="webpush")


def is_configured() -> bool:
    return bool(webpush and settings.vapid_public_key and settings.vapid_private_key)


def public_key() -> str:
    return settings.vapid_public_key


def _send_one(item: Dict[str, Any], data: str, tag: str) -> bool | None:
    """True — доставлено, False — ошибка, None — подписка мертва и удалена."""
    endpoint = str(item["endpoint"])
    is_fcm = "googleapis.com" in endpoint or "fcm.googleapis" in endpoint
    is_mozilla = "mozilla.com" in endpoint or "push.services.mozilla" in endpoint
    headers: Dict[str, str] = {"Urgency": "high"}
    if not is_fcm and not is_mozilla:
        headers["Topic"] = (tag or "shar-notification")[:32]  # RFC 8030: до 32 символов
    try:
        webpush(
            subscription_info=item["subscription"],
            data=data,
            vapid_private_key=settings.vapid_private_key,
            vapid_claims={"sub": settings.vapid_subject},
            ttl=86400,
            headers=headers,
            # Часть старых Android Chrome понимает только aesgcm.
            content_encoding="aesgcm" if is_fcm else "aes128gcm",
            timeout=8,
        )
        return True
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", 0) or 0
        body = str(getattr(getattr(exc, "response", None), "text", "") or "").lower()
        expired = status in (404, 410, 401) or (status == 400 and any(w in body for w in ("invalid", "expired", "unregistered", "notregistered")))
        if expired:
            store.drop_endpoint(endpoint)
            return None
        log.warning("webpush failed: status=%s endpoint=%s…", status, endpoint[:60])
        return False
    except Exception as exc:
        log.warning("webpush error: %s endpoint=%s…", type(exc).__name__, endpoint[:60])
        return False


def send_to_user(user_id: str, payload: Dict[str, Any]) -> Dict[str, int]:
    if not is_configured() or not user_id:
        return {"sent": 0, "failed": 0}
    items = store.subscriptions_of(str(user_id))
    if not items:
        return {"sent": 0, "failed": 0}
    data = json.dumps(payload, ensure_ascii=False)
    tag = str(payload.get("tag") or "")
    results = list(_pool.map(lambda it: _send_one(it, data, tag), items))
    return {"sent": sum(1 for r in results if r is True), "failed": sum(1 for r in results if r is False)}


def notify(recipient_ids: Iterable[str], *, title: str, body: str = "", url: str = "/", tag: str = "message", **extra: Any) -> Dict[str, int]:
    """Пуш получателям с учётом их настроек (реакции можно отключить)."""
    ids = [str(r) for r in dict.fromkeys(recipient_ids) if r]
    if tag.startswith("reaction-"):
        ids = [uid for uid in ids if store.get_prefs(uid).get("reactions") is not False]
    totals = {"sent": 0, "failed": 0}
    payload = {"title": title, "body": body, "url": url, "tag": tag, **extra}
    for uid in ids:
        res = send_to_user(uid, payload)
        totals["sent"] += res["sent"]
        totals["failed"] += res["failed"]
    return totals
