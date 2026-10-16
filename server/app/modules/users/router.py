"""Пользователи: справочник, профиль, администрирование.

Правила доступа (раньше любой вошедший мог читать пароли, менять чужие профили
и выдавать себе роль админа):

  * читать список и профили — любой вошедший, но без секретов (пароль не отдаётся
    никому, включая админа: в базе он хеш, а открытые пароли доживают до входа);
  * создавать, удалять, отключать, менять роль/инструменты/отделы/логин — только админ;
  * свой профиль — только безопасные поля (SELF_FIELDS) и пароль;
  * админ не может удалить, отключить или разжаловать самого себя (не запереться).
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core import sessions
from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.security import (
    Identity,
    current_identity,
    ensure_self_or_admin,
    require_admin,
    session_cookie_value,
)
from app.modules.calls.presence import _ws_online_ids
from app.modules.calls.rooms import _force_leave_all_calls

router = APIRouter()
logger = logging.getLogger(__name__)

# Секреты, которые не покидают сервер ни в каком ответе.
SECRET_FIELDS = ("password", "passwordHash", "password_hash")

# Что человек может менять в собственном профиле.
SELF_FIELDS = frozenset({
    "phone", "personalPhone", "workSchedule", "position", "department",
    "pinnedTools", "visibleTabs", "toolsOrder", "chatSettings", "telegramUsername",
})
MIN_PASSWORD_LEN = 6


def public_user(user: Any) -> Any:
    """Пользователь без секретов — единственный способ отдать его наружу."""
    if isinstance(user, dict):
        return {k: v for k, v in user.items() if k not in SECRET_FIELDS}
    return user


@router.post("/api/users/{user_id}/status")
@router.post("/api/users/{user_id}/heartbeat")
def legacy_presence_noop(user_id: str, me: Identity = Depends(current_identity)):
    """Совместимость: старые клиенты (Electron ≤0.2.80, закэшированные вкладки) шлют присутствие
    сюда. В v2 «в сети» считается по открытому сокету, поэтому запрос ничего не пишет."""
    return {"success": True}


class UserCreate(BaseModel):
    username: Optional[str] = None  # Логин пользователя
    name: str
    email: str
    password: str = Field(min_length=MIN_PASSWORD_LEN)
    role: str = "user"
    todoRole: str = "executor"  # executor, customer, universal
    position: Optional[str] = None  # Должность
    department: Optional[str] = None  # Отдел (основной, для обратной совместимости)
    departmentIds: Optional[List[str]] = None  # Все отделы/подразделы пользователя
    phone: Optional[str] = None  # Телефон
    workSchedule: Optional[str] = None  # График работы
    telegramId: Optional[str] = None  # Telegram ID
    telegramUsername: Optional[str] = None  # Telegram username
    isDepartmentHead: Optional[bool] = None  # Руководитель отдела
    canSeeAllTasks: Optional[bool] = None  # Может видеть все задачи
    enabledTools: List[str] = []


class UserUpdate(BaseModel):
    username: Optional[str] = None  # Логин пользователя
    name: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = Field(default=None, min_length=MIN_PASSWORD_LEN)
    role: Optional[str] = None
    todoRole: Optional[str] = None
    position: Optional[str] = None  # Должность
    department: Optional[str] = None  # Отдел (основной, для обратной совместимости)
    departmentIds: Optional[List[str]] = None  # Все отделы/подразделы пользователя
    phone: Optional[str] = None  # Телефон
    personalPhone: Optional[str] = None
    workSchedule: Optional[str] = None  # График работы
    telegramId: Optional[str] = None  # Telegram ID
    telegramUsername: Optional[str] = None  # Telegram username
    enabledTools: Optional[List[str]] = None
    avatar: Optional[str] = None  # URL аватара пользователя
    canSeeAllTasks: Optional[bool] = None  # Может видеть все задачи
    isActive: Optional[bool] = None  # Активен ли пользователь
    isDisabled: Optional[bool] = None  # Отключён (скрыт везде, но не удалён)
    isDepartmentHead: Optional[bool] = None  # Руководитель отдела
    pinnedTools: Optional[List[str]] = None  # Закрепленные инструменты
    visibleTabs: Optional[Dict[str, bool]] = None  # Видимые вкладки навигации
    toolsOrder: Optional[List[str]] = None  # Порядок инструментов
    chatSettings: Optional[Dict[str, Any]] = None  # Настройки чата (цвета/фон/шрифты)


def _normalize_dt(value: Any):
    if not value:
        return None
    dt = None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except Exception:
            return None
    if not dt:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _with_presence(users: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Добавляет isOnline и lastSeen — единственным способом для всех маршрутов.

    «В сети» = у человека есть живое соединение (аренда в Redis, см. calls/presence.py);
    никаких догадок по давности last_seen или по времени последнего сообщения: раньше
    список, профиль и статусы считали по-разному и показывали разное. last_seen пишется
    при подключении и после отключения (с паузой на переподключение)."""
    online = _ws_online_ids([u.get("id") for u in users])
    for user in users:
        user["is_online"] = str(user.get("id")) in online
        seen = _normalize_dt(user.get("last_seen") or user.get("lastSeen"))
        user["last_seen"] = seen.isoformat() if seen else None
    return users


