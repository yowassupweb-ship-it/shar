from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import FileResponse

from app.core.db import db
from app.core.security import Identity, current_identity
from app.core.storage import UPLOAD_DIR

router = APIRouter()

logger = logging.getLogger(__name__)


STICKERS_DIR = UPLOAD_DIR / "stickers"


STICKERS_DIR.mkdir(parents=True, exist_ok=True)


# Имена наборов Telegram — латиница, цифры и «_». Имя ложится в путь на диске,
# поэтому всё остальное отсекаем: иначе «..» в setName уводил запись (и rmtree
# при удалении) за пределы каталога стикеров.
_SET_NAME = re.compile(r"^[A-Za-z0-9_]{1,64}$")
_FILE_NAME = re.compile(r"^[A-Za-z0-9_.\-]{1,128}$")
_index_lock = threading.Lock()


def _valid_set_name(set_name: str) -> str:
    if not _SET_NAME.match(set_name or ""):
        raise HTTPException(status_code=400, detail="Invalid sticker set name")
    return set_name


def _get_sticker_sets_index() -> list:
    idx_path = STICKERS_DIR / "_index.json"
    if idx_path.exists():
        try:
            return json.loads(idx_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_sticker_sets_index(sets: list) -> None:
    idx_path = STICKERS_DIR / "_index.json"
    idx_path.write_text(json.dumps(sets, ensure_ascii=False, indent=2), encoding="utf-8")


@router.post("/api/stickers/import")
async def import_sticker_set(body: dict = Body(...), me: Identity = Depends(current_identity)):
    """Скачать sticker set из Telegram и сохранить локально."""
    import aiohttp

    set_name = _valid_set_name(str(body.get("setName", "")).strip())
    user_id = me.user_id  # владелец набора — вошедший, а не userId из тела запроса

    settings = db.get_settings() or {}
    bot_token = (settings.get('telegramBotToken') or os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("BOT_TOKEN") or '').strip()
    if not bot_token:
        raise HTTPException(status_code=500, detail="TELEGRAM_BOT_TOKEN not configured — добавьте токен бота в настройках приложения")

    tg_api = f"https://api.telegram.org/bot{bot_token}"
    tg_file = f"https://api.telegram.org/file/bot{bot_token}"

    # Build aiohttp session with proxy support via SOCKS5 (mixed proxies work reliably this way)
    _raw_proxy = (settings.get('telegramProxy') or os.getenv("TELEGRAM_PROXY") or '').strip()
    _connector = None
    if _raw_proxy:
        from aiohttp_socks import ProxyConnector
        # Normalize any scheme → socks5:// (aiohttp-socks doesn't support socks5h/http)
        _socks_url = _raw_proxy
        if '://' in _socks_url:
            _socks_url = 'socks5://' + _socks_url.split('://', 1)[1]
        else:
            _socks_url = 'socks5://' + _socks_url
        _connector = ProxyConnector.from_url(_socks_url)

    async def tg_get(session: aiohttp.ClientSession, method: str, **params) -> dict:
        async with session.get(f"{tg_api}/{method}", params=params) as r:
            return await r.json()

    async def tg_download(session: aiohttp.ClientSession, file_path: str) -> bytes:
        async with session.get(f"{tg_file}/{file_path}") as r:
            return await r.read()

    try:
      async with aiohttp.ClientSession(
          connector=_connector,
          timeout=aiohttp.ClientTimeout(total=60),
      ) as session:
        # 1. Fetch sticker set info
        data = await tg_get(session, "getStickerSet", name=set_name)
        if not data.get("ok"):
            raise HTTPException(status_code=400, detail=data.get("description", "Sticker set not found"))

        result = data["result"]
        title = result.get("title", set_name)
        stickers_raw = result.get("stickers", [])
        thumb = result.get("thumb")

        set_dir = STICKERS_DIR / set_name
        set_dir.mkdir(parents=True, exist_ok=True)

        stickers_meta = []
        for sticker in stickers_raw:
            file_id = sticker["file_id"]
            emoji = sticker.get("emoji", "")
            # Skip only video stickers (.webm); .tgs (Lottie/animated) are now supported
            if sticker.get("is_video"):
                continue

            fdata = await tg_get(session, "getFile", file_id=file_id)
            if not fdata.get("ok"):
                continue
            file_path = fdata["result"]["file_path"]
            filename = file_path.split("/")[-1]
            if not _FILE_NAME.match(filename):
                continue

            local_path = set_dir / filename
            if not local_path.exists():
                local_path.write_bytes(await tg_download(session, file_path))

            is_animated = bool(sticker.get("is_animated"))
            stickers_meta.append({
                "file_id": file_id,
                "emoji": emoji,
                "filename": filename,
                "is_animated": is_animated,
                "url": f"/api/stickers/file/{set_name}/{filename}",
            })

        # Download thumbnail
        thumb_url = None
        if thumb:
            tr = await tg_get(session, "getFile", file_id=thumb["file_id"])
            if tr.get("ok"):
                tp = tr["result"]["file_path"]
                thumb_filename = tp.split("/")[-1]
                thumb_local = set_dir / thumb_filename
                if not _FILE_NAME.match(thumb_filename):
                    thumb_local = None
                elif not thumb_local.exists():
                    thumb_local.write_bytes(await tg_download(session, tp))
                if thumb_local is not None:
                    thumb_url = f"/api/stickers/file/{set_name}/{thumb_filename}"

        # Save manifest
        manifest = {"setName": set_name, "title": title, "thumbUrl": thumb_url, "stickers": stickers_meta}
        (set_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        # Индекс общий для всех: читаем-меняем-пишем под замком.
        entry = {"setName": set_name, "title": title, "thumbUrl": thumb_url, "count": len(stickers_meta), "userId": user_id}
        with _index_lock:
            idx = _get_sticker_sets_index()
            existing = next((i for i, st in enumerate(idx) if st["setName"] == set_name), -1)
            if existing >= 0:
                idx[existing] = entry
            else:
                idx.append(entry)
            _save_sticker_sets_index(idx)

        return {"ok": True, "setName": set_name, "title": title, "count": len(stickers_meta)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Sticker import failed")
        raise HTTPException(status_code=500, detail=f"Ошибка загрузки стикеров: {e}")


@router.get("/api/stickers/sets")
def get_sticker_sets(me: Identity = Depends(current_identity)):
    """Наборы вошедшего пользователя (и общие, без владельца)."""
    return [st for st in _get_sticker_sets_index() if not st.get("userId") or st.get("userId") == me.user_id]


@router.get("/api/stickers/sets/{set_name}")
def get_sticker_set(set_name: str, me: Identity = Depends(current_identity)):
    """Стикеры конкретного набора."""
    manifest_path = STICKERS_DIR / _valid_set_name(set_name) / "manifest.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=404, detail="Sticker set not found")
    return json.loads(manifest_path.read_text(encoding="utf-8"))


@router.delete("/api/stickers/sets/{set_name}")
def delete_sticker_set(set_name: str, me: Identity = Depends(current_identity)):
    """Убрать набор у себя; файлы удаляются, когда набор больше никому не нужен.

    Общие наборы (без владельца) может убрать только админ."""
    _valid_set_name(set_name)
    with _index_lock:
        idx = _get_sticker_sets_index()

        def mine(entry: dict) -> bool:
            owner = entry.get("userId")
            return entry["setName"] == set_name and (owner == me.user_id or (not owner and me.is_admin))

        new_idx = [e for e in idx if not mine(e)]
        _save_sticker_sets_index(new_idx)
        still_used = any(e["setName"] == set_name for e in new_idx)
    set_dir = STICKERS_DIR / set_name
    if set_dir.exists() and not still_used:
        shutil.rmtree(set_dir)
    return {"ok": True}


@router.get("/api/stickers/file/{set_name}/{filename}")
def get_sticker_file(set_name: str, filename: str):
    """Файл стикера (.webp или .tgs)."""
    if not _SET_NAME.match(set_name) or not _FILE_NAME.match(filename) or filename in (".", ".."):
        raise HTTPException(status_code=400, detail="Invalid path")
    path = STICKERS_DIR / set_name / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Sticker file not found")
    headers = {"Cache-Control": "public, max-age=31536000", "X-Content-Type-Options": "nosniff"}
    if filename.endswith(".tgs"):
        # Сырой gzip: клиент (AnimatedSticker) распаковывает сам через fflate.
        # Content-Encoding: gzip не ставим — браузер распаковал бы дважды.
        return FileResponse(str(path), media_type="application/octet-stream", headers=headers)
    return FileResponse(str(path), media_type="image/webp", headers=headers)
