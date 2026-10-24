"""Пароли почтовых ящиков в базе.

Раньше они лежали в base64 — это не шифрование, а украшение: любой, кто видит
базу или её дамп, получал рабочие пароли ко всем ящикам сотрудников. Теперь —
Fernet (AES-128-CBC + HMAC) с ключом из SHAR_SECRET_KEY, формат `enc1:<токен>`.

Старые записи (base64) читаются как раньше и переписываются зашифрованными при
старте, когда ключ задан (migrate_legacy_passwords). Без ключа новые пароли
по-прежнему пишутся в base64 — с предупреждением в логе: сервис не ломаем, но и
делать вид, что это защита, не будем.
"""

from __future__ import annotations

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

log = logging.getLogger("shar.mail.crypto")

_PREFIX = "enc1:"
_warned = False

# Текст для человека: что делать, а не что сломалось. Отдаётся с кодом 409 (см. mailboxes, sync).
PASSWORD_HINT = "Пароль ящика нужно ввести заново: «Ящики» → ящик → новый пароль"


class MailPasswordUnavailable(RuntimeError):
    """Пароль ящика в базе есть, но расшифровать его нечем (ключ сменился или не задан) — это
    не сбой почтового сервера: нужно один раз ввести пароль заново."""


# Почтовый сервер отверг пароль (его сменили, истёк пароль приложения) — то же «введите пароль заново».
# Раньше это уходило клиенту как 502/500 «сервер не ответил», и человек не понимал, что из ящика выбило.
PASSWORD_REJECTED_HINT = "Почтовый сервер не принял пароль — введите новый: «Ящики» → ящик → пароль"
_AUTH_MARKERS = (
    'authenticationfailed', 'authentication failed', 'auth failed', 'login failed', 'logon failure',
    'invalid credentials', 'incorrect password', 'invalid login', 'bad credentials', 'login error',
    '[auth]', 'неверн',
)
# Ящики, чей пароль отверг почтовый сервер (в этом процессе). Снимается при удачном входе
# и при смене пароля; по нему /api/mail/accounts отдаёт needsPassword.
_rejected: set = set()


def is_auth_error(exc: BaseException) -> bool:
    if isinstance(exc, MailPasswordUnavailable) or type(exc).__name__ == 'MailboxLoginError':
        return True
    text = str(exc).lower()
    return any(m in text for m in _AUTH_MARKERS)


def mark_password(account_id, ok: bool) -> None:
    if ok:
        _rejected.discard(str(account_id))
    else:
        _rejected.add(str(account_id))


def needs_password(account: dict) -> bool:
    """Шар не может войти в ящик без нового пароля: расшифровать нечем или сервер его отверг."""
    if str(account.get('id')) in _rejected:
        return True
    try:
        _deobfuscate_pw(account.get('password_enc') or '')
    except MailPasswordUnavailable:
        return True
    return False


def _fernet() -> Fernet | None:
    if not settings.secret_key:
        return None
    key = base64.urlsafe_b64encode(hashlib.sha256(("shar-mail:" + settings.secret_key).encode()).digest())
    return Fernet(key)


def is_encrypted(stored: str) -> bool:
    return str(stored or "").startswith(_PREFIX)


def _obfuscate_pw(pw: str) -> str:
    """Пароль → значение для колонки password_enc."""
    global _warned
    f = _fernet()
    if f is None:
        if not _warned:
            _warned = True
            log.warning("SHAR_SECRET_KEY не задан: пароли почтовых ящиков хранятся в base64, а не шифруются")
        return base64.b64encode(pw.encode()).decode()
    return _PREFIX + f.encrypt(pw.encode()).decode()


def _deobfuscate_pw(pw_enc: str) -> str:
    if is_encrypted(pw_enc):
        f = _fernet()
        if f is None:
            raise MailPasswordUnavailable("Пароль ящика зашифрован, а SHAR_SECRET_KEY не задан")
        try:
            return f.decrypt(pw_enc[len(_PREFIX):].encode()).decode()
        except InvalidToken as exc:
            raise MailPasswordUnavailable("Не удалось расшифровать пароль ящика (другой SHAR_SECRET_KEY?)") from exc
    try:
        return base64.b64decode(pw_enc.encode()).decode()
    except Exception:
        return pw_enc


def migrate_legacy_passwords() -> int:
    """Переписать base64-пароли шифром. Нужен ключ; повторный запуск ничего не меняет."""
    from app.core.db import (
        db,  # noqa: PLC0415 — модуль поднимается раньше базы в тестах
    )

    if _fernet() is None:
        return 0
    rows = db.conn.fetch_all("SELECT id, password_enc FROM email_accounts") or []
    migrated = 0
    for row in rows:
        stored = row.get("password_enc") or ""
        if stored and not is_encrypted(stored):
            if db.conn.execute_query("UPDATE email_accounts SET password_enc = %s WHERE id = %s", (_obfuscate_pw(_deobfuscate_pw(stored)), row["id"])):
                migrated += 1
    if migrated:
        log.info("mail: %d пароль(ей) ящиков зашифровано", migrated)
    return migrated
