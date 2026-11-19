"""Свои папки почты с правилами: поток писем раскладывается по папкам, как фильтры в Gmail.

Папка (mail_folders) — своя, не папка на почтовом сервере: письмо физически остаётся во «Входящих» ящика, а Шар
показывает его в папке, чьё правило подошло, и убирает из своих «Входящих». Так другие почтовые программы ничего не
теряют, а правило можно поменять задним числом — письма перераскладываются сразу.

Правило — строка mail_folder_rules.email_pattern (таблица уже есть на проде, схема не меняется):
  «from:текст»    — отправитель (адрес или имя) содержит текст; строка без приставки — то же самое (старые правила);
  «subject:текст» — тема содержит текст;
  «to:текст»      — среди получателей (кому, копия) есть адрес, содержащий текст.
Регистр не важен. Письмо, подходящее под несколько папок, видно в каждой.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException

from app.core.db import db
from app.core.security import Identity, current_identity
from app.modules.mail.imap import _owned_account

router = APIRouter()

FIELDS = ("from", "subject", "to")
# Папки, в которых правила действуют: входящие и отправленные (переписка с клиентом целиком). Корзина, спам, черновики —
# нет: удалённое не должно всплывать в папке.
ROUTED = ("INBOX", "SENT")


def parse(pattern: str) -> tuple[str, str]:
    raw = (pattern or "").strip()
    head, sep, rest = raw.partition(":")
    if sep and head.lower() in FIELDS:
        return head.lower(), rest.strip()
    return "from", raw


def compose(field: str, text: str) -> str:
    field = field if field in FIELDS else "from"
    return f"{field}:{text.strip()}"


def _like(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def match_sql(patterns: list[str], alias: str = "m") -> tuple[str, list[Any]]:
    """Условие «письмо подходит хотя бы под одно правило». Пустые правила не подходят ни подо что."""
    parts: list[str] = []
    params: list[Any] = []
    for pattern in patterns:
        field, text = parse(pattern)
        if not text:
            continue
        like = _like(text)
        if field == "subject":
            parts.append(f"{alias}.subject ILIKE %s")
            params.append(like)
        elif field == "to":
            parts.append(f"(COALESCE({alias}.to_addrs, '[]'::jsonb)::text ILIKE %s OR COALESCE({alias}.cc_addrs, '[]'::jsonb)::text ILIKE %s)")
            params += [like, like]
        else:
            parts.append(f"({alias}.from_addr ILIKE %s OR {alias}.from_name ILIKE %s)")
            params += [like, like]
    return ("(" + " OR ".join(parts) + ")" if parts else "FALSE"), params


def user_patterns(user_id: str, folder_id: Optional[str] = None) -> list[str]:
    return [r["email_pattern"] for r in db.get_mail_folder_rules(user_id, folder_id)]


def _search_sql(search: str, alias: str = "m") -> tuple[str, list[Any]]:
    if not search:
        return "", []
    like = _like(search)
    return (f" AND ({alias}.subject ILIKE %s OR {alias}.from_addr ILIKE %s OR {alias}.from_name ILIKE %s OR {alias}.body_text ILIKE %s)",
            [like, like, like, like])


def folder_messages(account_id: str, user_id: str, folder_id: str, limit: int, offset: int, search: str = "") -> list[dict]:
    cond, params = match_sql(user_patterns(user_id, folder_id))
    extra, extra_params = _search_sql(search)
    rows = db.conn.fetch_all(
        f"SELECT * FROM email_messages m WHERE m.account_id = %s AND upper(m.folder) = ANY(%s) AND {cond}{extra} "
        "ORDER BY m.date DESC NULLS LAST LIMIT %s OFFSET %s",
        (account_id, list(ROUTED), *params, *extra_params, limit, offset)) or []
    return [dict(r) for r in rows]


def inbox_messages(account_id: str, user_id: str, folder: str, limit: int, offset: int, search: str = "") -> Optional[list[dict]]:
    """«Входящие» без разложенного по папкам. Правил нет — None: пусть отвечает обычный путь."""
    patterns = user_patterns(user_id)
    if not patterns:
        return None
    cond, params = match_sql(patterns)
    extra, extra_params = _search_sql(search)
    rows = db.conn.fetch_all(
        f"SELECT * FROM email_messages m WHERE m.account_id = %s AND m.folder = %s AND NOT {cond}{extra} "
        "ORDER BY m.date DESC NULLS LAST LIMIT %s OFFSET %s",
        (account_id, folder, *params, *extra_params, limit, offset)) or []
    return [dict(r) for r in rows]


def routed_unread_in_inbox(account_id: str, user_id: str, folder: str = "INBOX") -> int:
    """Сколько непрочитанных «Входящих» ушло в свои папки — их не считаем во «Входящих»."""
    patterns = user_patterns(user_id)
    if not patterns:
        return 0
    cond, params = match_sql(patterns)
    row = db.conn.fetch_one(
        f"SELECT count(*)::int AS n FROM email_messages m WHERE m.account_id = %s AND m.folder = %s AND m.is_read = FALSE AND {cond}",
        (account_id, folder, *params))
    return int((row or {}).get("n") or 0)


def _unread_in(account_id: str, patterns: list[str]) -> int:
    cond, params = match_sql(patterns)
    row = db.conn.fetch_one(
        f"SELECT count(*)::int AS n FROM email_messages m WHERE m.account_id = %s AND upper(m.folder) = 'INBOX' AND m.is_read = FALSE AND {cond}",
        (account_id, *params))
    return int((row or {}).get("n") or 0)


def _rule_view(rule: dict) -> dict:
    field, text = parse(rule["email_pattern"])
    return {"id": str(rule["id"]), "field": field, "text": text}


@router.get("/api/mail/smart-folders")
def smart_folders(accountId: str, me: Identity = Depends(current_identity)):
    """Свои папки с правилами и числом непрочитанных в этом ящике."""
    _owned_account(accountId, me.user_id)
    rules = db.get_mail_folder_rules(me.user_id)
    by_folder: dict[str, list[dict]] = {}
    for r in rules:
        by_folder.setdefault(str(r["folder_id"]), []).append(r)
    out = []
    for f in db.get_mail_folders(me.user_id):
        fid = str(f["id"])
        own = by_folder.get(fid, [])
        out.append({"id": fid, "name": f["name"], "color": f.get("color") or "#3b82f6", "folder": f"custom:{fid}",
                    "rules": [_rule_view(r) for r in own], "unread": _unread_in(accountId, [r["email_pattern"] for r in own])})
    return out


def _own_folder(folder_id: str, user_id: str) -> dict:
    row = next((f for f in db.get_mail_folders(user_id) if str(f["id"]) == folder_id), None)
    if not row:
        raise HTTPException(status_code=404, detail="Папка не найдена")
    return row


@router.put("/api/mail/smart-folders/{folder_id}")
def save_folder(folder_id: str, body: dict, me: Identity = Depends(current_identity)):
    """Название, цвет и правила папки целиком: {name, color, rules: [{field, text}]}. Пустые правила отбрасываются."""
    folder = _own_folder(folder_id, me.user_id)
    name = str(body.get("name") or folder["name"]).strip()[:100]
    if not name:
        raise HTTPException(status_code=400, detail="Нужно название папки")
    color = str(body.get("color") or folder.get("color") or "#3b82f6")[:20]
    rules = body.get("rules")
    if rules is not None and not isinstance(rules, list):
        raise HTTPException(status_code=400, detail="rules — список")
    db.conn.execute_query("UPDATE mail_folders SET name = %s, color = %s WHERE id = %s AND user_id = %s", (name, color, folder_id, me.user_id))
    if rules is not None:
        wanted = []
        for r in rules[:50]:
            text = str((r or {}).get("text") or "").strip()[:200]
            if text:
                wanted.append(compose(str((r or {}).get("field") or "from"), text))
        db.conn.execute_query("DELETE FROM mail_folder_rules WHERE folder_id = %s AND user_id = %s", (folder_id, me.user_id))
        for pattern in dict.fromkeys(wanted):
            db.add_mail_folder_rule(me.user_id, folder_id, pattern)
    return {"ok": True}
