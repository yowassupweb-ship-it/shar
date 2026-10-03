"""Серверные сессии в Redis.

Раньше «авторизация» жила целиком в браузере: localStorage.isAuthenticated
== 'true' пускал куда угодно, а сервер вообще никого не проверял. Здесь
появляется единственный источник правды — Redis: токен → запись о сессии.

Ключи:
    shar:session:<token>        HASH с данными сессии, TTL = SESSION_TTL
    shar:sessions:<user_id>     SET токенов пользователя (для списка устройств)

Один Redis на все входы: сессия, выданная в вебе, видна и Electron-клиенту, и
любому воркеру бэкенда — отдельного состояния в процессе не остаётся.

Если Redis недоступен, все функции возвращают «нет сессии», а не падают:
вход тогда деградирует до прежнего поведения, а не ломает приложение целиком.
"""

import json
import os
import secrets
import time
from typing import Any, Dict, List, Optional

import redis as _redis

SESSION_TTL_SECONDS = int(os.getenv("SHAR_SESSION_TTL", str(60 * 60 * 24 * 90)))  # 90 дней
SESSION_COOKIE = "shar_session"

_SESSION_KEY = "shar:session:"
_USER_SESSIONS_KEY = "shar:sessions:"

try:
    _redis_client = _redis.Redis.from_url(
        os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0"),
        decode_responses=True, socket_connect_timeout=2, socket_timeout=2,
    )
except Exception:
    _redis_client = None


# Когда Redis лежит, каждая попытка соединиться на Windows ждёт отказа около
# двух секунд — и так на каждый HTTP-запрос. Помним неудачу пять секунд и в это
# окно сразу отвечаем «нет сессии», не стучась заново.
_DOWN_RETRY_SECONDS = 5.0
_down_until = 0.0


class _DevMemoryStore:
    """Замена Redis для локальной разработки (SHAR_DEV_MEMORY_SESSIONS=1).

    Умеет ровно те команды, что нужны этому модулю. Живёт в процессе и
    сохраняется в файл, чтобы перезапуск uvicorn --reload не разлогинивал.
    На проде переменная не задана — там сессии только в Redis."""

    _FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".dev_sessions.json")

    def __init__(self):
        self._hashes: Dict[str, Dict[str, str]] = {}
        self._sets: Dict[str, set] = {}
        self._expires: Dict[str, float] = {}
        try:
            with open(self._FILE, encoding="utf-8") as f:
                data = json.load(f)
            self._hashes = data.get("hashes", {})
            self._sets = {k: set(v) for k, v in data.get("sets", {}).items()}
            self._expires = data.get("expires", {})
        except Exception:
            pass

    def _save(self):
        try:
            with open(self._FILE, "w", encoding="utf-8") as f:
                json.dump({
                    "hashes": self._hashes,
                    "sets": {k: sorted(v) for k, v in self._sets.items()},
                    "expires": self._expires,
                }, f)
        except Exception:
            pass

    def _alive(self, key: str) -> bool:
        deadline = self._expires.get(key)
        if deadline is not None and deadline < time.time():
            self._hashes.pop(key, None)
            self._sets.pop(key, None)
            self._expires.pop(key, None)
            return False
        return True

    def hgetall(self, key):
        return dict(self._hashes.get(key, {})) if self._alive(key) else {}

    def hset(self, key, field=None, value=None, mapping=None):
        h = self._hashes.setdefault(key, {})
        if mapping:
            h.update({k: str(v) for k, v in mapping.items()})
        if field is not None:
            h[field] = str(value)
        self._save()

    def expire(self, key, seconds):
        self._expires[key] = time.time() + int(seconds)
        self._save()

    def sadd(self, key, *members):
        self._sets.setdefault(key, set()).update(members)
        self._save()

    def srem(self, key, *members):
        self._sets.get(key, set()).difference_update(members)
        self._save()

    def smembers(self, key):
        return set(self._sets.get(key, set())) if self._alive(key) else set()

    def delete(self, *keys):
        for key in keys:
            self._hashes.pop(key, None)
            self._sets.pop(key, None)
            self._expires.pop(key, None)
        self._save()

    def pipeline(self):
        store = self

        class _Pipe:
            def __init__(self):
                self._calls = []

            def __getattr__(self, name):
                def call(*args, **kwargs):
                    self._calls.append((name, args, kwargs))
                    return self
                return call

            def execute(self):
                return [getattr(store, n)(*a, **kw) for n, a, kw in self._calls]

        return _Pipe()


