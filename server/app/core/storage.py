"""Хранилище файлов: S3 (если настроен) или локальный диск.

Всё, что работает с именами файлов от пользователя, идёт через safe_name() и
new_upload_name(): путь из запроса никогда не склеивается с каталогом как есть.
"""

from __future__ import annotations

import logging
import re
import uuid
from pathlib import Path

from fastapi import HTTPException

from app.config import settings
from app.core.s3 import S3Storage

log = logging.getLogger("shar.storage")

UPLOAD_DIR: Path = settings.uploads_dir
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

s3_storage = S3Storage()
log.info("Upload directory: %s; S3 %s", UPLOAD_DIR, "enabled, bucket " + s3_storage.bucket if s3_storage.enabled else "disabled (local disk)")

_UPLOAD_NAME = re.compile(r"^[0-9a-fA-F-]{36}(\.[A-Za-z0-9]{1,12})?$")
_EXT = re.compile(r"^\.[A-Za-z0-9]{1,12}$")


def safe_name(filename: str) -> str:
    """Имя файла из URL без каталогов; иное — 400 (а не молчаливая подмена)."""
    name = Path(filename or "").name
    if not name or name != filename or name in (".", "..") or "\x00" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    return name


def safe_ext(filename: str) -> str:
    """Расширение для нового файла: только буквы и цифры, иначе без расширения."""
    ext = Path(filename or "").suffix
    return ext.lower() if _EXT.match(ext) else ""


def new_upload_name(filename: str) -> str:
    return f"{uuid.uuid4()}{safe_ext(filename)}"


def is_upload_name(name: str) -> bool:
    """Имя, выданное нами при загрузке (uuid[.ext]) — других в uploads/ быть не должно."""
    return bool(_UPLOAD_NAME.match(name or ""))
