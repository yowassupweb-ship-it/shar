from __future__ import annotations

import io
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.core.security import Identity, current_identity
from app.core.storage import (
    UPLOAD_DIR,
    is_upload_name,
    new_upload_name,
    s3_storage,
    safe_name,
)
from app.modules.files import thumbs as media_thumbs

router = APIRouter()

logger = logging.getLogger(__name__)


def _get_upload_size(upload: UploadFile) -> int:
    stream = upload.file
    current_pos = stream.tell()
    stream.seek(0, os.SEEK_END)
    size = stream.tell()
    stream.seek(current_pos)
    return int(size)


_ffmpeg_missing_warned = False
_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}


def _transcode_voice_to_aac(content: bytes, filename: str) -> Optional[tuple]:
    """Voice notes are recorded client-side in whatever the browser's
    MediaRecorder supports — audio/webm;codecs=opus on Chrome/Firefox/Android,
    audio/mp4 (AAC) on Safari/iOS. iOS Safari cannot decode WebM at all (no
    container support, not a missing-codec issue), so a voice message
    recorded on Android played silence-with-runaway-timer on an iPhone: the
    <audio> element never manages to parse the container, so 'ended' never
    fires and currentTime free-runs. Re-encoding every WebM/Ogg voice note to
    AAC-in-M4A server-side (a format every platform here already plays) fixes
    playback for everyone, not just a client-side workaround.
    Returns (new_content_bytes, new_filename, content_type) or None if
    transcoding wasn't needed/possible (missing ffmpeg on the server is
    logged once and treated as a no-op, not a hard failure — voice messages
    keep working exactly as before until ffmpeg is installed)."""
    global _ffmpeg_missing_warned
    ext = Path(filename).suffix.lower()
    if not filename.startswith('voice-') or ext not in ('.webm', '.ogg'):
        return None
    if not shutil.which('ffmpeg'):
        if not _ffmpeg_missing_warned:
            _ffmpeg_missing_warned = True
            logger.warning(
                "[Upload] ffmpeg not found on PATH — voice messages recorded as "
                "WebM/Opus (Chrome/Firefox/Android) will be silent on iOS Safari. "
                "Install ffmpeg on the server (apt install ffmpeg) to fix this."
            )
        return None
    with tempfile.TemporaryDirectory() as tmp:
        in_path = Path(tmp) / filename
        in_path.write_bytes(content)
        out_path = in_path.with_suffix('.m4a')
        try:
            result = subprocess.run(
                ['ffmpeg', '-y', '-i', str(in_path), '-vn', '-c:a', 'aac', '-b:a', '64k', str(out_path)],
                capture_output=True, timeout=30,
            )
        except Exception as e:
            logger.error(f"[Upload] Voice transcode to AAC failed: {e}")
            return None
        if result.returncode != 0 or not out_path.exists():
            logger.error(f"[Upload] ffmpeg exited {result.returncode}: {result.stderr.decode(errors='replace')[:300]}")
            return None
        new_filename = Path(filename).with_suffix('.m4a').name
        return out_path.read_bytes(), new_filename, 'audio/mp4'


# Uploaded files are served back from this app's own origin (see
# get_uploaded_file below), so anything the browser would execute as HTML —
# an uploaded .html page, or an .svg (SVG can carry <script>) — is a stored
# XSS vector: upload once, share the resulting /api/uploads/... link, and it
# runs as this origin for whoever opens it. Neither the upload nor S3 path
# actually needs the original content-type for these — they're served for
# download, not rendered — so both are normalized to a inert type.
_HTML_EXECUTABLE_EXTENSIONS = {'.html', '.htm', '.xhtml', '.shtml', '.svg', '.svgz', '.xml', '.mhtml'}


# SVG показываем как картинку (в <img> он скриптов не исполняет), но только через наш адрес и с жёсткой песочницей:
# откроют адрес напрямую — страница без скриптов, форм и доступа к нашему origin. Хранится он по-прежнему как
# application/octet-stream, поэтому прямая ссылка на S3 в <img> не рисуется — наружу отдаём адрес /api/uploads/….
_SVG_EXTENSIONS = {'.svg', '.svgz'}
_SVG_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
    'Cache-Control': 'public, max-age=3600',
}


def _is_svg(name: str) -> bool:
    return Path(name or '').suffix.lower() in _SVG_EXTENSIONS


def _neutralize_html_content_type(filename: str, content_type: Optional[str]) -> Optional[str]:
    ext = Path(filename or '').suffix.lower()
    ct = (content_type or '').lower()
    if ext in _HTML_EXECUTABLE_EXTENSIONS or ct in ('text/html', 'application/xhtml+xml', 'image/svg+xml'):
        return 'application/octet-stream'
    return content_type


async def _read_limited(file: UploadFile) -> bytes:
    """Читает тело загрузки, не позволяя ему вырасти выше лимита (а не после того, как оно в памяти)."""
    limit = settings.max_upload_bytes
    chunks, total = [], 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413, detail="Файл слишком большой")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/api/upload")