@router.get("/api/users")
def get_users(include_disabled: bool = False, me: Identity = Depends(current_identity)):
    """Список пользователей с динамическим isOnline. Отключённых видит только админ."""
    users = db.get_users(include_disabled=bool(include_disabled and me.is_admin))
    return [snake_to_camel(public_user(u)) for u in _with_presence(users)]


@router.get("/api/users/statuses")
def get_user_statuses(me: Identity = Depends(current_identity)):
    """Статусы всех пользователей."""
    users = _with_presence(db.get_users())
    return [{"id": u["id"], "isOnline": u["is_online"], "lastSeen": u.get("last_seen")} for u in users]


@router.get("/api/users/{user_id}")
def get_user(user_id: str, me: Identity = Depends(current_identity)):
    """Пользователь по ID (или по telegramId) с динамическим isOnline."""
    user = db.get_user_by_id(user_id)
    if not user:
        user = next((u for u in db.get_users() if str(u.get("telegramId") or u.get("telegram_id") or "") == user_id), None)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return snake_to_camel(public_user(_with_presence([user])[0]))


@router.post("/api/users")
def create_user(user: UserCreate, me: Identity = Depends(require_admin)):
    """Создать пользователя (админ)."""
    user_data = user.model_dump()
    if db.get_user_by_login(user_data.get("username") or user_data["email"]) or db.get_user_by_login(user_data["email"]):
        raise HTTPException(status_code=409, detail="Пользователь с таким логином или почтой уже есть")
    # id по Telegram ID — как раньше, чтобы совпадали с ботом; иначе уникальный.
    user_data["id"] = str(user_data["telegramId"]) if user_data.get("telegramId") else f"user_{uuid.uuid4().hex[:16]}"
    if db.get_user_by_id(user_data["id"]):
        raise HTTPException(status_code=409, detail="Пользователь с таким id уже есть")
    user_data["createdAt"] = datetime.now().isoformat()
    result = db.add_user(user_data)
    if not result:
        raise HTTPException(status_code=409, detail="Пользователь с такой почтой уже есть")
    return snake_to_camel(public_user(result))


def _drop_sessions(request: Request, user_id: str, keep: str = "") -> int:
    """Закрыть сессии пользователя и сразу забыть их в кэше проверки (иначе они жили бы ещё до TTL)."""
    revoked = sessions.revoke_all_except(user_id, keep_token=keep)
    request.app.state.verifier.forget_user(user_id)
    return revoked


@router.put("/api/users/{user_id}")
def update_user(user_id: str, user: UserUpdate, request: Request, me: Identity = Depends(current_identity)):
    """Обновить пользователя: себя — в пределах SELF_FIELDS и пароль, остальное — только админ."""
    ensure_self_or_admin(me, user_id)
    user_data = user.model_dump(exclude_unset=True)
    if not me.is_admin:
        forbidden = sorted(set(user_data) - SELF_FIELDS - {"password"})
        if forbidden:
            raise HTTPException(status_code=403, detail=f"Эти поля меняет только администратор: {', '.join(forbidden)}")
    if str(user_id) == me.user_id:
        # Админ не должен запереть систему без админов.
        if user_data.get("isDisabled") or (user_data.get("role") and user_data["role"] != me.role):
            raise HTTPException(status_code=400, detail="Нельзя отключить или разжаловать самого себя")
    for field, value in (("username", user_data.get("username")), ("email", user_data.get("email"))):
        if value:
            other = db.get_user_by_login(value)
            if other and str(other.get("id")) != str(user_id):
                raise HTTPException(status_code=409, detail="Логин или почта уже заняты")
    result = db.update_user(user_id, user_data)
    if not result:
        raise HTTPException(status_code=404, detail="User not found")
    if user_data.get("password"):
        # Новый пароль — старые входы больше не действуют (кроме текущего устройства).
        keep = session_cookie_value(request.headers.get("cookie", "")) if str(user_id) == me.user_id else ""
        _drop_sessions(request, str(user_id), keep)
    if user_data.get("isDisabled"):
        _drop_sessions(request, str(user_id))  # сессии отключённого больше не живут
        try:
            _force_leave_all_calls(str(user_id), (result or {}).get("name"))
        except Exception as e:
            logger.warning("[calls] force-leave on disable failed: %s", e)
    return snake_to_camel(public_user(result))


@router.delete("/api/users/{user_id}")
def delete_user(user_id: str, request: Request, me: Identity = Depends(require_admin)):
    """Удалить пользователя (админ, но не себя)."""
    if str(user_id) == me.user_id:
        raise HTTPException(status_code=400, detail="Нельзя удалить самого себя")
    if not db.delete_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    _drop_sessions(request, str(user_id))
    try:
        _force_leave_all_calls(str(user_id), None)  # удалённого — из конференций сразу
    except Exception as e:
        logger.warning("[calls] force-leave on delete failed: %s", e)
    return {"status": "deleted"}


@router.put("/api/users/{user_id}/navigation")
def update_user_navigation(user_id: str, navigation: Dict[str, Any], me: Identity = Depends(current_identity)):
    """Видимые вкладки и порядок инструментов — свои (админ — любые)."""
    ensure_self_or_admin(me, user_id)
    update_data = {k: navigation[k] for k in ("visibleTabs", "toolsOrder") if k in navigation}
    if not update_data:
        raise HTTPException(status_code=400, detail="No navigation data provided")
    result = db.update_user(user_id, update_data)
    if not result:
        raise HTTPException(status_code=404, detail="User not found")
    return public_user(result)
