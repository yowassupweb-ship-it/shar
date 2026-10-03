from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.security import Identity, current_identity

router = APIRouter()


@router.get("/api/email-chat-rules")
def get_email_chat_rules(me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    rules = db.get_email_chat_rules(userId) if hasattr(db, 'get_email_chat_rules') else []
    # Enrich with chat title
    enriched = []
    for r in rules:
        chat = db.get_chat(r['chat_id'])
        r['chat_title'] = chat.get('title', '') if chat else ''
        enriched.append(snake_to_camel(r))
    return enriched


@router.post("/api/email-chat-rules")
def create_email_chat_rule(data: dict = Body(...), me: Identity = Depends(current_identity)):
    user_id     = me.user_id
    account_id  = data.get('accountId')
    pattern     = (data.get('emailPattern') or '').strip().lower()
    chat_id     = data.get('chatId', '').strip()
    description = data.get('description', '').strip()
    keyword     = data.get('keyword', '').strip()

    if not user_id or not pattern or not chat_id:
        raise HTTPException(status_code=400, detail="userId, emailPattern, chatId required")
    if not db.get_chat(chat_id):
        raise HTTPException(status_code=404, detail="Chat not found")

    rule = db.create_email_chat_rule({
        'user_id': user_id,
        'account_id': account_id or None,
        'email_pattern': pattern,
        'chat_id': chat_id,
        'description': description,
        'keyword': keyword,
    })
    if not rule:
        raise HTTPException(status_code=500, detail="Failed to create rule")
    chat = db.get_chat(chat_id)
    rule['chat_title'] = chat.get('title', '') if chat else ''
    return snake_to_camel(rule)


@router.delete("/api/email-chat-rules/{rule_id}")
def delete_email_chat_rule(rule_id: str, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    ok = db.delete_email_chat_rule(rule_id, userId) if hasattr(db, 'delete_email_chat_rule') else False
    if not ok:
        raise HTTPException(status_code=404, detail="Rule not found")
    return {"ok": True}
