"""Ограничитель частоты: «не больше N событий за окно» на ключ.

Счётчики живут в Redis (общие для всех воркеров); если Redis недоступен —
в памяти процесса: лимит становится «на воркер», но не пропадает совсем.
"""

from __future__ import annotations

import logging
import threading
import time

import redis

from app.config import settings

log = logging.getLogger("shar.ratelimit")


class RateLimiter:
    def __init__(self, redis_url: str) -> None:
        try:
            self._redis = redis.Redis.from_url(redis_url, decode_responses=True, socket_connect_timeout=1, socket_timeout=1)
        except Exception:
            self._redis = None
        self._lock = threading.Lock()
        self._local: dict[str, tuple[int, float]] = {}

    def allow(self, key: str, limit: int, window_seconds: int) -> bool:
        """Учесть событие и вернуть False, если лимит окна исчерпан."""
        full = f"shar:rl:{key}"
        if self._redis is not None:
            try:
                count = self._redis.incr(full)
                if count == 1:
                    self._redis.expire(full, window_seconds)
                return count <= limit
            except Exception as exc:
                log.debug("redis limiter unavailable (%s), falling back to memory", exc)
        now = time.monotonic()
        with self._lock:
            count, deadline = self._local.get(full, (0, 0.0))
            if deadline <= now:
                count, deadline = 0, now + window_seconds
            count += 1
            self._local[full] = (count, deadline)
            if len(self._local) > 10000:
                self._local = {k: v for k, v in self._local.items() if v[1] > now}
            return count <= limit

    def reset(self, key: str) -> None:
        full = f"shar:rl:{key}"
        with self._lock:
            self._local.pop(full, None)
        if self._redis is not None:
            try:
                self._redis.delete(full)
            except Exception:
                pass


limiter = RateLimiter(settings.redis_url)
