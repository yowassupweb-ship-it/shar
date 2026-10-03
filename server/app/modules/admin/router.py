"""Админка: обзор, пользователи, сервер, настройки, журнал.

Каждый маршрут — только для роли admin (проверяется по сессии и базе, не по тому, что
прислал клиент). Опасные действия пишутся в журнал admin_audit."""

from __future__ import annotations

import secrets
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from app.core import sessions
from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.security import Identity, require_admin
from app.core.telegram import telegram
from app.modules.admin import audit, system
from app.modules.admin import settings as admin_settings
from app.modules.calls.presence import _ws_online_ids
from app.modules.ops import client_errors
from app.modules.users.router import public_user

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def _count(sql: str, params: tuple = ()) -> int:
    row = db.conn.fetch_one(sql, params)
    return int(next(iter(row.values()))) if row else 0


@router.get("/overview")
def overview() -> Dict[str, Any]:
    users = db.get_users(include_disabled=True)
    online = _ws_online_ids([u.get("id") for u in users])
    disabled = [u for u in users if u.get("is_disabled")]
    return {
        "users": {
            "total": len(users),
            "active": len(users) - len(disabled),
            "disabled": len(disabled),
            "admins": sum(1 for u in users if u.get("role") == "admin" and not u.get("is_disabled")),
            "online": len([u for u in users if str(u.get("id")) in online and not u.get("is_disabled")]),
            "withoutPassword": sum(1 for u in users if not u.get("password")),
            "legacyPasswords": sum(1 for u in users if u.get("password") and not str(u["password"]).startswith("pbkdf2_sha256$")),
        },
        "chats": {
            "total": _count("SELECT COUNT(*) FROM chats"),
            "messagesDay": _count("SELECT COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '1 day'"),
            "messagesWeek": _count("SELECT COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '7 days'"),
        },
        "tasks": {
            "open": _count("SELECT COUNT(*) FROM tasks WHERE COALESCE(is_completed, false) = false"),
            "total": _count("SELECT COUNT(*) FROM tasks"),
        },
        "departments": _count("SELECT COUNT(*) FROM departments"),
        "mailAccounts": _count("SELECT COUNT(*) FROM email_accounts"),
        "pushDevices": _count("SELECT COUNT(*) FROM push_subscriptions"),
    }


# ── пользователи ───────────────────────────────────────────────────────────

@router.get("/users/{user_id}/sessions")
def user_sessions(user_id: str):
    if not db.get_user_by_id(user_id):
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    return {"devices": sessions.list_sessions(user_id)}


@router.delete("/users/{user_id}/sessions")
def revoke_user_sessions(user_id: str, request: Request, me: Identity = Depends(require_admin)):
    """Выйти со всех устройств пользователя."""
    if not db.get_user_by_id(user_id):
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    revoked = sessions.revoke_all_except(user_id)
    request.app.state.verifier.forget_user(user_id)
    audit.record(me, "user.sessions_revoked", user_id, revoked=revoked)
    return {"revoked": revoked}


@router.post("/users/{user_id}/reset-password")
def reset_password(user_id: str, request: Request, me: Identity = Depends(require_admin)):
    """Новый временный пароль. Показывается один раз — в базе остаётся только хеш (старые
    пароли «посмотреть» больше нельзя: открытых паролей мы не храним)."""
    user = db.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    temporary = secrets.token_urlsafe(9)
    db.update_user(user_id, {"password": temporary})
    sessions.revoke_all_except(user_id)
    request.app.state.verifier.forget_user(user_id)
    audit.record(me, "user.password_reset", user_id)
    return {"password": temporary, "user": snake_to_camel(public_user(db.get_user_by_id(user_id)))}


# ── сервер ─────────────────────────────────────────────────────────────────

@router.get("/system")
async def system_status():
    return await run_in_threadpool(system.status)


@router.post("/system/{action}")
async def system_action(action: str, me: Identity = Depends(require_admin)):
    try:
        result = await run_in_threadpool(system.run_action, action)
    except KeyError:
        raise HTTPException(status_code=404, detail="Действие не настроено (SHAR_ADMIN_ACTIONS)")
    except Exception as exc:
        raise HTTPException(status_code=504 if "Timeout" in type(exc).__name__ else 500, detail=type(exc).__name__)
    audit.record(me, "system.action", action, exitCode=result["exitCode"])
    return result


# ── настройки ──────────────────────────────────────────────────────────────

@router.get("/settings")
def get_settings():
    return admin_settings.read()


@router.put("/settings")
def put_settings(patch: Dict[str, Any], me: Identity = Depends(require_admin)):
    result = admin_settings.write(patch)
    audit.record(me, "settings.updated", None, keys=sorted(k for k in patch if k in {*admin_settings.SECRET_FIELDS, *admin_settings.TEXT_FIELDS, *admin_settings.BOOL_FIELDS}))
    return result


@router.post("/settings/test-telegram")
async def test_telegram():
    ok = await run_in_threadpool(telegram.send_notification, "🧪 <b>Проверка Шара</b>\n\nУведомления в Telegram работают.")
    return {"ok": bool(ok)}


# ── журналы ────────────────────────────────────────────────────────────────

@router.get("/audit")
def audit_log(limit: int = 100):
    return {"entries": audit.recent(limit)}


@router.get("/errors")
def errors(limit: int = 200):
    return client_errors.get_client_errors(limit, None)


@router.delete("/errors")
def clear_errors(me: Identity = Depends(require_admin)):
    client_errors.clear_errors()
    audit.record(me, "errors.cleared")
    return JSONResponse({"ok": True})
