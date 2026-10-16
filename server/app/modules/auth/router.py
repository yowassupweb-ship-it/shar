"""Вход, выход, сессия, устройства.

Сессия — HttpOnly-кука с токеном; сам токен живёт в Redis (app/core/sessions.py).
Обмена «логин из localStorage → сессия» (adopt) здесь нет и не будет: он выдавал
сессию любому, кто знает имя пользователя.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from app.core import sessions as auth_sessions
from app.core.db import db
from app.core.passwords import hash_password, needs_rehash, verify_password
from app.core.ratelimit import limiter
from app.core.security import Identity, current_identity, session_cookie_value

router = APIRouter()
logger = logging.getLogger(__name__)

# Перебор паролей: попыток с одного адреса и на один логин за окно.
LOGIN_LIMIT_PER_IP = (30, 300)       # 30 попыток за 5 минут
LOGIN_LIMIT_PER_USER = (8, 300)      # 8 попыток за 5 минут на один логин


class LoginRequest(BaseModel):
    username: str
    password: str


def _client_ip(request: Request) -> str:
    # За nginx настоящий адрес — первый в X-Forwarded-For; напрямую — адрес сокета.
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded:
        return forwarded
    return request.client.host if request.client else ""


def _issue_session(response: Response, request: Request, user: dict) -> Optional[str]:
    """Создаёт сессию и кладёт токен в HttpOnly-куку."""
    user_agent = request.headers.get("user-agent", "")
    # Повторный вход с устройства, где сессия уже есть, заменяет её, а не добавляет рядом:
    # иначе каждый вход (и каждый запуск клиента без куки) оставлял «призрак» на 90 дней.
    previous = request.cookies.get(auth_sessions.SESSION_COOKIE) or ""
    old = auth_sessions.get_session(previous, touch=False) if previous else None
    if old and str(old.get("userId")) == str(user.get("id")):
        auth_sessions.revoke_session(previous)
    token = auth_sessions.create_session(
        str(user.get("id")),
        str(user.get("username") or ""),
        user_agent=user_agent,
        ip=_client_ip(request),
        device=auth_sessions.describe_device(user_agent),
    )
    if not token:
        return None
    auth_sessions.prune_user_sessions(str(user.get("id")))
    response.set_cookie(
        auth_sessions.SESSION_COOKIE, token,
        max_age=auth_sessions.SESSION_TTL_SECONDS,
        httponly=True,          # JS до токена не дотянется — в отличие от localStorage
        samesite="lax",
        secure=request.app.state.settings.cookie_secure,
        path="/",
    )
    return token


def _public_user(user: dict) -> dict:
    return {
        "id": user.get("id"),
        "username": user.get("username", ""),
        "name": user.get("name", ""),
        "role": user.get("role", "user"),
    }


# Хеш «никого»: на неизвестном логине тратим столько же времени, сколько на известном,
# иначе по скорости ответа можно перебирать существующие логины.
_DUMMY_HASH = hash_password("dummy-password-for-timing")


@router.post("/api/auth/login")
def login(credentials: LoginRequest, request: Request, response: Response):
    ip = _client_ip(request)
    login_name = credentials.username.strip()
    if not limiter.allow(f"login:ip:{ip}", *LOGIN_LIMIT_PER_IP) or not limiter.allow(f"login:user:{login_name.lower()}", *LOGIN_LIMIT_PER_USER):
        raise HTTPException(status_code=429, detail="Слишком много попыток входа, попробуйте позже")

    user = db.get_user_by_login(login_name)
    stored = user.get("password") if user else _DUMMY_HASH
    ok = verify_password(credentials.password, stored) and user is not None
    if not ok:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if user.get("isDisabled") or user.get("is_disabled"):
        # Тот же ответ, что на неверный пароль: не подтверждаем, что учётка существует.
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Прозрачная миграция пароля: открытый текст у нас на руках ровно сейчас —
    # единственный момент, когда его можно заменить хешем.
    if needs_rehash(user.get("password")):
        try:
            db.update_user(str(user.get("id")), {"password": hash_password(credentials.password)})
        except Exception:
            logger.warning("[auth] password rehash failed for user %s", user.get("id"))

    if not _issue_session(response, request, user):
        # Без сессии вход бессмыслен (кука не выдана) — честная ошибка вместо «успеха».
        raise HTTPException(status_code=503, detail="Сервис сессий недоступен")
    limiter.reset(f"login:user:{login_name.lower()}")
    return {"status": "success", "user": _public_user(user)}


@router.get("/api/auth/session")
def get_session(request: Request):
    """Кто вошёл на этом устройстве. Источник правды — кука, а не localStorage."""
    token = session_cookie_value(request.headers.get("cookie", ""))
    record = auth_sessions.get_session(token)
    if not record:
        return {"authenticated": False}
    user = db.get_user_by_id(record["userId"])
    if not user or user.get("isDisabled") or user.get("is_disabled"):
        auth_sessions.revoke_session(token)  # удалён или отключён — сессия тоже
        return {"authenticated": False}
    return {"authenticated": True, "user": _public_user(user)}


@router.post("/api/auth/logout")
def logout(request: Request, response: Response):
    token = session_cookie_value(request.headers.get("cookie", ""))
    if token:
        auth_sessions.revoke_session(token)
    response.delete_cookie(auth_sessions.SESSION_COOKIE, path="/")
    return {"status": "success"}


@router.get("/api/auth/devices")
def list_devices(request: Request, me: Identity = Depends(current_identity)):
    """Список устройств текущего пользователя для раздела «Устройства»."""
    token = session_cookie_value(request.headers.get("cookie", ""))
    return {"devices": auth_sessions.list_sessions(me.user_id, current_token=token)}


@router.delete("/api/auth/devices/{device_id}")
def revoke_device(device_id: str, request: Request, me: Identity = Depends(current_identity)):
    # Завершать можно только свои сессии: device_id ищется в наборе этого
    # пользователя, чужой идентификатор просто не найдётся.
    if not auth_sessions.revoke_by_short_id(me.user_id, device_id):
        raise HTTPException(status_code=404, detail="Device not found")
    request.app.state.verifier.forget_user(me.user_id)  # отзыв должен подействовать сразу, а не через TTL кэша
    return {"status": "success"}


@router.post("/api/auth/devices/revoke-others")
def revoke_other_devices(request: Request, me: Identity = Depends(current_identity)):
    token = session_cookie_value(request.headers.get("cookie", ""))
    revoked = auth_sessions.revoke_all_except(me.user_id, keep_token=token)
    request.app.state.verifier.forget_user(me.user_id)
    return {"status": "success", "revoked": revoked}


@router.get("/api/auth/me")
def get_current_user(me: Identity = Depends(current_identity)):
    """Информация о ТЕКУЩЕМ пользователе — только из сессии, чужого запросить нельзя."""
    user = db.get_user_by_id(me.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "name": user.get("name", ""),
        "role": user.get("role", "user"),
        "telegramId": user.get("telegramId"),
        "todoPersonId": user.get("todoPersonId"),
        "canSeeAllTasks": user.get("canSeeAllTasks", False),
    }
