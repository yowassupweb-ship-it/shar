from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core.camel import snake_to_camel, snake_to_camel_list
from app.core.db import db
from app.core.security import Identity, current_identity
from app.modules.mail import idle as mail_realtime
from app.modules.mail.crypto import _obfuscate_pw, mark_password, needs_password
from app.modules.mail.imap import _special_cache

router = APIRouter()


@router.get("/api/mail/accounts")
def get_mail_accounts(me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    accounts = db.get_email_accounts(userId)
    # Strip password before returning. Converted to camelCase — the frontend's
    # EmailAccount type (and every form that pre-fills from it, e.g. the edit-
    # account modal) expects imapHost/smtpHost/useSsl etc; returning raw
    # snake_case here silently corrupted every edit — the form would read
    # editAccount.imapHost as undefined, default the field to '', and that
    # empty string would then overwrite the real imap_host/smtp_host in the
    # DB on save, since the PUT route's data.get('imapHost', ...) sees the
    # key present (even if empty) and never falls back to the old value.
    # needsPassword — Шар выбило из ящика (пароль нечем расшифровать или сервер его отверг):
    # приложение показывает это сразу, а не плашкой в углу почты.
    return snake_to_camel_list([
        {**{k: v for k, v in a.items() if k not in ('password_enc',)}, 'needs_password': needs_password(a)}
        for a in accounts
    ])


@router.post("/api/mail/accounts")
def add_mail_account(data: dict = Body(...), me: Identity = Depends(current_identity)):
    required = ['name', 'email', 'imapHost', 'smtpHost', 'username', 'password']
    for f in required:
        if not data.get(f):
            raise HTTPException(status_code=400, detail=f"{f} is required")
    account = {
        'user_id': me.user_id,
        'name': data['name'],
        'email': data['email'],
        'imap_host': data['imapHost'],
        'imap_port': data.get('imapPort', 993),
        'smtp_host': data['smtpHost'],
        'smtp_port': data.get('smtpPort', 587),
        'username': data['username'],
        'password_enc': _obfuscate_pw(data['password']),
        'use_ssl': data.get('useSsl', True),
        'signature': data.get('signature', ''),
    }
    saved = db.add_email_account(account)
    if not saved:
        raise HTTPException(status_code=500, detail="Failed to save account")
    mail_realtime.ensure(str(saved['id']))
    result = {k: v for k, v in saved.items() if k != 'password_enc'}
    return snake_to_camel(result)


@router.put("/api/mail/accounts/{account_id}")
def update_mail_account(account_id: str, data: dict = Body(...), me: Identity = Depends(current_identity)):
    user_id = me.user_id
    accounts = db.get_email_accounts(user_id)
    account = next((a for a in accounts if str(a['id']) == str(account_id)), None)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    # `or account[...]` (not `.get(key, default)`) is deliberate for the required
    # connection fields — a blank string sent from a stale/half-filled edit form
    # must never wipe out a previously-working imap_host/smtp_host/username.
    updates = {
        'name': data.get('name') or account['name'],
        'email': data.get('email') or account['email'],
        'imap_host': data.get('imapHost') or account['imap_host'],
        'imap_port': data.get('imapPort', account['imap_port']),
        'smtp_host': data.get('smtpHost') or account['smtp_host'],
        'smtp_port': data.get('smtpPort', account['smtp_port']),
        'username': data.get('username') or account['username'],
        'use_ssl': data.get('useSsl', account['use_ssl']),
        'signature': data.get('signature', account.get('signature', '')),
    }
    if data.get('password') and not data.get('skipPassword'):
        updates['password_enc'] = _obfuscate_pw(data['password'])
        mark_password(account_id, True)
    clauses = ', '.join(f"{k} = %s" for k in updates)
    params = tuple(updates.values()) + (account_id, user_id)
    row = db.conn.fetch_one(
        f"UPDATE email_accounts SET {clauses} WHERE id = %s AND user_id = %s RETURNING *", params
    )
    if not row:
        raise HTTPException(status_code=500, detail="Failed to update")
    _special_cache.pop(str(account_id), None)
    mail_realtime.ensure(str(account_id))  # новые настройки — новое соединение
    return snake_to_camel({k: v for k, v in dict(row).items() if k != 'password_enc'})


@router.delete("/api/mail/accounts/{account_id}")
def delete_mail_account(account_id: str, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    ok = db.delete_email_account(account_id, userId)
    if ok:
        mail_realtime.stop(str(account_id))
    return {"success": bool(ok)}


@router.get("/api/mail/folders")
def get_mail_folders(me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    return snake_to_camel_list(db.get_mail_folders(userId))


@router.post("/api/mail/folders")
def add_mail_folder(data: dict = Body(...), me: Identity = Depends(current_identity)):
    user_id = me.user_id
    name = (data.get('name') or '').strip()
    if not user_id or not name:
        raise HTTPException(status_code=400, detail="userId and name are required")
    color = data.get('color') or '#3b82f6'
    saved = db.add_mail_folder(user_id, name, color)
    if not saved:
        raise HTTPException(status_code=500, detail="Failed to save folder")
    return snake_to_camel(saved)


@router.put("/api/mail/folders/{folder_id}")
def rename_mail_folder(folder_id: str, data: dict = Body(...), me: Identity = Depends(current_identity)):
    user_id = me.user_id
    name = (data.get('name') or '').strip()
    if not user_id or not name:
        raise HTTPException(status_code=400, detail="userId and name are required")
    saved = db.rename_mail_folder(folder_id, user_id, name)
    if not saved:
        raise HTTPException(status_code=404, detail="Folder not found")
    return snake_to_camel(saved)


@router.delete("/api/mail/folders/{folder_id}")
def delete_mail_folder(folder_id: str, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    ok = db.delete_mail_folder(folder_id, userId)
    return {"success": bool(ok)}


@router.get("/api/mail/folder-rules")
def get_mail_folder_rules(folderId: Optional[str] = None, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    return snake_to_camel_list(db.get_mail_folder_rules(userId, folderId))


@router.post("/api/mail/folder-rules")
def add_mail_folder_rule(data: dict = Body(...), me: Identity = Depends(current_identity)):
    user_id = me.user_id
    folder_id = data.get('folderId')
    email_pattern = (data.get('emailPattern') or '').strip()
    if not user_id or not folder_id or not email_pattern:
        raise HTTPException(status_code=400, detail="userId, folderId and emailPattern are required")
    saved = db.add_mail_folder_rule(user_id, folder_id, email_pattern)
    if not saved:
        raise HTTPException(status_code=500, detail="Failed to save rule")
    return snake_to_camel(saved)


@router.delete("/api/mail/folder-rules/{rule_id}")
def delete_mail_folder_rule(rule_id: str, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    ok = db.delete_mail_folder_rule(rule_id, userId)
    return {"success": bool(ok)}
