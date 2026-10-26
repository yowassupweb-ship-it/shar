from __future__ import annotations

import base64
import imaplib
import io
import logging
import mimetypes as _mimetypes
import re
import smtplib
import threading as _threading
import time
from datetime import datetime, timezone
from email import encoders as email_encoders
from email.header import decode_header as _decode_header
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, make_msgid, parseaddr
from html import unescape as _html_unescape
from pathlib import Path
from typing import Optional

from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.realtime import sse_manager
from app.core.storage import UPLOAD_DIR, s3_storage
from app.modules.mail.crypto import _deobfuscate_pw
from app.modules.mail.imap import _imap_connect, _special_folders, _wire

logger = logging.getLogger(__name__)

try:
    import imap_tools as _imap_tools_mod
    from imap_tools import MailBox, MailMessage
    try:
        from imap_tools import MailBoxTls
    except ImportError:
        # Older versions: use MailBox with ssl_context
        import ssl as _ssl_mod
        class MailBoxTls(MailBox):
            def __init__(self, host, port=993, **kw):
                ctx = _ssl_mod.create_default_context()
                super().__init__(host, port, ssl_context=ctx, **kw)
    _IMAP_TOOLS = True
except ImportError:
    _IMAP_TOOLS = False
    logger.debug("[Mail] imap-tools not installed — install with: pip install imap-tools")


def _decode_mime_words(s: str) -> str:
    if not s:
        return ''
    parts = _decode_header(s)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(charset or 'utf-8', errors='replace'))
        else:
            decoded.append(part)
    return ' '.join(decoded)


def _get_max_uid(account_id, folder: str) -> int | None:
    """Return the highest numeric UID stored for this account/folder, or None."""
    try:
        row = db.conn.fetch_one(
            "SELECT MAX(uid::bigint) AS max_uid FROM email_messages WHERE account_id = %s AND folder = %s",
            (account_id, folder)
        )
        return int(row['max_uid']) if row and row['max_uid'] is not None else None
    except Exception:
        return None


MAIL_ATTACHMENT_STORE_MAX = 25 * 1024 * 1024


def _mail_blob_key(account_id, folder: str, uid, index: int) -> str:
    safe_folder = ''.join(ch if ch.isalnum() or ch in '_-' else '_' for ch in (folder or 'INBOX'))
    return f"mail/{account_id}/{safe_folder}/{uid}/{index}"


def _store_mail_blob(key: str, data: bytes, content_type: str) -> bool:
    try:
        if s3_storage.enabled:
            s3_storage.upload_fileobj(io.BytesIO(data), key, content_type or 'application/octet-stream')
        else:
            path = UPLOAD_DIR / key
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return True
    except Exception as e:
        logger.debug(f"[Mail] не сохранил вложение {key}: {e}")
        return False


def _read_mail_blob(key: str) -> Optional[bytes]:
    try:
        if s3_storage.enabled:
            obj = s3_storage.get_object(key)
            return obj['Body'].read() if obj else None
        path = UPLOAD_DIR / key
        return path.read_bytes() if path.exists() else None
    except Exception:
        return None


