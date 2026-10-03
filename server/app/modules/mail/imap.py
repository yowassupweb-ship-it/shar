from __future__ import annotations

import re as _re_mail
import time as _time
from typing import Dict, Optional

from fastapi import HTTPException

from app.core.db import db
from app.modules.mail import idle as mail_realtime
from app.modules.mail.crypto import _deobfuscate_pw


def _mail_account_by_id(account_id: str) -> Optional[dict]:
    row = db.conn.fetch_one("SELECT * FROM email_accounts WHERE id = %s", (account_id,))
    return dict(row) if row else None


def _owned_account(account_id: str, user_id: str) -> dict:
    """Ящик, принадлежащий пользователю; чужой или несуществующий — одинаковый 404."""
    acc = _mail_account_by_id(account_id)
    if not acc or str(acc.get('user_id')) != str(user_id):
        raise HTTPException(status_code=404, detail="Account not found")
    return acc


def _imap_connect(acc: dict):
    return mail_realtime._connect(acc, _deobfuscate_pw(acc['password_enc']))


# Спецпапки сервера (RFC 6154): настоящие имена «Отправленных», «Корзины»…
_special_cache: Dict[str, tuple] = {}


_SPECIAL_FLAGS = {'\\sent': 'sent', '\\drafts': 'drafts', '\\trash': 'trash', '\\junk': 'junk', '\\archive': 'archive'}


_SPECIAL_NAMES = {'sent': 'sent', 'sent items': 'sent', 'отправленные': 'sent', 'drafts': 'drafts', 'черновики': 'drafts',
                  'trash': 'trash', 'deleted items': 'trash', 'корзина': 'trash', 'junk': 'junk', 'spam': 'junk',
                  'спам': 'junk', 'archive': 'archive', 'архив': 'archive'}


def _special_folders(acc: dict, force: bool = False) -> Dict[str, str]:
    key = str(acc['id'])
    cached = _special_cache.get(key)
    if cached and not force and _time.monotonic() - cached[1] < 3600:
        return cached[0]
    roles: Dict[str, str] = {'inbox': 'INBOX'}
    conn = _imap_connect(acc)
    try:
        typ, data = conn.list()
        for raw in data or []:
            line = raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else str(raw)
            m = _re_mail.match(r'\((?P<flags>[^)]*)\)\s+"[^"]*"\s+"?(?P<name>[^"]+)"?', line)
            if not m:
                continue
            name = m.group('name')
            flags = m.group('flags').lower().split()
            role = next((_SPECIAL_FLAGS[f] for f in flags if f in _SPECIAL_FLAGS), None) or _SPECIAL_NAMES.get(name.lower())
            if role and role not in roles:
                roles[role] = name
    finally:
        try:
            conn.logout()
        except Exception:
            pass
    _special_cache[key] = (roles, _time.monotonic())
    return roles
