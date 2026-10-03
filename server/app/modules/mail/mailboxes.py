from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core.db import db
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity, require_admin
from app.modules.mail import idle as mail_realtime
from app.modules.mail.imap import _imap_connect, _owned_account, _special_folders
from app.modules.mail.watch import _ROLE_TITLES

router = APIRouter()


@router.get("/api/mail/mailboxes")
def get_mailboxes(accountId: str, me: Identity = Depends(current_identity)):
    """Папки ящика с настоящими именами на сервере и счётчиками непрочитанных."""
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    acc = _owned_account(accountId, userId)
    try:
        roles = _special_folders(acc)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Почтовый сервер не ответил: {e}")
    unread = db.get_email_unread_counts(str(acc['id'])) or {}
    order = ['inbox', 'drafts', 'sent', 'junk', 'trash', 'archive']
    return [
        {'role': role, 'folder': roles[role], 'title': _ROLE_TITLES[role], 'unread': int(unread.get(roles[role], 0) or 0)}
        for role in order if role in roles
    ]


@router.post("/api/mail/messages/{message_id}/move")
def move_mail_message(message_id: str, data: dict = Body(...), me: Identity = Depends(current_identity)):
    """Перенести письмо на сервере (в корзину, архив, спам, входящие).
    Из корзины «в корзину» — удалить насовсем."""
    msg = db.get_email_message(message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    acc = _owned_account(str(msg['account_id']), str(me.user_id or ''))
    target_role = str(data.get('to') or 'trash')
    roles = _special_folders(acc)
    target = roles.get(target_role)
    if not target:
        raise HTTPException(status_code=400, detail="Нет такой папки на сервере")
    src = msg.get('folder') or 'INBOX'
    uid = str(msg.get('uid') or '')
    on_server = False
    if uid.isdigit():
        conn = _imap_connect(acc)
        try:
            typ, _ = conn.select(src)
            if typ != 'OK':
                raise HTTPException(status_code=502, detail="Папка недоступна на сервере")
            typ, hit = conn.uid('SEARCH', None, 'UID', uid)
            on_server = typ == 'OK' and bool(hit and hit[0] and hit[0].split())
            if not on_server:
                typ = 'OK'  # на сервере письма уже нет (старое) — убираем только у нас
            elif src != target:
                if 'MOVE' in conn.capabilities:
                    typ, _ = conn.uid('MOVE', uid, target)
                else:
                    typ, _ = conn.uid('COPY', uid, target)
                    if typ == 'OK':
                        conn.uid('STORE', uid, '+FLAGS.SILENT', '(\\Deleted)')
                        if 'UIDPLUS' in conn.capabilities:
                            conn.uid('EXPUNGE', uid)
                        else:
                            conn.expunge()
            else:
                conn.uid('STORE', uid, '+FLAGS.SILENT', '(\\Deleted)')
                if 'UIDPLUS' in conn.capabilities:
                    typ, _ = conn.uid('EXPUNGE', uid)
                else:
                    typ, _ = conn.expunge()
            if typ != 'OK':
                raise HTTPException(status_code=502, detail="Почтовый сервер не перенёс письмо")
        finally:
            try:
                conn.logout()
            except Exception:
                pass
    if on_server or src == target:
        # Копию в новой папке заберёт синхронизация этой папки (у неё новый UID).
        db.delete_email_message(message_id)
    else:
        # Письма на сервере уже нет — Шар его единственная копия: переносим у
        # себя. Без UID: чужой номер сбил бы забор новых писем в этой папке.
        db.conn.execute_query("UPDATE email_messages SET folder = %s, uid = NULL WHERE id = %s", (target, message_id))
    sse_manager.push(str(acc['user_id']), {'type': 'mail_changed', 'accountId': str(acc['id']), 'folder': src})
    return {'success': True, 'folder': target}


@router.get("/api/mail/watch-status")
def mail_watch_status(me: Identity = Depends(require_admin)):
    """Кто сейчас следит за ящиками: idle / poll / reconnecting — для отладки."""
    return {'enabled': mail_realtime.enabled(), 'watchers': mail_realtime.status()}