def _sync_folder_imap(account: dict, folder: str = 'INBOX', max_msgs: int = 100) -> tuple:
    """Fetch messages from IMAP into DB. Returns (synced_list, fetched_count, failed_count, error_str_or_None).

    Uses UID-based incremental sync: only fetches messages newer than the last
    known UID, so subsequent syncs are near-instant (no re-downloading old mail).
    Falls back to a full limited fetch when the mailbox is empty in the DB.
    """
    if not _IMAP_TOOLS:
        return [], 0, "imap-tools not installed on server. Run: pip install imap-tools"
    pw = _deobfuscate_pw(account['password_enc'])
    synced = []
    failed_count = 0
    port = int(account.get('imap_port', 993))
    host = account['imap_host']
    username = account['username']
    fetched_count = 0

    # Determine incremental criteria before connecting
    max_uid = _get_max_uid(account['id'], folder)
    if max_uid is not None:
        # Fetch only messages with UID > last known — no limit needed (usually few/none)
        uid_criteria = f'UID {max_uid + 1}:*'
        is_incremental = True
    else:
        uid_criteria = 'ALL'
        is_incremental = False

    try:
        # Port 993 = direct TLS (IMAPS); others = STARTTLS via plain MailBox
        mb_cls = MailBoxTls if port == 993 else MailBox
        logger.debug(f"[Mail] Connecting {mb_cls.__name__} to {host}:{port} as {username} (incremental={is_incremental}, max_uid={max_uid})")
        with mb_cls(host, port).login(username, pw) as mb:
            # List available folders for debug (only on first sync)
            if not is_incremental:
                try:
                    available = [str(f) for f in mb.folder.list()]
                    logger.debug(f"[Mail] Available folders: {available[:10]}")
                except Exception as fe:
                    logger.debug(f"[Mail] Could not list folders: {fe}")

            # Папки нет — это ошибка, а не повод читать «Входящие»: раньше письма INBOX
            # ложились в базу под именем «Отправленных» и показывались там.
            actual_folder = folder
            mb.folder.set(folder)

            if is_incremental:
                # Incremental: fetch only new UIDs — no limit, usually 0–few messages
                msgs = list(mb.fetch(uid_criteria, mark_seen=False, reverse=True))
            else:
                # First sync: fetch latest max_msgs messages
                msgs = list(mb.fetch('ALL', mark_seen=False, limit=max_msgs, reverse=True))
            fetched_count = len(msgs)
            logger.debug(f"[Mail] Fetched {fetched_count} messages from {actual_folder}")
        for m in msgs:
            # Thread: group by Subject (normalize) or References header
            references = (m.headers.get('references', ['']) or [''])[0]
            in_reply_to = (m.headers.get('in-reply-to', ['']) or [''])[0]
            msg_id_hdr = (m.headers.get('message-id', ['']) or [''])[0].strip()
            thread_id = (references.split()[0] if references.strip() else None) or in_reply_to.strip() or msg_id_hdr

            # Extract display name from From header.
            # m.from_ in newer imap_tools is email-only; the display name is in the raw header.
            # We try multiple sources in order of reliability.
            raw_from = ''
            # 1. m.headers['from'] — raw header including display name (all imap_tools versions)
            try:
                raw_from = (m.headers.get('from', []) or [])[0] or ''
            except Exception:
                pass
            # 2. m.obj.get('From') — email.Message object (newer imap_tools)
            if not raw_from:
                try:
                    if hasattr(m, 'obj') and m.obj:
                        raw_from = str(m.obj.get('From') or '')
                except Exception:
                    pass
            # 3. m.from_ as last resort
            if not raw_from:
                raw_from = m.from_ or ''

            # Decode using make_header(decode_header()) — correct RFC 2047 multi-part handling
            from email.header import decode_header as _dec_hdr
            from email.header import make_header as _make_hdr
            try:
                frm_decoded = str(_make_hdr(_dec_hdr(raw_from)))
            except Exception:
                frm_decoded = _decode_mime_words(raw_from)
            frm_name, frm_addr = parseaddr(frm_decoded)
            if not frm_addr:
                # parseaddr failed (e.g. raw_from was just an email)
                frm_addr = m.from_ or raw_from.strip('<>').strip()
            to_list = [{'name': _decode_mime_words(n) or a.split('@')[0], 'addr': a} for n, a in [parseaddr(_decode_mime_words(t)) for t in (m.to or [])]]
            cc_list = [{'name': _decode_mime_words(n) or a.split('@')[0], 'addr': a} for n, a in [parseaddr(_decode_mime_words(c)) for c in (m.cc or [])]]

            attachments = []
            cid_map: dict = {}
            for att in (m.attachments or []):
                cid = (att.content_id or '').strip('<>')
                if cid and att.payload and att.content_type.startswith('image/'):
                    cid_map[cid] = f"data:{att.content_type};base64,{base64.b64encode(att.payload).decode()}"
                else:
                    entry = {
                        'filename': att.filename or 'attachment',
                        'content_type': att.content_type,
                        'size': len(att.payload or b''),
                    }
                    # Файл сохраняем сразу, пока он у нас в руках: скачивание
                    # потом не тянет с почтового сервера всё письмо заново.
                    if att.payload and len(att.payload) <= MAIL_ATTACHMENT_STORE_MAX:
                        key = _mail_blob_key(account['id'], folder, m.uid, len(attachments))
                        if _store_mail_blob(key, att.payload, att.content_type):
                            entry['stored'] = key
                    attachments.append(entry)

            body_html = m.html or ''
            if cid_map and body_html:
                for cid, data_uri in cid_map.items():
                    body_html = body_html.replace(f'cid:{cid}', data_uri)

            msg_dict = {
                'account_id': account['id'],
                'uid': str(m.uid),
                'folder': folder,
                'message_id': msg_id_hdr,
                'thread_id': thread_id or msg_id_hdr,
                'subject': _decode_mime_words(m.subject or ''),
                'from_addr': frm_addr,
                'from_name': frm_name or frm_addr,
                'to_addrs': to_list,
                'cc_addrs': cc_list,
                'bcc_addrs': [],
                'body_text': m.text or '',
                'body_html': body_html,
                'attachments': attachments,
                'is_read': '\\Seen' in (m.flags or []),
                'is_starred': '\\Flagged' in (m.flags or []),
                'is_draft': folder.upper() in ('DRAFTS', '[GMAIL]/DRAFTS', 'DRAFT'),
                'date': m.date,
            }
            try:
                saved = db.upsert_email_message(msg_dict)
                if saved:
                    synced.append(saved)
            except Exception as de:
                logger.debug(f"[Mail] DB upsert error: {de}")
                failed_count += 1
        logger.debug(f"[Mail] New: {len(synced)}, already existed: {fetched_count - len(synced) - failed_count}, failed: {failed_count}")
        return synced, fetched_count, failed_count, None
    except Exception as e:
        err = str(e)
        logger.debug(f"[Mail] IMAP sync error ({account.get('email')}): {err}")
        return [], fetched_count, failed_count, err


