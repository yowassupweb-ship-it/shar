"""Web-push: подписки устройств, личные настройки, тестовый пуш, внутренняя рассылка.

Все действия — от имени вошедшего: userId из тела или адреса не принимается.
Раньше можно было подписать устройство на чужой аккаунт, прочитать и сменить чужие
настройки и разослать пуш от чьего угодно имени любому сотруднику."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app.core.ratelimit import limiter
from app.core.security import Identity, current_identity, keys_equal, optional_identity
from app.modules.push import service, store

router = APIRouter()


@router.get("/api/push/subscriptions")
def get_subscription_state(me: Identity = Depends(current_identity)):
    return {
        "configured": service.is_configured(),
        "publicKey": service.public_key() or None,
        "userId": me.user_id,
        "count": store.count_for(me.user_id),
    }


class SubscribeBody(BaseModel):
    subscription: Dict[str, Any]
    userAgent: str = ""
    platform: str = ""


@router.post("/api/push/subscriptions")
def subscribe(body: SubscribeBody, me: Identity = Depends(current_identity)):
    endpoint = str(body.subscription.get("endpoint") or "").strip()
    if not endpoint.startswith("https://"):
        raise HTTPException(status_code=400, detail="Invalid payload")
    if not service.is_configured():
        raise HTTPException(status_code=503, detail="Web push is not configured on server")
    saved = store.upsert_subscription(me.user_id, body.subscription, body.userAgent, body.platform)
    return {"success": True, "endpoint": saved.get("endpoint"), "updatedAt": str(saved.get("updated_at") or "")}


class UnsubscribeBody(BaseModel):
    endpoint: str = ""


@router.delete("/api/push/subscriptions")
def unsubscribe(body: Optional[UnsubscribeBody] = None, me: Identity = Depends(current_identity)):
    removed = store.remove(me.user_id, (body.endpoint if body else "").strip())
    return {"success": True, "removed": removed}


@router.get("/api/push/prefs")
def get_prefs(me: Identity = Depends(current_identity)):
    return store.get_prefs(me.user_id)


class PrefsBody(BaseModel):
    reactions: Optional[bool] = None


@router.post("/api/push/prefs")
def set_prefs(body: PrefsBody, me: Identity = Depends(current_identity)):
    patch = body.model_dump(exclude_none=True)
    return store.set_prefs(me.user_id, patch) if patch else store.get_prefs(me.user_id)


class TestBody(BaseModel):
    title: str = "Тестовое push-уведомление"
    body: str = "Push для PWA работает корректно"
    url: str = "/settings"


@router.post("/api/push/test")
async def send_test(body: TestBody, me: Identity = Depends(current_identity)):
    """Проверочный пуш — только себе."""
    if not limiter.allow(f"push-test:{me.user_id}", 10, 60):
        raise HTTPException(status_code=429, detail="Слишком часто")
    result = await run_in_threadpool(
        service.send_to_user, me.user_id,
        {"title": body.title[:80], "body": body.body[:200], "tag": "push-test", "url": body.url, "requireInteraction": False, "silent": False},
    )
    return {"success": True, **result}


class NotifyBody(BaseModel):
    recipientIds: List[str] = Field(default_factory=list)
    title: str = "Новое сообщение"
    body: str = ""
    url: str = "/account?tab=messages"
    tag: str = "message"
    chatId: Optional[str] = None
    senderName: Optional[str] = None


@router.post("/api/push/notify")
async def notify(body: NotifyBody, request: Request, me: Optional[Identity] = Depends(optional_identity)):
    """Рассылка пуша. Внутренний ключ (server-to-server) — без ограничений. Вошедший
    клиент — только пуш о реакции на сообщение (tag reaction-…), до 5 получателей:
    произвольный текст от чьего-либо имени с клиента слать нельзя."""
    internal = keys_equal(request.headers.get("x-shar-internal-key", "").strip(), request.app.state.settings.internal_push_key)
    recipients = list(dict.fromkeys(body.recipientIds))
    if not internal:
        if me is None:
            raise HTTPException(status_code=401, detail="Требуется авторизация")
        if not body.tag.startswith("reaction-") or len(recipients) > 5:
            raise HTTPException(status_code=403, detail="Недоступно")
        if not limiter.allow(f"push-notify:{me.user_id}", 60, 60):
            raise HTTPException(status_code=429, detail="Слишком часто")
        recipients = [r for r in recipients if r != me.user_id]
        # Имя в заголовке — из сессии, а не из тела запроса: подделать «от кого» нельзя.
        if not body.title.startswith(me.display_name):
            body.title = f"{me.display_name} отреагировал(а)"
    if not recipients:
        return {"sent": 0, "failed": 0}
    extra = {k: v for k, v in (("chatId", body.chatId), ("senderName", body.senderName)) if v}
    return await run_in_threadpool(
        lambda: service.notify(recipients, title=body.title[:120], body=body.body[:240], url=body.url, tag=body.tag[:64], **extra)
    )
