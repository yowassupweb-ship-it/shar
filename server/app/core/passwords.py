"""Проверка и хеширование паролей.

До этого пароли лежали в базе открытым текстом и сравнивались через ==.
Разом перехешировать их нельзя — исходные пароли известны только в открытом
виде и переписать их можно лишь в момент, когда пользователь введёт свой.
Поэтому здесь «прозрачное обновление»:

  * verify_password умеет и новый формат (PBKDF2), и старый (открытый текст);
  * needs_rehash говорит, что запись ещё в старом формате;
  * при успешном входе main.py молча перезаписывает пароль хешем.

Так никого не выбрасывает из системы и не требует смены пароля: каждый
пользователь мигрирует сам, при очередном входе.

PBKDF2-HMAC-SHA256 из стандартной библиотеки — чтобы не тащить bcrypt/argon2
на сервер с 2 ГБ памяти и не ломать деплой новой зависимостью.
"""

import hashlib
import hmac
import secrets
from typing import Optional

_ALGO = "pbkdf2_sha256"
_ITERATIONS = 200_000
_SALT_BYTES = 16


def hash_password(password: str) -> str:
    """Возвращает строку вида pbkdf2_sha256$<итерации>$<соль>$<хеш>."""
    salt = secrets.token_hex(_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), _ITERATIONS
    ).hex()
    return f"{_ALGO}${_ITERATIONS}${salt}${digest}"


def is_hashed(stored: Optional[str]) -> bool:
    return bool(stored) and str(stored).startswith(_ALGO + "$")


def needs_rehash(stored: Optional[str]) -> bool:
    """True, если пароль ещё в старом формате и его пора заменить хешем."""
    return bool(stored) and not is_hashed(stored)


def verify_password(supplied: Optional[str], stored: Optional[str]) -> bool:
    if not supplied or not stored:
        return False
    stored = str(stored)

    if is_hashed(stored):
        try:
            _, iterations, salt, digest = stored.split("$", 3)
            candidate = hashlib.pbkdf2_hmac(
                "sha256", supplied.encode("utf-8"), salt.encode("utf-8"), int(iterations)
            ).hex()
            return hmac.compare_digest(candidate, digest)
        except (ValueError, TypeError):
            return False

    # Устаревший формат: пароль хранится как есть. compare_digest, а не ==,
    # чтобы сравнение не зависело от длины совпавшего префикса.
    return hmac.compare_digest(supplied, stored)