async def upload_file(file: UploadFile = File(...), me: Identity = Depends(current_identity)):
    """Загрузка файла в S3 или на локальный диск, если S3 не настроен."""
    orig_filename = file.filename or ""
    content = await _read_limited(file)
    content_type = file.content_type

    transcoded = await run_in_threadpool(_transcode_voice_to_aac, content, orig_filename)
    effective_filename = orig_filename
    if transcoded:
        content, effective_filename, content_type = transcoded

    return await run_in_threadpool(save_upload_bytes, effective_filename, content, content_type, me.user_id)


def save_upload_bytes(effective_filename: str, content: bytes, content_type: Optional[str], user_id: str) -> dict:
    """Сохранить готовые байты как загрузку (S3 или локальный диск) — для ручки загрузки и для того, что делают
    агенты «Ядра» (картинки): у файла тот же адрес /api/uploads/…, что у вложений чата."""
    content_type = _neutralize_html_content_type(effective_filename, content_type)
    unique_filename = new_upload_name(effective_filename)
    key = f"uploads/{unique_filename}"
    proxy_url = f"/api/uploads/{unique_filename}"
    ftype = "image" if Path(effective_filename).suffix.lower() in _IMAGE_EXTENSIONS else "file"

    if not s3_storage.enabled:
        local_path = UPLOAD_DIR / "uploads" / unique_filename
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(content)
        logger.info("[Upload] local %s (%d bytes) by %s", key, len(content), user_id)
        return {"success": True, "url": proxy_url, "filename": effective_filename, "key": key,
                "size": len(content), "storage": "local", "type": ftype}
    try:
        size = s3_storage.upload_fileobj(io.BytesIO(content), key, content_type)
    except Exception:
        logger.exception("[Upload] S3 upload failed for %s", key)
        raise HTTPException(status_code=502, detail="Не удалось сохранить файл")
    logger.info("[Upload] s3 %s (%d bytes) by %s", key, size, user_id)
    return {"success": True, "url": proxy_url, "filename": effective_filename, "key": key,
            "size": size, "storage": "s3", "type": ftype}


class PresignRequest(BaseModel):
    filename: str
    content_type: str


@router.post("/api/upload/presign")
def presign_upload(req: PresignRequest, me: Identity = Depends(current_identity)):
    """Подписанный PUT-адрес (S3) или локальный PUT на наш сервер — для загрузки с реальным прогрессом."""
    unique_filename = new_upload_name(req.filename)
    key = f"uploads/{unique_filename}"

    if not s3_storage.enabled:
        (UPLOAD_DIR / "uploads").mkdir(parents=True, exist_ok=True)
        return {"presigned_url": f"/api/upload/local/{unique_filename}", "key": key,
                "public_url": f"/api/uploads/{unique_filename}"}
    try:
        content_type = _neutralize_html_content_type(req.filename, req.content_type) or "application/octet-stream"
        return {"presigned_url": s3_storage.generate_presigned_put_url(key, content_type), "key": key,
                "public_url": f"/api/uploads/{unique_filename}" if _is_svg(unique_filename) else s3_storage.public_url(key)}
    except Exception:
        logger.exception("[Upload/Presign] failed")
        raise HTTPException(status_code=502, detail="Не удалось подготовить загрузку")


@router.put("/api/upload/local/{filename}")
async def local_upload_put(filename: str, request: Request, me: Identity = Depends(current_identity)):
    """Приём бинарного PUT для локального диска (когда S3 выключен).

    Пишем только под именем, выданным presign (uuid[.ext]), и только в новый файл:
    раньше можно было перезаписать любой уже загруженный файл."""
    safe = safe_name(filename)
    if not is_upload_name(safe):
        raise HTTPException(status_code=400, detail="Invalid filename")
    local_path = UPLOAD_DIR / "uploads" / safe
    local_path.parent.mkdir(parents=True, exist_ok=True)
    if local_path.exists():
        raise HTTPException(status_code=409, detail="Файл уже существует")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="Файл слишком большой")
    total = 0
    tmp = local_path.with_suffix(local_path.suffix + ".part")
    try:
        with tmp.open("wb") as fh:
            async for chunk in request.stream():
                total += len(chunk)
                if total > settings.max_upload_bytes:
                    raise HTTPException(status_code=413, detail="Файл слишком большой")
                fh.write(chunk)
        tmp.replace(local_path)
    finally:
        tmp.unlink(missing_ok=True)
    return {"ok": True}


class UploadCompleteRequest(BaseModel):
    key: str
    filename: str
    content_type: str
    size: int


