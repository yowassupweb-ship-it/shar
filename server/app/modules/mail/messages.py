from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime as _dt
from datetime import timezone
from email.utils import make_msgid

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import Response

from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.security import Identity, current_identity
from app.modules.mail.crypto import _deobfuscate_pw
from app.modules.mail.imap import _owned_account
from app.modules.mail.service import (
    _IMAP_TOOLS,
    MailBox,
    MailBoxTls,
    _mail_light,
    _mail_message_for_client,
    _read_mail_blob,
    _send_smtp,
    _set_imap_flags,
)

router = APIRouter()
logger = logging.getLogger(__name__)

# Флаги «прочитано» и «звезда» уходят на почтовый сервер в фоне. Раньше каждое открытое письмо
# ждало входа в IMAP (1–3 с), а при листании подряд эти входы копились в пуле потоков сервера.
# Очередь на два потока; повтор для того же письма, пока прежний не ушёл, сливается в один.
_flag_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='mail-flags')
_flag_pending: dict = {}
_flag_lock = threading.Lock()


def _push_imap_flags(account_id: str, folder: str, uid: str, updates: dict) -> None:
    key = (account_id, folder, uid)
    with _flag_lock:
        queued = key in _flag_pending
        _flag_pending[key] = {**_flag_pending.get(key, {}), **updates}
    if queued:
        return

    def run() -> None:
        with _flag_lock:
            todo = _flag_pending.pop(key, None)
        if not todo:
            return
        try:
            account = db.conn.fetch_one("SELECT * FROM email_accounts WHERE id = %s", (account_id,))
            if account:
                _set_imap_flags(dict(account), folder, uid, todo)
        except Exception as exc:
            # Сверка ящика вернёт состояние с почтового сервера — локальная отметка не врёт долго.
            logger.warning(f"[Mail] IMAP flag update error for {account_id}/{folder}/{uid}: {exc}")

    _flag_pool.submit(run)


