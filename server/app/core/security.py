"""Личность запроса и обязательная авторизация для /api.

Правила (те же, что были в frontend/src/middleware.ts, но теперь без Next):

  * публичные префиксы пропускаются без сессии — список короткий и закрытый;
  * server-to-server маршруты пускают по внутреннему ключу, а не по сессии;
  * без куки shar_session — 401, с кукой, которой нет в Redis, — тоже 401;
  * отключённый или удалённый пользователь сессии не имеет;
  * userId/user_id в запросе должен совпадать с сессией (кроме админа) — 403.

Новый маршрут закрыт по умолчанию: чтобы открыть, его надо внести в
PUBLIC_PREFIXES осознанно.
"""

from __future__ import annotations

import hmac
import logging
import time
from dataclasses import dataclass
from http.cookies import SimpleCookie

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool

from app.core import sessions
from app.core.db import db

log = logging.getLogger("shar.security")

SESSION_COOKIE = sessions.SESSION_COOKIE

# Доступно без сессии — поштучно. Весь /api/auth/ открывать нельзя: под ним
# лежит /api/auth/me и устройства.
PUBLIC_PREFIXES: tuple[str, ...] = (
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/session",
    "/api/auth/telegram/",
    "/api/integrations/",   # внешние системы: свой ключ X-Shar-Api-Key
    "/api/telegram/",       # вебхук Telegram: свой секрет
    "/api/social/hook/",    # события ботов Telegram и MAX («Соцсети»): секрет подключения в адресе
    "/api/v2/health",
    "/api/uploads/",        # вложения и аватарки — по прямой ссылке (имена непредсказуемы)
    "/api/thumbs/",         # уменьшенные копии тех же вложений
    "/api/avatars/",
    "/api/stickers/file/",
    "/api/share/",         # материалы по ссылке: доступ даёт токен в адресе
)

# Публичны только для перечисленных методов: ошибки с экрана входа должны доходить,
# а читать их может только админ.
PUBLIC_METHODS: dict[str, tuple[str, ...]] = {
    "/api/client-errors": ("POST",),
}

# Ходит сам бэкенд / внешние системы; сессии у них нет по определению.
INTERNAL_ONLY_PREFIXES: tuple[str, ...] = ("/api/push/notify",)


@dataclass(frozen=True)
class Identity:
    user_id: str
    role: str
    username: str = ""
    name: str = ""

    @property
    def display_name(self) -> str:
        return self.name or self.username or "Unknown"

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


@dataclass(frozen=True)
class Decision:
    allowed: bool
    identity: Identity | None = None
    status: int = 200
    error: str = ""


def is_public(method: str, path: str) -> bool:
    if any(path.startswith(p) for p in PUBLIC_PREFIXES):
        return True
    methods = PUBLIC_METHODS.get(path.rstrip("/"))
    return bool(methods) and method.upper() in methods


def session_cookie_value(cookie_header: str) -> str:
    if not cookie_header:
        return ""
    jar = SimpleCookie()
    try:
        jar.load(cookie_header)
    except Exception:  # битая кука — как отсутствующая
        return ""
    morsel = jar.get(SESSION_COOKIE)
    return morsel.value if morsel else ""


def keys_equal(supplied: str, expected: str) -> bool:
    """Сравнение секретов за постоянное время; пустой ожидаемый ключ не совпадает ни с чем."""
    if not expected or not supplied:
        return False
    return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))


def _load_identity(token: str) -> Identity | None:
    """Синхронно (Redis + база): вызывать только из пула потоков."""
    record = sessions.get_session(token)
    if not record or not record.get("userId"):
        return None
    user_id = str(record["userId"])
    user = db.get_user_by_id(user_id)
    if not user:
        sessions.revoke_session(token)  # пользователя удалили — сессия тоже
        return None
    if user.get("isDisabled") or user.get("is_disabled"):
        sessions.revoke_session(token)
        return None
    return Identity(user_id, str(user.get("role") or "user"), str(user.get("username") or ""), str(user.get("name") or ""))


_user_identity_cache: dict[str, tuple[float, Identity | None]] = {}