def _mail_message_for_client(message: dict) -> dict:
    """Add stable download URLs without storing remote attachment payloads in DB."""
    result = snake_to_camel(message)
    attachments = result.get('attachments') or []
    result['attachments'] = [
        {**attachment, 'url': f"/api/mail/messages/{result['id']}/attachments/{index}"}
        for index, attachment in enumerate(attachments)
    ]
    return result


def _set_imap_flags(account: dict, folder: str, uid: str, updates: dict) -> None:
    """Apply state changes to IMAP before mirroring them locally."""
    if not uid or not updates:
        return
    port = int(account.get('imap_port', 993))
    # Без таймаута зависший почтовый сервер держал поток навсегда.
    client = imaplib.IMAP4_SSL(account['imap_host'], port, timeout=20) if port == 993 else imaplib.IMAP4(account['imap_host'], port, timeout=20)
    try:
        if port != 993 and account.get('use_ssl', True):
            client.starttls()
        client.login(account['username'], _deobfuscate_pw(account['password_enc']))
        status, _ = client.select(_wire(folder or 'INBOX'))
        if status != 'OK':
            raise RuntimeError(f"Cannot select IMAP folder {folder}")
        for field, flag in (('is_read', r'\Seen'), ('is_starred', r'\Flagged')):
            if field not in updates:
                continue
            operation = '+FLAGS.SILENT' if updates[field] else '-FLAGS.SILENT'
            status, _ = client.uid('STORE', str(uid), operation, f'({flag})')
            if status != 'OK':
                raise RuntimeError(f"Cannot update IMAP flag {flag}")
    finally:
        try:
            client.logout()
        except Exception:
            pass


def _read_uploaded_file(url: str) -> Optional[bytes]:
    """Resolve an /api/uploads/<name> URL (from /api/upload) back to raw bytes,
    whether the file lives on local disk or in S3."""
    filename = Path(url).name
    if not filename:
        return None
    if not s3_storage.enabled:
        local_path = UPLOAD_DIR / "uploads" / filename
        return local_path.read_bytes() if local_path.exists() else None
    obj = s3_storage.get_object(f"uploads/{filename}")
    return obj['Body'].read() if obj else None


def _read_forwarded_mail_attachment(url: str) -> Optional[bytes]:
    """Пересылка: вложение исходного письма (/api/mail/messages/<id>/attachments/<n>)
    берём из хранилища почты, а не просим загрузить заново."""
    m = re.match(r'^/api/mail/messages/([^/]+)/attachments/(\d+)$', url or '')
    if not m:
        return None
    message = db.get_email_message(m.group(1))
    atts = (message or {}).get('attachments') or []
    index = int(m.group(2))
    if index >= len(atts):
        return None
    key = (atts[index] or {}).get('stored')
    return _read_mail_blob(key) if key else None


def _append_to_sent(account: dict, raw: bytes) -> None:
    try:
        sent = _special_folders(account).get('sent')
        if not sent:
            return
        conn = _imap_connect(account)
        try:
            conn.append(_wire(sent), r'(\Seen)', imaplib.Time2Internaldate(time.time()), raw)
        finally:
            try:
                conn.logout()
            except Exception:
                pass
        _sync_folder_imap(account, sent)
        sse_manager.push(str(account['user_id']), {'type': 'mail_changed', 'accountId': str(account['id']), 'folder': sent})
    except Exception as e:
        logger.debug(f"[SMTP] копия в «Отправленные» не легла: {e}")