_dev_store: Optional[_DevMemoryStore] = None


def _dev_fallback() -> Optional[Any]:
    """Хранилище в памяти — только если явно включено в .env."""
    global _dev_store
    if os.getenv("SHAR_DEV_MEMORY_SESSIONS", "").strip() not in ("1", "true", "yes"):
        return None
    if _dev_store is None:
        _dev_store = _DevMemoryStore()
    return _dev_store


def _client() -> Optional[Any]:
    if _redis_client is None or time.monotonic() < _down_until:
        return _dev_fallback()
    if _dev_fallback() is not None:
        # Локально: если Redis не отвечает, сразу берём память, без двухсекундных
        # ожиданий отказа на каждом запросе.
        try:
            _redis_client.ping()
        except Exception as exc:
            _mark_down(exc)
            return _dev_fallback()
    return _redis_client


def _mark_down(exc: Exception) -> None:
    """Сбой соединения — запоминаем; ошибка данных — нет."""
    global _down_until
    if isinstance(exc, (_redis.ConnectionError, _redis.TimeoutError)):
        _down_until = time.monotonic() + _DOWN_RETRY_SECONDS


def _now() -> int:
    return int(time.time())


def create_session(user_id: str, username: str, *, user_agent: str = "",
                   ip: str = "", device: str = "") -> Optional[str]:
    """Создаёт сессию и возвращает её токен (None, если Redis недоступен)."""
    client = _client()
    if client is None:
        return None
    token = secrets.token_urlsafe(48)
    record = {
        "userId": str(user_id),
        "username": str(username or ""),
        "createdAt": str(_now()),
        "lastSeenAt": str(_now()),
        "userAgent": (user_agent or "")[:400],
        "ip": (ip or "")[:64],
        "device": (device or "")[:120],
    }
    try:
        pipe = client.pipeline()
        pipe.hset(_SESSION_KEY + token, mapping=record)
        pipe.expire(_SESSION_KEY + token, SESSION_TTL_SECONDS)
        pipe.sadd(_USER_SESSIONS_KEY + str(user_id), token)
        # Набор токенов живёт чуть дольше самой длинной сессии, иначе список
        # устройств мог опустеть раньше, чем истекут сами сессии.
        pipe.expire(_USER_SESSIONS_KEY + str(user_id), SESSION_TTL_SECONDS + 86400)
        pipe.execute()
        return token
    except Exception as exc:
        _mark_down(exc)
        return None


def get_session(token: Optional[str], *, touch: bool = True) -> Optional[Dict[str, str]]:
    """Возвращает данные сессии по токену и продлевает её."""
    if not token:
        return None
    client = _client()
    if client is None:
        return None
    try:
        record = client.hgetall(_SESSION_KEY + token)
        if not record:
            return None
        if touch:
            # Скользящий TTL: активные устройства не разлогинивает, забытые —
            # отваливаются сами.
            pipe = client.pipeline()
            pipe.hset(_SESSION_KEY + token, "lastSeenAt", str(_now()))
            pipe.expire(_SESSION_KEY + token, SESSION_TTL_SECONDS)
            pipe.execute()
        return record
    except Exception as exc:
        _mark_down(exc)
        return None


def revoke_session(token: str) -> bool:
    client = _client()
    if client is None or not token:
        return False
    try:
        record = client.hgetall(_SESSION_KEY + token)
        pipe = client.pipeline()
        pipe.delete(_SESSION_KEY + token)
        if record.get("userId"):
            pipe.srem(_USER_SESSIONS_KEY + record["userId"], token)
        pipe.execute()
        return bool(record)
    except Exception as exc:
        _mark_down(exc)
        return False