def identity_of(user_id: str) -> Identity | None:
    """Identity по id пользователя — для кода, где личность уже проверена иначе (сокет:
    сессию сверили при подключении). Синхронно, с кэшем на минуту."""
    now = time.monotonic()
    hit = _user_identity_cache.get(user_id)
    if hit and hit[0] > now:
        return hit[1]
    user = db.get_user_by_id(user_id)
    ident = None
    if user and not (user.get("isDisabled") or user.get("is_disabled")):
        ident = Identity(str(user["id"]), str(user.get("role") or "user"), str(user.get("username") or ""), str(user.get("name") or ""))
    if len(_user_identity_cache) > 5000:
        _user_identity_cache.clear()
    _user_identity_cache[user_id] = (now + 60.0, ident)
    return ident


class SessionVerifier:
    """Сессия → Identity, с коротким кэшем по значению куки.

    Кэш снимает два обращения (Redis и база) с каждого запроса. Цена — до TTL
    секунд задержки при отзыве сессии: выход и «завершить устройство» сбрасывают
    кэш сразу (forget), остальное — по сроку."""

    def __init__(self, ttl: float) -> None:
        self._ttl = ttl
        self._cache: dict[str, tuple[float, Identity | None]] = {}

    def forget(self, token: str) -> None:
        self._cache.pop(token, None)

    def forget_user(self, user_id: str) -> None:
        for token in [t for t, (_, i) in self._cache.items() if i and i.user_id == user_id]:
            self._cache.pop(token, None)

    async def identity_for_token(self, token: str) -> Identity | None:
        if not token:
            return None
        now = time.monotonic()
        hit = self._cache.get(token)
        if hit and hit[0] > now:
            return hit[1]
        ident = await run_in_threadpool(_load_identity, token)
        if len(self._cache) > 5000:  # не даём кэшу расти бесконечно
            self._cache.clear()
        self._cache[token] = (now + self._ttl, ident)
        return ident

    async def identity(self, cookie_header: str) -> Identity | None:
        return await self.identity_for_token(session_cookie_value(cookie_header))


class AuthGate:
    def __init__(self, verifier: SessionVerifier, *, enforce: bool, internal_key: str) -> None:
        self.verifier = verifier
        self.enforce = enforce
        self.internal_key = internal_key

    def _internal_ok(self, headers: dict[str, str]) -> bool:
        # Ключ не задан — не пускаем никого: отсутствие настройки ≠ открытая дверь.
        return keys_equal(headers.get("x-shar-internal-key", "").strip(), self.internal_key)

    async def check(self, method: str, path: str, query: dict[str, str], headers: dict[str, str]) -> Decision:
        if not path.startswith("/api/") or method == "OPTIONS":
            return Decision(True)
        cookie = headers.get("cookie", "")
        if is_public(method, path) or not self.enforce:
            # Публичный маршрут: личность всё равно полезна своим модулям, если кука есть.
            return Decision(True, await self.verifier.identity(cookie))
        if any(path.startswith(p) for p in INTERNAL_ONLY_PREFIXES) and self._internal_ok(headers):
            return Decision(True)

        if not session_cookie_value(cookie):
            return Decision(False, status=401, error="Требуется авторизация")
        ident = await self.verifier.identity(cookie)
        if ident is None:
            return Decision(False, status=401, error="Требуется авторизация")

        # Личность — из сессии, а не из параметра запроса.
        claimed = (query.get("userId") or query.get("user_id") or "").strip()
        if claimed and claimed != ident.user_id and not ident.is_admin:
            log.warning("user %s asked for data of %s at %s", ident.user_id, claimed, path)
            return Decision(False, status=403, error="Нет доступа к данным другого пользователя")
        return Decision(True, ident)


# ── зависимости для роутеров ────────────────────────────────────────────────

def current_identity(request: Request) -> Identity:
    """Вошедший пользователь (auth-middleware уже проверил сессию). Без сессии — 401."""
    ident = getattr(request.state, "identity", None)
    if ident is None:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    return ident


def optional_identity(request: Request) -> Identity | None:
    return getattr(request.state, "identity", None)


def require_admin(request: Request) -> Identity:
    ident = current_identity(request)
    if not ident.is_admin:
        raise HTTPException(status_code=403, detail="Только для администратора")
    return ident


def ensure_self_or_admin(ident: Identity, user_id: str) -> None:
    """Действовать от имени другого пользователя может только админ."""
    if str(user_id) != ident.user_id and not ident.is_admin:
        raise HTTPException(status_code=403, detail="Нет доступа к данным другого пользователя")
