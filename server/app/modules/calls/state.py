from __future__ import annotations

import json
import logging
import threading as _threading
import time
from contextlib import contextmanager
from threading import Lock
from typing import Any, Dict

import redis as _redis_sync

from app.config import settings

logger = logging.getLogger(__name__)


# Long enough that no ordinary session gets caught by it — this only exists to
# clean up a room whose last 'leave' signal got lost (network blip, tab killed
# without a chance to send it), not to time anything out under normal use:
# there's no more "ringing, waiting for an answer" state to expire, every call
# is a room that's live the instant it's created.
CALL_SESSION_STALE_MS = 6 * 60 * 60 * 1000


CALL_SESSION_STALE_SECONDS = CALL_SESSION_STALE_MS // 1000


CALL_SIGNALING_DIR = settings.data_dir / "runtime"


CALL_SIGNALING_FILE = CALL_SIGNALING_DIR / "call-signaling.json"


# In-process lock — used ONLY as the fallback when Redis is unreachable (single
# dev process). The real cross-process lock is the Redis one below.
CALL_SIGNALING_LOCK = Lock()


_CALL_REDIS_URL = settings.redis_url


_CALL_STATE_KEY = "shar:call:state"


_CALL_STATE_LOCK_KEY = "shar:call:state:lock"


_CALL_PRESENCE_KEY = "shar:call:presence:"  # + user_id


try:
    _call_redis = _redis_sync.Redis.from_url(
        _CALL_REDIS_URL, decode_responses=True,
        socket_connect_timeout=2, socket_timeout=2,
    )
except Exception:
    _call_redis = None


# Cache "is Redis reachable" briefly so we don't PING on every single op, while
# still recovering within a few seconds if Redis comes back or drops.
_call_redis_ok = False


_call_redis_checked_at = 0.0


_call_redis_probe_lock = _threading.Lock()


def _redis_available() -> bool:
    global _call_redis_ok, _call_redis_checked_at
    if _call_redis is None:
        return False
    if time.time() - _call_redis_checked_at < 5.0:
        return _call_redis_ok
    with _call_redis_probe_lock:
        if time.time() - _call_redis_checked_at < 5.0:
            return _call_redis_ok
        try:
            _call_redis.ping()
            _call_redis_ok = True
        except Exception:
            _call_redis_ok = False
        _call_redis_checked_at = time.time()
    return _call_redis_ok


@contextmanager
def _call_state_lock():
    """Guards the read-modify-write of call state. A Redis lock when Redis is up
    (so two workers/instances can't clobber each other's session mutations),
    else the in-process threading lock (single-process dev fallback)."""
    if _redis_available():
        lock = _call_redis.lock(_CALL_STATE_LOCK_KEY, timeout=10, blocking_timeout=5)
        acquired = False
        try:
            acquired = lock.acquire()
            yield
        finally:
            if acquired:
                try:
                    lock.release()
                except Exception:
                    pass
    else:
        with CALL_SIGNALING_LOCK:
            yield


def _create_empty_call_state() -> Dict[str, Any]:
    return {"sessions": {}}


def _ensure_call_state_file() -> None:
    CALL_SIGNALING_DIR.mkdir(parents=True, exist_ok=True)
    if not CALL_SIGNALING_FILE.exists():
        CALL_SIGNALING_FILE.write_text(json.dumps(_create_empty_call_state(), ensure_ascii=False, indent=2), encoding="utf-8")


def _load_call_state() -> Dict[str, Any]:
    if _redis_available():
        try:
            raw = _call_redis.get(_CALL_STATE_KEY)
            if not raw:
                return _create_empty_call_state()
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                return _create_empty_call_state()
            parsed.setdefault("sessions", {})
            return parsed
        except Exception as e:
            logger.warning(f"[calls] Redis state load failed, using file fallback: {e}")
    _ensure_call_state_file()
    try:
        raw = CALL_SIGNALING_FILE.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            return _create_empty_call_state()
        parsed.setdefault("sessions", {})
        return parsed
    except Exception:
        return _create_empty_call_state()


def _save_call_state(state: Dict[str, Any]) -> None:
    if _redis_available():
        try:
            # TTL = the stale window, so a leaked/abandoned state self-expires
            # instead of lingering forever; refreshed on every write.
            _call_redis.set(_CALL_STATE_KEY, json.dumps(state, ensure_ascii=False), ex=CALL_SESSION_STALE_SECONDS)
            return
        except Exception as e:
            logger.warning(f"[calls] Redis state save failed, using file fallback: {e}")
    try:
        _ensure_call_state_file()
        temp_file = CALL_SIGNALING_FILE.with_suffix(".json.tmp")
        temp_file.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_file.replace(CALL_SIGNALING_FILE)
    except Exception as e:
        logger.debug(f"[calls] state save failed (non-fatal): {e}")


def _prune_call_state(state: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
    """Returns (state, changed) — `changed` is False when pruning found nothing
    stale, so callers can skip rewriting the file back to disk for no reason.
    See CALL_SESSION_STALE_MS for why this window is generous rather than a
    real "did they answer in time" timeout — there isn't one of those anymore."""
    now = int(time.time() * 1000)
    changed = False

    sessions = state.get("sessions", {})
    for call_id in list(sessions.keys()):
        session = sessions.get(call_id, {})
        if now - int(session.get("lastActivityAt", 0)) >= CALL_SESSION_STALE_MS:
            sessions.pop(call_id, None)
            changed = True

    return state, changed