def list_sessions(user_id: str, *, current_token: str = "") -> List[Dict[str, Any]]:
    """Устройства пользователя. Токен наружу не отдаём — только его короткий
    идентификатор, чтобы UI мог попросить завершить конкретную сессию."""
    client = _client()
    if client is None:
        return []
    try:
        tokens = client.smembers(_USER_SESSIONS_KEY + str(user_id)) or set()
        result: List[Dict[str, Any]] = []
        stale: List[str] = []
        for token in tokens:
            record = client.hgetall(_SESSION_KEY + token)
            if not record:
                stale.append(token)   # истёк по TTL, но остался в наборе
                continue
            result.append({
                "id": token[:16],
                "userAgent": record.get("userAgent", ""),
                "device": record.get("device", ""),
                "ip": record.get("ip", ""),
                "createdAt": int(record.get("createdAt") or 0),
                "lastSeenAt": int(record.get("lastSeenAt") or 0),
                "current": bool(current_token) and token == current_token,
            })
        if stale:
            client.srem(_USER_SESSIONS_KEY + str(user_id), *stale)
        result.sort(key=lambda s: s["lastSeenAt"], reverse=True)
        return result
    except Exception as exc:
        _mark_down(exc)
        return []


MAX_SESSIONS_PER_USER = int(os.getenv("SHAR_MAX_SESSIONS", "10"))


def prune_user_sessions(user_id: str, keep: int = MAX_SESSIONS_PER_USER) -> int:
    """Оставляет `keep` самых свежих (по lastSeenAt) сессий пользователя, остальные закрывает.
    Без потолка список устройств рос бесконечно: каждый вход добавлял сессию на 90 дней."""
    client = _client()
    if client is None:
        return 0
    try:
        rows = []
        for token in list(client.smembers(_USER_SESSIONS_KEY + str(user_id)) or set()):
            record = client.hgetall(_SESSION_KEY + token)
            if not record:
                client.srem(_USER_SESSIONS_KEY + str(user_id), token)
                continue
            rows.append((int(record.get("lastSeenAt") or 0), token))
        rows.sort(reverse=True)
        return sum(1 for _, token in rows[max(keep, 1):] if revoke_session(token))
    except Exception as exc:
        _mark_down(exc)
        return 0


def revoke_by_short_id(user_id: str, short_id: str) -> bool:
    """UI знает только первые 16 символов токена — находим полный по набору."""
    client = _client()
    if client is None:
        return False
    try:
        for token in client.smembers(_USER_SESSIONS_KEY + str(user_id)) or set():
            if token[:16] == short_id:
                return revoke_session(token)
    except Exception as exc:
        _mark_down(exc)
        pass
    return False


def revoke_all_except(user_id: str, keep_token: str = "") -> int:
    client = _client()
    if client is None:
        return 0
    count = 0
    try:
        for token in list(client.smembers(_USER_SESSIONS_KEY + str(user_id)) or set()):
            if token == keep_token:
                continue
            if revoke_session(token):
                count += 1
    except Exception as exc:
        _mark_down(exc)
        pass
    return count


def describe_device(user_agent: str) -> str:
    """Короткая подпись устройства для списка — «Chrome, Windows» и т.п."""
    ua = (user_agent or "").lower()
    if "shar" in ua and "electron" in ua:
        platform = "Windows" if "windows" in ua else "macOS" if "mac os" in ua else "Linux"
        return f"Приложение Shar, {platform}"

    if "iphone" in ua:
        platform = "iPhone"
    elif "ipad" in ua:
        platform = "iPad"
    elif "android" in ua:
        platform = "Android"
    elif "windows" in ua:
        platform = "Windows"
    elif "mac os" in ua:
        platform = "macOS"
    elif "linux" in ua:
        platform = "Linux"
    else:
        platform = "Неизвестная система"

    # Порядок важен: Edge и Opera подставляют "chrome" в свой User-Agent,
    # а Chrome — "safari". Проверяем от частного к общему.
    if "edg/" in ua:
        browser = "Edge"
    elif "opr/" in ua or "opera" in ua:
        browser = "Opera"
    elif "yabrowser" in ua:
        browser = "Яндекс.Браузер"
    elif "firefox" in ua:
        browser = "Firefox"
    elif "chrome" in ua:
        browser = "Chrome"
    elif "safari" in ua:
        browser = "Safari"
    else:
        browser = "Неизвестный браузер"

    return f"{browser}, {platform}"