@router.post("/api/upload/complete")
def complete_upload(req: UploadCompleteRequest, me: Identity = Depends(current_identity)):
    """Подтверждение загрузки: ACL в S3 либо локальный адрес.

    key принимаем только вида uploads/<uuid>[.ext]: иначе можно было бы выставить
    public-read на любой объект бакета."""
    prefix, _, name = req.key.partition("/")
    if prefix != "uploads" or not is_upload_name(name):
        raise HTTPException(status_code=400, detail="Invalid key")
    proxy_url = f"/api/uploads/{name}"
    if not s3_storage.enabled:
        if not (UPLOAD_DIR / "uploads" / name).exists():
            raise HTTPException(status_code=404, detail="Файл не загружен")
        return {"success": True, "url": proxy_url, "filename": req.filename, "key": req.key,
                "size": req.size, "storage": "local"}
    try:
        s3_storage.set_public_acl(req.key)
        try:
            head = s3_storage._client.head_object(Bucket=s3_storage.bucket, Key=req.key)
            actual_size = int(head.get("ContentLength", req.size))
        except Exception:
            actual_size = req.size
        return {"success": True, "url": f"/api/uploads/{Path(req.key).name}" if _is_svg(req.key) else s3_storage.public_url(req.key), "filename": req.filename,
                "key": req.key, "size": actual_size, "storage": "s3"}
    except Exception:
        logger.exception("[Upload/Complete] failed for %s", req.key)
        raise HTTPException(status_code=502, detail="Не удалось завершить загрузку")


@router.get("/api/thumbs/{width}/{filename}")
def get_thumbnail(width: int, filename: str):
    """Уменьшенная копия загруженной картинки (WebP). Готовую копию храним
    рядом с оригиналом (S3 или диск) и дальше отдаём сразу. Не картинка,
    анимация или нет Pillow — перенаправляем на оригинал."""
    from fastapi.responses import RedirectResponse
    safe = safe_name(filename)
    original_url = f"/api/uploads/{safe}"
    if not media_thumbs.available() or not media_thumbs.is_thumbnailable(safe):
        return RedirectResponse(original_url, status_code=302)
    w = media_thumbs.pick_width(width)
    key = media_thumbs.cache_key(safe, w)
    cache_headers = {'Cache-Control': 'public, max-age=31536000, immutable'}

    if s3_storage.enabled:
        try:
            s3_storage._client.head_object(Bucket=s3_storage.bucket, Key=key)
            return RedirectResponse(s3_storage.public_url(key), status_code=302, headers=cache_headers)
        except Exception:
            pass
        obj = s3_storage.get_object(f"uploads/{safe}")
        if not obj:
            raise HTTPException(status_code=404, detail="File not found")
        data = obj['Body'].read()
    else:
        cached = UPLOAD_DIR / key
        if cached.exists():
            return FileResponse(str(cached), media_type='image/webp', headers=cache_headers)
        local_path = UPLOAD_DIR / "uploads" / safe
        if not local_path.exists():
            raise HTTPException(status_code=404, detail="File not found")
        data = local_path.read_bytes()

    made = media_thumbs.make_thumbnail(data, w)
    if not made:
        return RedirectResponse(original_url, status_code=302)
    body, tw, th = made
    try:
        if s3_storage.enabled:
            s3_storage.upload_fileobj(io.BytesIO(body), key, content_type='image/webp')
        else:
            cached = UPLOAD_DIR / key
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(body)
    except Exception as e:
        logger.warning(f"[thumbs] cache write failed for {key}: {e}")
    return Response(content=body, media_type='image/webp', headers={**cache_headers, 'X-Image-Size': f"{tw}x{th}"})


def _serve_svg(safe: str) -> Response:
    media_type = 'image/svg+xml'
    headers = dict(_SVG_HEADERS)
    if safe.lower().endswith('.svgz'):
        headers['Content-Encoding'] = 'gzip'
    if not s3_storage.enabled:
        local_path = UPLOAD_DIR / "uploads" / safe
        if not local_path.exists():
            raise HTTPException(status_code=404, detail="File not found locally")
        return FileResponse(str(local_path), media_type=media_type, headers=headers)
    obj = s3_storage.get_object(f"uploads/{safe}")
    if not obj:
        raise HTTPException(status_code=404, detail="File not found")
    return Response(content=obj['Body'].read(), media_type=media_type, headers=headers)


@router.get("/api/uploads/{filename}")
def get_uploaded_file(filename: str):
    """Serve an uploaded file: stream from S3, or serve from local disk."""

    safe = safe_name(filename)

    if _is_svg(safe):
        return _serve_svg(safe)

    if not s3_storage.enabled:
        local_path = UPLOAD_DIR / "uploads" / safe
        if local_path.exists():
            headers = {'X-Content-Type-Options': 'nosniff'}
            if Path(safe).suffix.lower() in _HTML_EXECUTABLE_EXTENSIONS:
                headers['Content-Disposition'] = f'attachment; filename="{safe}"'
                return FileResponse(str(local_path), media_type='application/octet-stream', headers=headers)
            return FileResponse(str(local_path), headers=headers)
        raise HTTPException(status_code=404, detail="File not found locally")

    # Files are stored with public-read ACL — redirect directly to S3,
    # bypassing server proxying which caused multi-minute delays for large files.
    from fastapi.responses import RedirectResponse
    key = f"uploads/{safe}"
    direct_url = s3_storage.public_url(key)
    return RedirectResponse(url=direct_url, status_code=302)
