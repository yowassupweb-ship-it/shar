from __future__ import annotations

import asyncio
import logging
import threading as _threading
import time
from datetime import datetime, timezone
from typing import Dict, Optional

import anyio.to_thread

from app.core.db import db
from app.core.realtime import sse_manager
from app.modules.calls.rooms import _force_leave_all_calls
from app.modules.calls.state import _call_redis, _redis_available

logger = logging.getLogger(__name__)


# How long a user can have zero live WS connections before we treat them as
# having actually left any call they're in — long enough to absorb a normal
# reconnect (frontend's own backoff starts at 1s, see RECONNECT_DELAY_MAX in
# page.tsx) without ever visibly dropping the call for the other side, short
# enough that an ungraceful disconnect (tab killed, network lost, browser
# crash — none of which get a chance to send an explicit 'leave') stops
# looking like a permanently stuck participant within seconds, not the 6h
# CALL_SESSION_STALE_MS backstop.
CALL_DISCONNECT_GRACE_SEC = 15


# ── Присутствие: «аренда» соединения ────────────────────────────────────────
# Раньше было счётчиком (INCR при подключении, DECR при отключении). Счётчик не
# переживает аварию: упал процесс, перезапустили сервер, оборвалась сеть без
# FIN — DECR не случился, и человек «в сети» до часа (срок жизни ключа). Теперь каждое
# соединение — запись в ZSET пользователя со сроком годности (score). Живой сокет
# продлевает её каждым пингом, мёртвый просто истекает через PRESENCE_TTL, и никто
# не остаётся «в сети» навсегда. «В сети» = есть хотя бы одна неистёкшая запись.
PRESENCE_TTL_SEC = 60


_call_presence_lock = _threading.Lock()


# In-process запасной вариант, если Redis недоступен: {user_id: {conn_id: expires_at}}.
_local_presence: Dict[str, Dict[str, float]] = {}


def _now() -> float:
    return time.time()


def _zkey(user_id: str) -> str:
    return f"shar:presence:{user_id}"  # новый префикс: старые ключи-счётчики другого типа


def _local_live(user_id: str) -> int:
    with _call_presence_lock:
        conns = _local_presence.get(user_id) or {}
        live = {c: t for c, t in conns.items() if t > _now()}
        if live:
            _local_presence[user_id] = live
        else:
            _local_presence.pop(user_id, None)
        return len(live)


def _call_presence_connect(user_id: str, conn_id: str) -> int:
    """Зарегистрировать соединение; вернуть, сколько у человека теперь живых (1 = первое)."""
    if _redis_available():
        try:
            key = _zkey(user_id)
            pipe = _call_redis.pipeline()
            pipe.zremrangebyscore(key, "-inf", _now())      # убрать истёкшие
            pipe.zadd(key, {conn_id: _now() + PRESENCE_TTL_SEC})
            pipe.expire(key, PRESENCE_TTL_SEC * 3)
            pipe.zcard(key)
            return int(pipe.execute()[-1])
        except Exception as e:
            logger.warning("[presence] redis connect failed, memory fallback: %s", e)
    with _call_presence_lock:
        _local_presence.setdefault(user_id, {})[conn_id] = _now() + PRESENCE_TTL_SEC
    return _local_live(user_id)


def _call_presence_touch(user_id: str, conn_id: str) -> None:
    """Продлить аренду живого сокета (зовётся из ping-цикла каждые ~20 с)."""
    if _redis_available():
        try:
            key = _zkey(user_id)
            pipe = _call_redis.pipeline()
            pipe.zadd(key, {conn_id: _now() + PRESENCE_TTL_SEC})
            pipe.expire(key, PRESENCE_TTL_SEC * 3)
            pipe.execute()
            return
        except Exception:
            pass
    with _call_presence_lock:
        _local_presence.setdefault(user_id, {})[conn_id] = _now() + PRESENCE_TTL_SEC


def _ws_online_ids(user_ids: list) -> set:
    """Кто из пользователей сейчас в сети — один конвейер ZCOUNT по неистёкшим записям."""
    ids = [str(u) for u in user_ids if u]
    if not ids:
        return set()
    if _redis_available():
        try:
            pipe = _call_redis.pipeline()
            now = _now()
            for u in ids:
                pipe.zcount(_zkey(u), now, "+inf")
            return {u for u, n in zip(ids, pipe.execute()) if n and int(n) > 0}
        except Exception:
            pass
    return {u for u in ids if _local_live(u) > 0}


def _presence_broadcast(user_id: str, online: bool, last_seen: str) -> None:
    """«В сети / не в сети» — всем, кто сейчас подключён. Потокобезопасно."""
    event = {"type": "presence", "userId": str(user_id), "isOnline": online, "lastSeen": last_seen}
    with sse_manager._lock:
        targets = [uid for uid in sse_manager._queues.keys() if uid != str(user_id)]
    for uid in targets:
        sse_manager.push(uid, event)


def _presence_mark(user_id: str, online: bool) -> None:
    """Запомнить момент в last_seen и разослать событие. Синхронная — в пуле."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.update_user(str(user_id), {"last_seen": now})
    except Exception as e:
        logger.debug(f"[presence] last_seen update failed for {user_id}: {e}")
    _presence_broadcast(user_id, online, now)


def _call_presence_count(user_id: str) -> int:
    if _redis_available():
        try:
            return int(_call_redis.zcount(_zkey(user_id), _now(), "+inf") or 0)
        except Exception:
            pass
    return _local_live(user_id)


def _call_presence_disconnect_and_maybe_schedule(user_id: str, user_name: Optional[str], conn_id: str = "") -> None:
    used_redis = False
    if _redis_available():
        try:
            _call_redis.zrem(_zkey(user_id), conn_id)
            used_redis = True
        except Exception as e:
            logger.warning("[presence] redis disconnect failed, memory fallback: %s", e)
    if not used_redis:
        with _call_presence_lock:
            _local_presence.get(user_id, {}).pop(conn_id, None)
    count = _call_presence_count(user_id)
    if count > 0:
        return  # another tab/connection for this user is still live

    async def _cleanup_after_grace():
        await asyncio.sleep(CALL_DISCONNECT_GRACE_SEC)
        # Re-check the SHARED count — the user may have reconnected (possibly on a
        # different worker) during the grace window.
        if _call_presence_count(user_id) <= 0:
            _force_leave_all_calls(user_id, user_name)
            # Не в сети — только после паузы: переподключение сокета (сеть моргнула,
            # перезагрузка вкладки) не должно мигать точкой у собеседников.
            try:
                await anyio.to_thread.run_sync(_presence_mark, user_id, False)
            except Exception as e:
                logger.debug(f"[presence] offline mark failed for {user_id}: {e}")

    # Функцию зовут и из цикла событий, и из пула потоков (ws_stream уводит её
    # туда ради синхронного Redis). В потоке цикла нет — asyncio.ensure_future
    # падал на каждом отключении сокета, и уборка зависших звонков не
    # планировалась. Отложенную задачу всегда ставим в основной цикл.
    try:
        asyncio.get_running_loop().create_task(_cleanup_after_grace())
    except RuntimeError:
        loop = getattr(sse_manager, '_loop', None)
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(lambda: loop.create_task(_cleanup_after_grace()))
        else:
            logger.warning(f"[calls] no event loop to schedule presence cleanup for {user_id}")
