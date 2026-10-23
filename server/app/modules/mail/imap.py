from __future__ import annotations

import re as _re_mail
import time as _time
from typing import Dict, List, Optional

from fastapi import HTTPException
from imap_tools.imap_utf7 import utf7_decode
from imap_tools.utils import encode_folder

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


# Имена папок: в базе, API и imap_tools — человеческие («Отправленные»); на проводе IMAP — в
# modified UTF-7 и в кавычках (`"&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"`). Голое имя в imaplib ломалось
# на пробелах («Sent Items»), а закодированное, отданное в imap_tools, кодировалось второй раз —
# сервер такой папки не находил, и синхронизация молча читала «Входящие».
def _wire(folder: str) -> bytes:
    """Имя папки для прямой команды imaplib (SELECT, MOVE, COPY, APPEND)."""
    return encode_folder(folder or 'INBOX')


_LIST_RE = _re_mail.compile(r'\((?P<flags>[^)]*)\)\s+(?P<delim>NIL|"(?:[^"\\]|\\.)*")\s+(?P<name>.*)$', _re_mail.I)


def _unquote(s: str) -> str:
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return _re_mail.sub(r'\\(.)', r'\1', s[1:-1])
    return s


def _list_folders(conn) -> List[dict]:
    """Все папки ящика: имя (человеческое), разделитель уровней, флаги. Папки-контейнеры
    (\\Noselect) и несуществующие (\\NonExistent) отброшены — открыть их нельзя."""
    typ, data = conn.list()
    out: List[dict] = []
    for item in data or []:
        if isinstance(item, tuple):  # имя пришло литералом {N} — отдельной частью
            head, raw_name = item[0], item[1]
        elif isinstance(item, bytes):
            head, raw_name = item, None
        else:
            continue
        m = _LIST_RE.match(head.decode('utf-8', 'replace').strip())
        if not m:
            continue
        flags = m.group('flags').lower().split()
        if '\\noselect' in flags or '\\nonexistent' in flags:
            continue
        delim = m.group('delim')
        delim = '' if delim.upper() == 'NIL' else _unquote(delim)
        raw = raw_name if raw_name is not None else _unquote(m.group('name').strip()).encode()
        name = utf7_decode(raw)
        if name:
            out.append({'name': name, 'delim': delim, 'flags': flags})
    return out


# Спецпапки сервера (RFC 6154): настоящие имена «Отправленных», «Корзины»…
_special_cache: Dict[str, tuple] = {}


_SPECIAL_FLAGS = {'\\sent': 'sent', '\\drafts': 'drafts', '\\trash': 'trash', '\\junk': 'junk', '\\archive': 'archive'}


# Без флагов (старые Dovecot, Exchange) роль узнаём по имени последнего уровня:
# «INBOX.Sent», «INBOX/Отправленные» и «[Gmail]/Корзина» — те же папки.
_SPECIAL_NAMES = {
    'sent': 'sent', 'sent items': 'sent', 'sent messages': 'sent', 'sent mail': 'sent', 'отправленные': 'sent', 'отправленные письма': 'sent',
    'drafts': 'drafts', 'draft': 'drafts', 'черновики': 'drafts',
    'trash': 'trash', 'deleted': 'trash', 'deleted items': 'trash', 'deleted messages': 'trash', 'bin': 'trash',
    'корзина': 'trash', 'удаленные': 'trash', 'удалённые': 'trash',
    'junk': 'junk', 'junk e-mail': 'junk', 'junk email': 'junk', 'spam': 'junk', 'bulk mail': 'junk', 'спам': 'junk', 'нежелательная почта': 'junk',
    'archive': 'archive', 'archives': 'archive', 'архив': 'archive',
}

# Виртуальные папки Gmail («Вся почта», «Помеченные») повторяют письма других папок — в списке не нужны.
_VIRTUAL_FLAGS = {'\\all', '\\flagged', '\\important'}


def _path(f: dict) -> List[str]:
    parts = f['name'].split(f['delim']) if f['delim'] else [f['name']]
    if len(parts) > 1 and parts[0].upper() == 'INBOX':
        parts = parts[1:]  # «INBOX.Проекты» — это просто «Проекты»
    return parts


def _mail_folders(acc: dict, force: bool = False) -> tuple:
    """(роли спецпапок → имя, остальные папки [{folder, title, depth}]). Кэш на час: список папок
    меняется редко, а спецпапки нужны на каждый перенос письма."""
    key = str(acc['id'])
    cached = _special_cache.get(key)
    if cached and not force and _time.monotonic() - cached[1] < 3600:
        return cached[0], cached[2]
    conn = _imap_connect(acc)
    try:
        folders = _list_folders(conn)
    finally:
        try:
            conn.logout()
        except Exception:
            pass
    roles: Dict[str, str] = {'inbox': 'INBOX'}
    # Сначала флаги (надёжнее), потом имена: папка с флагом \Sent важнее папки, просто названной «Sent».
    for f in folders:
        role = next((_SPECIAL_FLAGS[x] for x in f['flags'] if x in _SPECIAL_FLAGS), None)
        if role and role not in roles:
            roles[role] = f['name']
    for f in folders:
        role = _SPECIAL_NAMES.get(_path(f)[-1].strip().lower())
        if role and role not in roles and f['name'] not in roles.values():
            roles[role] = f['name']
    taken = set(roles.values())
    others = []
    for f in folders:
        if f['name'].upper() == 'INBOX' or f['name'] in taken or _VIRTUAL_FLAGS & set(f['flags']):
            continue
        parts = _path(f)
        others.append({'folder': f['name'], 'title': parts[-1] or f['name'], 'depth': len(parts) - 1, 'sort': '\x00'.join(parts).lower()})
    others.sort(key=lambda x: x['sort'])
    for o in others:
        del o['sort']
    _special_cache[key] = (roles, _time.monotonic(), others)
    return roles, others


def _special_folders(acc: dict, force: bool = False) -> Dict[str, str]:
    return _mail_folders(acc, force)[0]
