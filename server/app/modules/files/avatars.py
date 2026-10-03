"""Аватары пользователей: загрузка, удаление, отдача.

Хранение — S3, если настроен, иначе локальный диск (UPLOAD_DIR/avatars).
Менять аватар можно только себе (админ — любому): раньше userId брался из формы."""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from app.core.db import db
from app.core.security import Identity, current_identity, ensure_self_or_admin
from app.core.storage import UPLOAD_DIR, s3_storage, safe_name

router = APIRouter()
logger = logging.getLogger(__name__)

AVATARS_DIR = UPLOAD_DIR / "avatars"
AVATARS_DIR.mkdir(parents=True, exist_ok=True)

MAX_AVATAR_BYTES = 5 * 1024 * 1024
_SIGNATURES = (
    (b"\xff\xd8\xff", ".jpg", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", ".png", "image/png"),
    (b"GIF87a", ".gif", "image/gif"),
    (b"GIF89a", ".gif", "image/gif"),
)


def _sniff_image(head: bytes) -> tuple[str, str] | None:
    """(расширение, mime) по сигнатуре файла: заявленный клиентом Content-Type не доверяем."""
    for sig, ext, mime in _SIGNATURES:
        if head.startswith(sig):
            return ext, mime
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp", "image/webp"
    return None


def _forget_avatars(user_id: str) -> bool:
    deleted = False
    if s3_storage.enabled:
        deleted = s3_storage.delete_prefix(f"avatars/{user_id}_") > 0
    for old_file in AVATARS_DIR.glob(f"{user_id}_*"):
        old_file.unlink(missing_ok=True)
        deleted = True
    return deleted


@router.post("/api/avatars")
def upload_avatar(file: UploadFile = File(...), userId: str = Form(...), me: Identity = Depends(current_identity)):
    """Загрузка аватара пользователя."""
    ensure_self_or_admin(me, userId)
    if not db.get_user_by_id(userId):
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    data = file.file.read(MAX_AVATAR_BYTES + 1)
    if len(data) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Файл слишком большой. Максимум 5MB")
    sniffed = _sniff_image(data[:16])
    if not sniffed:
        raise HTTPException(status_code=400, detail="Неподдерживаемый формат. Разрешены: JPG, PNG, GIF, WebP")
    ext, mime = sniffed

    unique_filename = f"{userId}_{uuid.uuid4()}{ext}"
    try:
        _forget_avatars(userId)
        if s3_storage.enabled:
            import io
            key = f"avatars/{unique_filename}"
            s3_storage.upload_fileobj(io.BytesIO(data), key, mime)
            avatar_url = s3_storage.public_url(key)
        else:
            (AVATARS_DIR / unique_filename).write_bytes(data)
            avatar_url = f"/api/avatars/file/{unique_filename}"
        db.update_user(userId, {"avatar": avatar_url})
    except HTTPException:
        raise
    except Exception:
        logger.exception("avatar upload failed for %s", userId)
        raise HTTPException(status_code=502, detail="Не удалось сохранить аватар")
    return {"success": True, "avatarUrl": avatar_url, "message": "Аватар успешно загружен"}


@router.delete("/api/avatars")
def delete_avatar(userId: str, me: Identity = Depends(current_identity)):
    """Удаление аватара пользователя."""
    ensure_self_or_admin(me, userId)
    try:
        deleted = _forget_avatars(userId)
        db.update_user(userId, {"avatar": None})
    except Exception:
        logger.exception("avatar delete failed for %s", userId)
        raise HTTPException(status_code=502, detail="Не удалось удалить аватар")
    return {"success": True, "deleted": deleted, "message": "Аватар удален"}


@router.get("/api/avatars/file/{filename}")
def get_avatar_file(filename: str):
    # Адрес с /file/ лежит в базе у пользователей, загрузивших аватар до v2.
    return get_avatar(filename)


@router.get("/api/avatars/{filename}")
def get_avatar(filename: str):
    """Файл аватара."""
    filename = safe_name(filename)
    headers = {"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"}
    if s3_storage.enabled:
        obj = s3_storage.get_object(f"avatars/{filename}")
        if obj is not None:
            media_type = obj.get("ContentType") or "application/octet-stream"
            if obj.get("ContentLength"):
                headers["Content-Length"] = str(obj["ContentLength"])
            return StreamingResponse(obj["Body"], media_type=media_type, headers=headers)

    file_path = AVATARS_DIR / filename
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Avatar not found")
    return FileResponse(file_path, headers=headers)
