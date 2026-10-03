from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core.db import db
from app.core.security import Identity, current_identity
from app.modules.mail.crypto import _deobfuscate_pw
from app.modules.mail.service import (
    _IMAP_TOOLS,
    MailBox,
    MailBoxTls,
    _route_emails_to_chats,
    _sync_folder_imap,
)

router = APIRouter()


@router.post("/api/mail/sync")
def sync_mail(data: dict = Body(...), me: Identity = Depends(current_identity)):
    """Sync messages for an account from IMAP."""
    account_id = data.get('accountId')
    user_id = me.user_id
    folder = data.get('folder', 'INBOX')

    accounts = db.get_email_accounts(user_id)
    account = next((a for a in accounts if str(a['id']) == str(account_id)), None)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    synced, fetched, failed, error = _sync_folder_imap(account, folder)
    if error:
        raise HTTPException(status_code=502, detail=error)

    # Route new INBOX emails to chats based on rules / #Отзывы chat
    routed = 0
    if folder == 'INBOX' and synced:
        routed = _route_emails_to_chats(synced, user_id, str(account_id))

    return {"synced": len(synced), "fetched": fetched, "failed": failed, "folder": folder, "routed": routed}


@router.post("/api/mail/diagnose")
def diagnose_mail(data: dict = Body(...), me: Identity = Depends(current_identity)):
    """Return IMAP folder list + message counts to help debug sync issues."""
    account_id = data.get('accountId')
    user_id = me.user_id
    accounts = db.get_email_accounts(user_id)
    account = next((a for a in accounts if str(a['id']) == str(account_id)), None)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    if not _IMAP_TOOLS:
        raise HTTPException(status_code=500, detail="imap-tools not installed")

    pw = _deobfuscate_pw(account['password_enc'])
    port = int(account.get('imap_port', 993))
    host = account['imap_host']
    mb_cls = MailBoxTls if port == 993 else MailBox
    try:
        with mb_cls(host, port).login(account['username'], pw) as mb:
            folders = []
            for f in mb.folder.list():
                fname = str(f.name)
                try:
                    mb.folder.set(fname)
                    # Count messages in folder
                    uids = mb.uids('ALL')
                    count = len(uids)
                except Exception:
                    count = -1
                folders.append({'name': fname, 'count': count})
        return {'folders': folders, 'host': host, 'port': port, 'username': account['username']}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
