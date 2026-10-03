from __future__ import annotations

import logging
from datetime import datetime
from typing import Dict, List

from fastapi import APIRouter, Body, HTTPException, Request

from app.config import settings
from app.core.db import db
from app.core.ratelimit import limiter
from app.core.security import keys_equal
from app.modules.chats.chat_notifications import send_notification_message

router = APIRouter()

logger = logging.getLogger(__name__)


# ─── Интеграционный API для внешних систем (менеджерская программа) ──────────
# Отдельный контур авторизации: у внешней программы нет пользователя Shar, она
# ходит с сервисным ключом (заголовок X-Shar-Api-Key, значение — SHAR_INTEGRATION_API_KEY).
# Ключ сравнивается за постоянное время; перебор режется по адресу.
# Формат запросов и ответов — docs/INTEGRATION_API.md; он НЕ менялся при переносе из
# старого бэкенда: внешняя система продолжает работать без доработок.
def _require_integration_key(request: Request) -> None:
    ip = request.client.host if request.client else "?"
    if not limiter.allow(f"integration:{ip}", 600, 60):
        raise HTTPException(status_code=429, detail="Too many requests")
    if not settings.integration_api_key:
        raise HTTPException(status_code=503, detail="SHAR_INTEGRATION_API_KEY не задан на сервере")
    supplied = (request.headers.get("x-shar-api-key") or "").strip()
    if not keys_equal(supplied, settings.integration_api_key):
        raise HTTPException(status_code=401, detail="Invalid API key")


def _safe_action_url(url: str) -> str:
    """Кнопка уведомления ведёт по этому адресу: javascript:/data: в ней — XSS в клиенте."""
    if url and not (url.startswith(("http://", "https://", "/")) and not url.startswith("//")):
        raise HTTPException(status_code=400, detail="actionUrl must be http(s) or a relative path")
    return url


def _integration_user_view(user: dict) -> dict:
    """Публичная карточка сотрудника — без пароля и служебных полей."""
    return {
        "id": str(user.get("id")),
        "username": user.get("username") or "",
        "name": user.get("name") or "",
        "email": user.get("email") or "",
        "position": user.get("position") or "",
        "departmentId": user.get("department") or "",
        "departmentIds": user.get("departmentIds") or user.get("department_ids") or [],
        "isDisabled": bool(user.get("isDisabled") or user.get("is_disabled")),
    }


def _resolve_recipients(user_refs: List[str], department_ids: List[str]) -> tuple:
    """Разворачивает список получателей.

    userIds принимает id, username или email — внешней системе не обязательно
    знать внутренние идентификаторы Shar. departmentIds разворачивается в
    сотрудников отдела ВМЕСТЕ с его подразделами. Возвращает (получатели,
    ненайденные ссылки)."""
    users = db.get_users() or []
    by_id = {str(u.get("id")): u for u in users if u.get("id")}
    by_username = {str(u.get("username")).lower(): u for u in users if u.get("username")}
    by_email = {str(u.get("email")).lower(): u for u in users if u.get("email")}

    resolved: Dict[str, dict] = {}
    unknown: List[str] = []

    for ref in user_refs:
        key = str(ref).strip()
        if not key:
            continue
        user = by_id.get(key) or by_username.get(key.lower()) or by_email.get(key.lower())
        if user:
            resolved[str(user["id"])] = user
        else:
            unknown.append(key)

    if department_ids:
        try:
            departments = db.get_departments() or []
        except Exception:
            departments = []
        wanted = set(str(d) for d in department_ids)
        # Подразделы: сотрудник подраздела считается сотрудником отдела.
        for dept in departments:
            parent = dept.get("parentId") or dept.get("parent_id")
            if parent and str(parent) in wanted:
                wanted.add(str(dept.get("id")))
        names = {str(d.get("name", "")).strip().lower()
                 for d in departments if str(d.get("id")) in wanted}

        for user in users:
            ids = user.get("departmentIds") or user.get("department_ids") or []
            legacy = str(user.get("department") or "")
            in_dept = (
                any(str(i) in wanted for i in ids)
                or legacy in wanted
                or legacy.strip().lower() in names
            )
            if in_dept and user.get("id"):
                resolved[str(user["id"])] = user

    active = [u for u in resolved.values()
              if not (u.get("isDisabled") or u.get("is_disabled"))]
    return active, unknown


@router.get("/api/integrations/users")
def integration_list_users(request: Request, includeDisabled: bool = False):
    """Справочник сотрудников Shar для внешней системы."""
    _require_integration_key(request)
    users = db.get_users(include_disabled=True) if includeDisabled else (db.get_users() or [])
    result = [_integration_user_view(u) for u in (users or []) if u.get("id")]
    if not includeDisabled:
        result = [u for u in result if not u["isDisabled"]]
    return {"users": result, "count": len(result)}