def _my_message(message_id: str, me: Identity) -> dict:
    """Письмо из ящика вошедшего; чужое — 404 (существование не раскрываем)."""
    msg = db.get_email_message(message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    _owned_account(str(msg['account_id']), me.user_id)
    return msg


@router.get("/api/mail/messages")
def get_mail_messages(accountId: str, folder: str = 'INBOX', limit: int = 50, offset: int = 0, search: str = '', light: bool = False, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    _owned_account(accountId, userId)
    # Custom folders (Gmail-label style) aren't real IMAP folders — "folder"
    # here is a synthetic id ("custom:<uuid>") and the actual message set is
    # resolved from that folder's sender-pattern rules instead.
    if folder.startswith('custom:'):
        folder_id = folder.split(':', 1)[1]
        if not userId:
            raise HTTPException(status_code=400, detail="userId is required for custom folders")
        rules = db.get_mail_folder_rules(userId, folder_id)
        patterns = [r['email_pattern'] for r in rules]
        msgs = db.get_email_messages_by_patterns(accountId, patterns, limit, offset)
        return [(_mail_light if light else _mail_message_for_client)(msg) for msg in msgs]
    msgs = db.get_email_messages(accountId, folder, limit, offset, search)
    return [(_mail_light if light else _mail_message_for_client)(msg) for msg in msgs]


@router.get("/api/mail/messages/{message_id}")
def get_mail_message(message_id: str, me: Identity = Depends(current_identity)):
    msg = _my_message(message_id, me)
    return _mail_message_for_client(msg)


@router.get("/api/mail/messages/{message_id}/attachments/{attachment_index}")
def download_mail_attachment(message_id: str, attachment_index: int, me: Identity = Depends(current_identity)):
    """Download an original IMAP attachment on demand instead of serving a dead placeholder link."""
    message = _my_message(message_id, me)
    if not message.get('uid'):
        raise HTTPException(status_code=404, detail="Attachment source is unavailable")
    attachments = message.get('attachments') or []
    if attachment_index < 0 or attachment_index >= len(attachments):
        raise HTTPException(status_code=404, detail="Attachment not found")
    meta = attachments[attachment_index] or {}
    stored_key = meta.get('stored')
    if stored_key:
        data = _read_mail_blob(stored_key)
        if data is not None:
            filename = (meta.get('filename') or 'attachment').replace('"', '')
            from urllib.parse import quote as _quote
            return Response(content=data, media_type=meta.get('content_type') or 'application/octet-stream', headers={
                # filename* — русские имена файлов доходят как есть.
                'Content-Disposition': f"attachment; filename=\"{filename.encode('ascii', 'replace').decode()}\"; filename*=UTF-8''{_quote(filename)}",
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'private, max-age=86400',
            })
    if not _IMAP_TOOLS:
        raise HTTPException(status_code=503, detail="IMAP attachment download is unavailable")

    account = db.conn.fetch_one("SELECT * FROM email_accounts WHERE id = %s", (message['account_id'],))
    if not account:
        raise HTTPException(status_code=404, detail="Mail account not found")
    account = dict(account)
    try:
        uid = int(message['uid'])
        port = int(account.get('imap_port', 993))
        mailbox_class = MailBoxTls if port == 993 else MailBox
        with mailbox_class(account['imap_host'], port).login(account['username'], _deobfuscate_pw(account['password_enc'])) as mailbox:
            mailbox.folder.set(message.get('folder') or 'INBOX')
            remote = next(iter(mailbox.fetch(f'UID {uid}', mark_seen=False)), None)
            remote_attachments = list(remote.attachments or []) if remote else []
        attachment = remote_attachments[attachment_index] if attachment_index < len(remote_attachments) else None
        if not attachment or attachment.payload is None:
            raise HTTPException(status_code=404, detail="Attachment is no longer available on the mail server")
        filename = (attachment.filename or attachments[attachment_index].get('filename') or 'attachment').replace('"', '')
        media_type = attachment.content_type or attachments[attachment_index].get('content_type') or 'application/octet-stream'
        from urllib.parse import quote as _quote
        return Response(content=attachment.payload, media_type=media_type, headers={
            # Заголовки HTTP — только latin-1: русское имя файла роняло ответ
            # (500). ASCII-запасное имя + filename* в UTF-8.
            'Content-Disposition': f"attachment; filename=\"{filename.encode('ascii', 'replace').decode()}\"; filename*=UTF-8''{_quote(filename)}",
            'X-Content-Type-Options': 'nosniff',
        })
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(f"[Mail] Attachment download error for {message_id}: {exc}")
        raise HTTPException(status_code=502, detail="Could not download attachment from the mail server")


@router.put("/api/mail/messages/{message_id}")
def update_mail_message(message_id: str, data: dict = Body(...), me: Identity = Depends(current_identity)):
    allowed = {'isRead': 'is_read', 'isStarred': 'is_starred', 'folder': 'folder'}
    updates = {}
    for camel, snake in allowed.items():
        if camel in data:
            updates[snake] = data[camel]
    existing = _my_message(message_id, me)
    imap_updates = {key: value for key, value in updates.items() if key in ('is_read', 'is_starred')}
    updated = db.update_email_message(message_id, updates)
    if not updated:
        raise HTTPException(status_code=404, detail="Message not found")
    if existing.get('uid') and imap_updates:
        _push_imap_flags(str(existing['account_id']), existing.get('folder') or 'INBOX', str(existing['uid']), imap_updates)
    return snake_to_camel(updated)


@router.delete("/api/mail/messages/{message_id}")
def delete_mail_message(message_id: str, me: Identity = Depends(current_identity)):
    _my_message(message_id, me)
    ok = db.delete_email_message(message_id)
    return {"success": bool(ok)}


@router.post("/api/mail/send")
def send_mail(data: dict = Body(...), me: Identity = Depends(current_identity)):
    account_id = data.get('accountId')
    user_id = me.user_id
    if not account_id or not user_id:
        raise HTTPException(status_code=400, detail="accountId and userId required")

    accounts = db.get_email_accounts(user_id)
    account = next((a for a in accounts if str(a['id']) == str(account_id)), None)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    to = data.get('to', [])
    cc = data.get('cc', [])
    bcc = data.get('bcc', [])
    subject = data.get('subject', '')
    body_text = data.get('bodyText', '')
    body_html = data.get('bodyHtml', '')
    reply_to_msg_id = data.get('replyToMessageId')
    attachments = data.get('attachments', [])

    if not to:
        raise HTTPException(status_code=400, detail="'to' is required")

    result = _send_smtp(account, to, subject, body_text, body_html, cc, bcc, reply_to_msg_id, attachments)
    if not result.get('success'):
        raise HTTPException(status_code=502, detail=result.get('error', 'SMTP error'))

    # Save sent message to DB
    frm_name, frm_addr = account.get('name', ''), account['email']
    to_list = [{'addr': a, 'name': ''} for a in to]
    cc_list = [{'addr': a, 'name': ''} for a in cc]

    thread_id = reply_to_msg_id or result['message_id']
    saved = db.add_email_message({
        'account_id': account_id,
        'uid': None,
        'folder': 'SENT',
        'message_id': result['message_id'],
        'thread_id': thread_id,
        'subject': subject,
        'from_addr': frm_addr,
        'from_name': frm_name,
        'to_addrs': to_list,
        'cc_addrs': cc_list,
        'bcc_addrs': [],
        'body_text': body_text,
        'body_html': body_html,
        'attachments': attachments,
        'is_read': True,
        'is_starred': False,
        'is_draft': False,
        'date': _dt.now(timezone.utc),  # с зоной: база переведёт в своё (московское) время, как письма с IMAP
    })

    return {
        'success': True,
        'messageId': result['message_id'],
        'saved': snake_to_camel(saved) if saved else None,
    }


@router.post("/api/mail/draft")
def save_draft(data: dict = Body(...), me: Identity = Depends(current_identity)):
    account_id = data.get('accountId')
    _owned_account(str(account_id or ''), me.user_id)
    draft_id = data.get('draftId')  # existing draft ID to update
    msg = {
        'account_id': account_id,
        'uid': None,
        'folder': 'DRAFTS',
        'message_id': make_msgid(),
        'thread_id': data.get('threadId') or make_msgid(),
        'subject': data.get('subject', ''),
        'from_addr': data.get('fromAddr', ''),
        'from_name': data.get('fromName', ''),
        'to_addrs': [{'addr': a, 'name': ''} for a in data.get('to', [])],
        'cc_addrs': [{'addr': a, 'name': ''} for a in data.get('cc', [])],
        'bcc_addrs': [],
        'body_text': data.get('bodyText', ''),
        'body_html': '',
        'attachments': [],
        'is_read': True,
        'is_starred': False,
        'is_draft': True,
        'date': _dt.now(timezone.utc),  # с зоной: база переведёт в своё (московское) время, как письма с IMAP
    }
    if draft_id:
        _my_message(str(draft_id), me)
        saved = db.update_email_message(draft_id, {
            'subject': msg['subject'], 'body_text': msg['body_text'], 'folder': 'DRAFTS'
        })
    else:
        saved = db.add_email_message(msg)
    return snake_to_camel(saved) if saved else {}


@router.get("/api/mail/unread")
def get_mail_unread(accountId: str, me: Identity = Depends(current_identity)):
    _owned_account(accountId, me.user_id)
    return db.get_email_unread_counts(accountId)


@router.get("/api/mail/unread/total")
def get_mail_unread_total(inbox: bool = False, me: Identity = Depends(current_identity)):
    """Total unread email count across all accounts for a user. inbox=true — только «Входящие» (единичка на «Почте»
    в меню, как у почтовых программ: непрочитанное в спаме и корзине её не зажигает)."""
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    accounts = db.get_email_accounts(userId) if hasattr(db, 'get_email_accounts') else []
    total = 0
    for acc in accounts:
        counts = db.get_email_unread_counts(str(acc['id'])) if hasattr(db, 'get_email_unread_counts') else {}
        total += sum(n for folder, n in counts.items() if not inbox or str(folder).upper() == 'INBOX')
    return {"total": total}


@router.get("/api/mail/recipients")
def get_mail_recipients(accountId: str, q: str = '', me: Identity = Depends(current_identity)):
    """Return frequent To/Cc recipients from sent mail, ranked by frequency.
    Optionally filtered by query string q (matches addr or name prefix)."""
    _owned_account(accountId, me.user_id)
    try:
        rows = db.conn.fetch_all(
            """
            SELECT addr, name, COUNT(*) AS cnt
            FROM (
                SELECT
                    jsonb_array_elements(to_addrs)->>'addr'  AS addr,
                    jsonb_array_elements(to_addrs)->>'name'  AS name
                FROM email_messages
                WHERE account_id = %s AND folder IN ('SENT','DRAFTS')
                  AND to_addrs IS NOT NULL AND jsonb_array_length(to_addrs) > 0
                UNION ALL
                SELECT
                    jsonb_array_elements(cc_addrs)->>'addr' AS addr,
                    jsonb_array_elements(cc_addrs)->>'name' AS name
                FROM email_messages
                WHERE account_id = %s AND folder IN ('SENT','DRAFTS')
                  AND cc_addrs IS NOT NULL AND jsonb_array_length(cc_addrs) > 0
            ) sub
            WHERE addr IS NOT NULL AND addr != ''
            GROUP BY addr, name
            ORDER BY cnt DESC
            LIMIT 50
            """,
            (accountId, accountId)
        )
        results = [{'addr': r['addr'], 'name': r['name'] or '', 'count': int(r['cnt'])} for r in (rows or [])]
        if q:
            q_low = q.lower()
            results = [r for r in results if q_low in r['addr'].lower() or q_low in r['name'].lower()]
        return results
    except Exception as e:
        logger.warning(f"[Mail] recipients error: {e}")
        return []
