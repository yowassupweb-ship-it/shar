"""Два правила пушей, которых не хватало (жалоба владельца 26.11.2026):

1. Человек сейчас работает в Шаре (пишет, читает чат, набирает текст) — пуш на телефон не нужен: открытый Шар сам
   покажет сообщение, а телефон в кармане жужжал на каждую реплику живой переписки. «Активен» — было действие за
   последние ACTIVE_TTL секунд; просто открытый (свёрнутый) Шар активностью не считается — тогда пуш на телефон идёт.
2. Прочитал чат на одном устройстве — уведомление должно сняться и на остальных, даже если там Шар закрыт. Для этого
   помним, по каким чатам человеку ушёл пуш, и при прочтении шлём такой пуш-«отмену» (service.dismiss).

Хранение — Redis (общий для всех процессов API), без Redis — память процесса.
"""
from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger("shar.push")

ACTIVE_TTL = 90
PUSHED_TTL = 3 * 24 * 3600

_lock = threading.Lock()
_local: dict[str, float] = {}  # ключ → срок годности (запасной вариант без Redis)


def _redis():
    try:
        from app.modules.calls.state import _call_redis, _redis_available

        return _call_redis if _redis_available() else None
    except Exception:  # noqa: BLE001
        return None


def _set(key: str, ttl: int) -> None:
    r = _redis()
    if r is not None:
        try:
            r.set(key, "1", ex=ttl)
            return
        except Exception as exc:  # noqa: BLE001
            log.debug("push activity set failed: %s", exc)
    with _lock:
        _local[key] = time.time() + ttl
        if len(_local) > 20000:
            now = time.time()
            for k in [k for k, t in _local.items() if t < now]:
                _local.pop(k, None)


def _exists(key: str) -> bool:
    r = _redis()
    if r is not None:
        try:
            return bool(r.exists(key))
        except Exception as exc:  # noqa: BLE001
            log.debug("push activity get failed: %s", exc)
    with _lock:
        return _local.get(key, 0) > time.time()


def _take(key: str) -> bool:
    """Есть ли ключ — и сразу убрать (одна «отмена» на один пуш, даже если прочтение пришло с двух устройств)."""
    r = _redis()
    if r is not None:
        try:
            return bool(r.delete(key))
        except Exception as exc:  # noqa: BLE001
            log.debug("push activity take failed: %s", exc)
    with _lock:
        return _local.pop(key, 0) > time.time()


def touch(user_id: str) -> None:
    """Человек что-то сделал в Шаре (отправил, прочитал, набирает)."""
    if user_id:
        _set(f"shar:active:{user_id}", ACTIVE_TTL)


def is_active(user_id: str) -> bool:
    return bool(user_id) and _exists(f"shar:active:{user_id}")


def mark_pushed(user_id: str, chat_id: str) -> None:
    if user_id and chat_id:
        _set(f"shar:pushed:{user_id}:{chat_id}", PUSHED_TTL)


def take_pushed(user_id: str, chat_id: str) -> bool:
    return bool(user_id and chat_id) and _take(f"shar:pushed:{user_id}:{chat_id}")