@router.get("/api/integrations/departments")
def integration_list_departments(request: Request):
    """Отделы и подразделы вместе с составом.

    `parentId` = null у отдела верхнего уровня, иначе это подраздел. В
    `userIds` попадают только сотрудники, назначенные именно в этот
    отдел/подраздел; `allUserIds` у отдела включает и сотрудников подразделов —
    это то, что попадёт в рассылку при указании его departmentId."""
    _require_integration_key(request)
    try:
        departments = db.get_departments() or []
    except Exception as e:
        logger.error(f"[integrations] departments failed: {e}")
        departments = []

    users = db.get_users() or []

    def members_of(dept_id: str, dept_name: str) -> List[str]:
        out = []
        for u in users:
            if u.get("isDisabled") or u.get("is_disabled"):
                continue
            ids = u.get("departmentIds") or u.get("department_ids") or []
            legacy = str(u.get("department") or "")
            if (any(str(i) == dept_id for i in ids)
                    or legacy == dept_id
                    or legacy.strip().lower() == dept_name.strip().lower()):
                out.append(str(u.get("id")))
        return out

    result = []
    for dept in departments:
        dept_id = str(dept.get("id"))
        dept_name = str(dept.get("name") or "")
        parent = dept.get("parentId") or dept.get("parent_id")
        child_ids = [str(d.get("id")) for d in departments
                     if str(d.get("parentId") or d.get("parent_id") or "") == dept_id]
        own = members_of(dept_id, dept_name)
        combined = list(own)
        for child in departments:
            if str(child.get("id")) in child_ids:
                for uid in members_of(str(child.get("id")), str(child.get("name") or "")):
                    if uid not in combined:
                        combined.append(uid)
        result.append({
            "id": dept_id,
            "name": dept_name,
            "parentId": str(parent) if parent else None,
            "childDepartmentIds": child_ids,
            "userIds": own,
            "allUserIds": combined,
        })
    return {"departments": result, "count": len(result)}


@router.post("/api/integrations/notifications")
def integration_send_notification(request: Request, payload: dict = Body(...)):
    """Отправить уведомление в «Колокольчик» списку сотрудников.

    Тело запроса описано в docs/INTEGRATION_API.md. Кратко:
      text (обяз.), userIds и/или departmentIds (обяз. хотя бы одно),
      title, documentId, documentType, actionUrl, actionLabel, fromName,
      sentAt, notificationType.
    """
    _require_integration_key(request)

    text = str(payload.get("text") or payload.get("content") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    user_refs = payload.get("userIds") or payload.get("users") or []
    department_ids = payload.get("departmentIds") or payload.get("departments") or []
    if isinstance(user_refs, str):
        user_refs = [user_refs]
    if isinstance(department_ids, str):
        department_ids = [department_ids]
    if not user_refs and not department_ids:
        raise HTTPException(status_code=400, detail="userIds or departmentIds is required")

    recipients, unknown = _resolve_recipients(list(user_refs), list(department_ids))
    if not recipients:
        raise HTTPException(status_code=404,
                            detail=f"No active recipients resolved. Unknown refs: {unknown}")

    title = str(payload.get("title") or "").strip()
    action_url = _safe_action_url(str(payload.get("actionUrl") or "").strip())
    action_label = str(payload.get("actionLabel") or "Открыть в менеджерке").strip()
    document_id = str(payload.get("documentId") or payload.get("orderId") or "").strip()
    document_type = str(payload.get("documentType") or "").strip()
    # Подпись по умолчанию — как её увидит сотрудник в «Переслано от …».
    from_name = str(payload.get("fromName") or "").strip() or "Менеджерская программа"
    notification_type = str(payload.get("notificationType") or "info").strip() or "info"

    # Время события задаёт внешняя система (документ мог быть создан раньше, чем
    # доехал запрос); если не передали — берём текущее.
    sent_at = str(payload.get("sentAt") or "").strip() or datetime.now().isoformat()

    # Кнопка и реквизиты документа живут в metadata сообщения — клиент Shar
    # рисует по ним кнопку перехода.
    metadata = {
        "source": "manager",
        "actionUrl": action_url or None,
        "actionLabel": action_label if action_url else None,
        "documentId": document_id or None,
        "documentType": document_type or None,
        "title": title or None,
        "fromUserName": from_name or None,
        "sentAt": sent_at,
    }

    delivered, failed = [], []
    for user in recipients:
        uid = str(user.get("id"))
        try:
            message = send_notification_message(uid, {
                "content": text,
                "notificationType": notification_type,
                "fromUserName": from_name,
                "metadata": metadata,
            })
            delivered.append({"userId": uid, "messageId": message.get("id")})
        except HTTPException as e:
            failed.append({"userId": uid, "error": e.detail})
        except Exception as e:
            logger.error(f"[integrations] notify {uid} failed: {e}")
            failed.append({"userId": uid, "error": "internal error"})

    return {
        "status": "ok" if not failed else "partial",
        "delivered": delivered,
        "deliveredCount": len(delivered),
        "failed": failed,
        "unknownRecipients": unknown,
        "sentAt": sent_at,
    }
