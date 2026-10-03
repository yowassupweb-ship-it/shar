from __future__ import annotations

import base64 as _base64
import hashlib as _hashlib

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from app.core.db import db
from app.core.security import Identity, current_identity
from app.modules.chats.access import require_member

router = APIRouter()


def _inline_key(data_url: str) -> str:
    return _hashlib.sha1(data_url.encode('utf-8', 'ignore')).hexdigest()[:16]


def _externalize_inline(url: str, message_id: str) -> str:
    if isinstance(url, str) and url.startswith('data:') and message_id:
        return f"/api/messages/{message_id}/inline?h={_inline_key(url)}"
    return url


def _externalize_message(msg: dict) -> dict:
    atts = msg.get('attachments')
    if not isinstance(atts, list) or not any(isinstance(a, dict) and str(a.get('url', '')).startswith('data:') for a in atts):
        return msg
    mid = str(msg.get('id') or '')
    return {**msg, 'attachments': [
        {**a, 'url': _externalize_inline(a.get('url'), mid)} if isinstance(a, dict) else a for a in atts
    ]}


@router.get("/api/messages/{message_id}/inline")
def get_inline_attachment(message_id: str, h: str, me: Identity = Depends(current_identity)):
    """Картинка, хранившаяся прямо в сообщении, — отдельным файлом (только участнику чата)."""
    row = db.conn.fetch_one("SELECT chat_id, attachments FROM messages WHERE id = %s", (message_id,))
    if row:
        require_member(str(row['chat_id']), me, allow_missing_own=False)
    atts = (row or {}).get('attachments') or []
    for a in atts if isinstance(atts, list) else []:
        url = a.get('url') if isinstance(a, dict) else None
        if isinstance(url, str) and url.startswith('data:') and _inline_key(url) == h:
            head, _, payload = url.partition(',')
            media_type = head[5:].split(';')[0] or 'application/octet-stream'
            try:
                body = _base64.b64decode(payload) if ';base64' in head else payload.encode('utf-8')
            except Exception:
                break
            return Response(content=body, media_type=media_type,
                             headers={'Cache-Control': 'public, max-age=31536000, immutable'})
    raise HTTPException(status_code=404, detail="Attachment not found")