def _send_smtp(account: dict, to: list, subject: str, body_text: str, body_html: str = '',
               cc: list = None, bcc: list = None, reply_to_msg_id: str = None,
               attachments: list = None) -> dict:
    """Send email via SMTP. Returns {success, message_id}."""
    pw = _deobfuscate_pw(account['password_enc'])
    msg = MIMEMultipart('mixed' if attachments else 'alternative')
    msg['From'] = formataddr((account.get('name', ''), account['email']))
    msg['To'] = ', '.join(to)
    if cc:
        msg['Cc'] = ', '.join(cc)
    msg['Subject'] = subject
    msg_id = make_msgid()
    msg['Message-ID'] = msg_id
    if reply_to_msg_id:
        msg['In-Reply-To'] = reply_to_msg_id
        msg['References'] = reply_to_msg_id

    if attachments:
        # 'mixed' root needs the text/html alternative nested so mail clients
        # still render the body instead of showing it as another attachment.
        body_part = MIMEMultipart('alternative')
        body_part.attach(MIMEText(body_text, 'plain', 'utf-8'))
        if body_html:
            body_part.attach(MIMEText(body_html, 'html', 'utf-8'))
        msg.attach(body_part)
        for att in attachments:
            try:
                data = _read_forwarded_mail_attachment(att.get('url', '')) or _read_uploaded_file(att.get('url', ''))
                if data is None:
                    continue
                name = att.get('filename') or att.get('name') or 'file'
                # Настоящий тип файла: с octet-stream у получателя не было
                # предпросмотра фото и PDF. Имя — по RFC 2231 (кириллица).
                mime = att.get('mimeType') or att.get('content_type') or _mimetypes.guess_type(name)[0] or 'application/octet-stream'
                maintype, _, subtype = mime.partition('/')
                part = MIMEBase(maintype or 'application', subtype or 'octet-stream', name=('utf-8', '', name))
                part.set_payload(data)
                email_encoders.encode_base64(part)
                part.add_header('Content-Disposition', 'attachment', filename=('utf-8', '', name))
                msg.attach(part)
            except Exception as e:
                logger.debug(f"[SMTP] Skipping attachment {att.get('filename')}: {e}")
    else:
        msg.attach(MIMEText(body_text, 'plain', 'utf-8'))
        if body_html:
            msg.attach(MIMEText(body_html, 'html', 'utf-8'))

    all_to = list(to) + (cc or []) + (bcc or [])
    try:
        use_ssl = account.get('use_ssl', True)
        port = account.get('smtp_port', 587)
        logger.debug(f"[SMTP] Connecting to {account['smtp_host']}:{port} ssl={use_ssl} user={account['username']}")
        # 15 с не хватало, чтобы отдать письмо с файлами в десятки мегабайт.
        timeout = 120 if attachments else 30
        if use_ssl and port == 465:
            server = smtplib.SMTP_SSL(account['smtp_host'], port, timeout=timeout)
        elif use_ssl:
            server = smtplib.SMTP(account['smtp_host'], port, timeout=timeout)
            server.ehlo()
            server.starttls()
            server.ehlo()
        else:
            server = smtplib.SMTP(account['smtp_host'], port, timeout=timeout)
            server.ehlo()
        server.login(account['username'], pw)
        logger.debug(f"[SMTP] Login OK, sending to {all_to}")
        raw = msg.as_bytes()
        server.sendmail(account['email'], all_to, raw)
        server.quit()
        logger.debug(f"[SMTP] Sent OK, message_id={msg_id}")
        # Копия в «Отправленные» на почтовом сервере — чтобы письмо было видно
        # и в телефоне, и в любом другом клиенте. Фоном: отправку не задерживает.
        _threading.Thread(target=_append_to_sent, args=(dict(account), raw), daemon=True).start()
        return {'success': True, 'message_id': msg_id}
    except Exception as e:
        logger.debug(f"[SMTP] Error: {e}")
        return {'success': False, 'error': str(e)}


MAIL_FOLDERS = ['INBOX', 'SENT', 'DRAFTS', 'SPAM', 'TRASH']


