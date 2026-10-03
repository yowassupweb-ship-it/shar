from __future__ import annotations

import logging
import re as _re_mail
from typing import Dict

from app.core.db import db
from app.core.realtime import sse_manager
from app.modules.mail import idle as mail_realtime
from app.modules.mail.crypto import _deobfuscate_pw
from app.modules.mail.imap import _imap_connect, _mail_account_by_id
from app.modules.mail.service import _route_emails_to_chats, _sync_folder_imap

logger = logging.getLogger(__name__)


def _refresh_mail_flags(acc: dict, folder: str = 'INBOX', window: int = 300) -> int:
    """Флаги и удаления с сервера → в базу: прочитали или удалили письмо на
    телефоне — у нас оно тоже прочитано или пропало."""
    rows = db.conn.fetch_all(
        "SELECT id, uid, is_read, is_starred FROM email_messages WHERE account_id = %s AND folder = %s "
        "AND uid IS NOT NULL AND uid ~ '^[0-9]+$' ORDER BY uid::bigint DESC LIMIT %s",
        (acc['id'], folder, window),
    ) or []
    if not rows:
        return 0
    conn = _imap_connect(acc)
    try:
        typ, _ = conn.select(folder, readonly=True)
        if typ != 'OK':
            return 0
        typ, data = conn.uid('FETCH', ','.join(str(r['uid']) for r in rows), '(FLAGS)')
        if typ != 'OK':
            return 0
        typ, found = conn.uid('SEARCH', None, 'ALL')
        server_uids = [int(x) for x in (found[0].split() if typ == 'OK' and found and found[0] else [])]
    finally:
        try:
            conn.logout()
        except Exception:
            pass
    present: Dict[str, str] = {}
    for item in data or []:
        if isinstance(item, tuple):
            item = item[0]
        line = item.decode('utf-8', 'replace') if isinstance(item, bytes) else str(item or '')
        m_uid = _re_mail.search(r'UID (\d+)', line)
        m_flags = _re_mail.search(r'FLAGS \(([^)]*)\)', line)
        if m_uid:
            present[m_uid.group(1)] = m_flags.group(1) if m_flags else ''
    if not present or not server_uids:
        return 0  # пустой ответ — не повод что-то стирать
    # Сервер хранит не всё: старые письма он мог удалить сам, и тогда Шар —
    # их единственная копия (так и есть: у ящика на сервере ~10 писем, у нас
    # сотни). Убираем письмо, только если оно пропало внутри окна, которое
    # сервер ещё хранит, — значит, его удалили или перенесли руками.
    oldest_on_server = min(server_uids)
    changed = 0
    for r in rows:
        flags = present.get(str(r['uid']))
        if flags is None:
            if int(r['uid']) > oldest_on_server:
                db.conn.execute_query("DELETE FROM email_messages WHERE id = %s", (r['id'],))
                changed += 1
            continue
        is_read = '\\Seen' in flags
        is_starred = '\\Flagged' in flags
        if bool(r['is_read']) != is_read or bool(r['is_starred']) != is_starred:
            db.conn.execute_query("UPDATE email_messages SET is_read = %s, is_starred = %s WHERE id = %s", (is_read, is_starred, r['id']))
            changed += 1
    return changed


def _mail_summary(m: dict) -> dict:
    text = (m.get('body_text') or '').strip()
    date = m.get('date')
    return {
        'id': str(m.get('id')), 'subject': m.get('subject') or '', 'fromName': m.get('from_name') or '',
        'fromAddr': m.get('from_addr') or '', 'date': date.isoformat() if hasattr(date, 'isoformat') else str(date or ''),
        'snippet': ' '.join(text.split())[:160],
    }


def _mail_on_new(acc: dict) -> None:
    synced, _fetched, _failed, error = _sync_folder_imap(acc, 'INBOX')
    if error:
        raise RuntimeError(error)
    if not synced:
        return
    try:
        _route_emails_to_chats(synced, str(acc['user_id']), str(acc['id']))
    except Exception as e:
        logger.debug(f"[Mail] маршрутизация в чаты: {e}")
    sse_manager.push(str(acc['user_id']), {
        'type': 'mail_new', 'accountId': str(acc['id']), 'folder': 'INBOX', 'count': len(synced),
        'messages': [_mail_summary(m) for m in synced[:5]],
    })


def _mail_on_changed(acc: dict) -> None:
    if _refresh_mail_flags(acc, 'INBOX'):
        sse_manager.push(str(acc['user_id']), {'type': 'mail_changed', 'accountId': str(acc['id']), 'folder': 'INBOX'})


mail_realtime.configure(mail_realtime.Hooks(
    accounts=lambda: [dict(r) for r in (db.conn.fetch_all("SELECT * FROM email_accounts") or [])],
    account=_mail_account_by_id,
    password=lambda acc: _deobfuscate_pw(acc['password_enc']),
    on_new=_mail_on_new,
    on_changed=_mail_on_changed,
))


_ROLE_TITLES = {'inbox': 'Входящие', 'sent': 'Отправленные', 'drafts': 'Черновики', 'junk': 'Спам', 'trash': 'Корзина', 'archive': 'Архив'}