def _route_emails_to_chats(new_emails: list, user_id: str, account_id: str) -> int:
    """
    For each newly synced email, check email_chat_rules and #Отзывы chat.
    Creates a chat message for every matching email.
    Returns number of messages routed.
    """
    if not new_emails:
        return 0

    routed = 0
    try:
        # Load rules for this user
        rules = db.get_email_chat_rules(user_id) if hasattr(db, 'get_email_chat_rules') else []

        # Find #Отзывы chat for this user (fallback when no rule matches)
        reviews_chat_id = None
        try:
            all_user_chats = db.get_chats(user_id=user_id)
            for c in all_user_chats:
                if (c.get('title') or '').strip() == '#Отзывы':
                    reviews_chat_id = c['id']
                    break
        except Exception:
            pass

        for email in new_emails:
            from_addr = (email.get('from_addr') or '').lower().strip()
            subject   = email.get('subject') or '(без темы)'
            from_name = email.get('from_name') or from_addr
            body      = (email.get('body_text') or '').strip()
            email_date = email.get('date') or email.get('fetched_at') or ''

            # Find target chat: first rule where email_pattern AND optional keyword match
            target_chat_id = None
            for rule in rules:
                pattern = (rule.get('email_pattern') or '').lower().strip()
                if not pattern:
                    continue
                # Exact address OR domain match (@domain.com)
                addr_match = (
                    from_addr.endswith(pattern) if pattern.startswith('@')
                    else from_addr == pattern
                )
                if not addr_match:
                    continue
                # Optional keyword: must appear in subject OR body (case-insensitive)
                keyword = (rule.get('keyword') or '').strip()
                if keyword:
                    kw_low = keyword.lower()
                    if kw_low not in subject.lower() and kw_low not in body.lower():
                        continue
                target_chat_id = rule['chat_id']
                break

            if not target_chat_id:
                continue

            # Build message content
            preview = body[:800] + ('…' if len(body) > 800 else '') if body else ''
            content_parts = [
                subject,
                f"От: {from_name} <{from_addr}>",
            ]
            if preview:
                content_parts.append(f"\n{preview}")
            content = '\n'.join(content_parts)

            # Check chat exists
            chat = db.get_chat(target_chat_id)
            if not chat:
                continue

            # Post as the account owner but flagged as system/email so UI can style it differently
            msg_id = str(__import__('uuid').uuid4())
            new_msg = {
                'id': msg_id,
                'chat_id': target_chat_id,
                'author_id': user_id,
                'author_name': 'Система',
                'is_system_message': True,
                'content': content,
                'metadata': {
                    'emailSource': True,
                    'emailFrom': from_addr,
                    'emailFromName': from_name,
                    'emailSubject': subject,
                    'emailDate': str(email_date),
                    'emailAccountId': account_id,
                    'emailMessageId': str(email.get('id', '')),
                },
                'created_at': datetime.now(timezone.utc).isoformat(),
            }
            try:
                if not db.add_message(new_msg):
                    logger.debug(f"[mail-bridge] failed to persist email-sourced message for chat {target_chat_id}")
                    continue
                # Update chat's last message
                db.update_chat(target_chat_id, {
                    'last_message_id': msg_id,
                    'updated_at': datetime.now(timezone.utc).isoformat(),
                })
                # Push SSE to all chat participants
                try:
                    chat_obj = db.get_chat(target_chat_id)
                    if chat_obj:
                        camel_msg = snake_to_camel(new_msg)
                        sse_manager.push_to_chat(chat_obj, '', {
                            'type': 'new_message',
                            'chatId': target_chat_id,
                            'messageId': msg_id,
                            'message': camel_msg,
                        })
                except Exception as sse_err:
                    logger.debug(f"[EmailRoute] SSE push failed: {sse_err}")
                routed += 1
            except Exception as e:
                logger.debug(f"[EmailRoute] Failed to post message to chat {target_chat_id}: {e}")
    except Exception as e:
        logger.debug(f"[EmailRoute] Routing error: {e}")

    return routed


def _mail_light(message: dict) -> dict:
    """Строка списка: без тел письма (десятки килобайт HTML на строку), с
    коротким отрывком текста."""
    out = _mail_message_for_client(message)
    text = out.pop('bodyText', '') or ''
    html = out.pop('bodyHtml', None) or ''
    if not str(text).strip() and html:
        # Письмо только в HTML: отрывок — видимый текст без стилей и тегов.
        html = re.sub(r'(?is)<(style|script|head)[^>]*>.*?</\1>', ' ', str(html))
        text = _html_unescape(re.sub(r'(?s)<[^>]+>', ' ', html))
    out['snippet'] = ' '.join(str(text).split())[:180]
    return out
