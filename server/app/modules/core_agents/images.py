"""Картинки агентов «Ядра»: каждый агент рисует своим средством, Шар только принимает готовое.

GPT рисует встроенным image_gen через подписку Codex: нода присылает готовые байты событием attachment, а save_native
проверяет их и прикрепляет к ответу. Любой другой агент (Claude, Kimi и внешние по MCP), создав картинку сам (SVG, код,
свой генератор), отдаёт её файлом в папку outbox ноды или инструментом image_attach (base64 или вложение Шара). Файлы во всех
путях попадают в /api/uploads/…, в «Файлы → Агенты» и в галерею «Студии».

Своего генератора у Шара нет: прежний запасной путь через Gemini по ключу человека удалён (18.11.2026) — «Студия» тоже рисует
агентом по подписке (studio/router.py → make).
"""
from __future__ import annotations

import base64
import re
from typing import Optional

import requests

from app.core.db import db

ASPECTS = {"1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "4:5", "5:4", "21:9"}
MAX_SOURCE_BYTES = 15 * 1024 * 1024


class ImageError(RuntimeError):
    pass


def _source(url: str) -> tuple[str, bytes]:
    """Исходная картинка для правки: вложение Шара (/api/uploads/…) или адрес в интернете."""
    from app.modules.mcp.files import absolute

    full = absolute(url) if url.startswith("/") else url
    try:
        res = requests.get(full, timeout=30, stream=True)
        res.raise_for_status()
        data = res.raw.read(MAX_SOURCE_BYTES + 1, decode_content=True)
    except requests.RequestException as exc:
        raise ImageError(f"Не получилось скачать исходную картинку: {exc}") from exc
    if len(data) > MAX_SOURCE_BYTES:
        raise ImageError("Исходная картинка больше 15 МБ")
    mime = (res.headers.get("content-type") or "image/png").split(";")[0]
    if not mime.startswith("image/"):
        raise ImageError("По этому адресу не картинка")
    return mime, data


def _sniff(raw: bytes) -> tuple[str, str]:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return "image/webp", ".webp"
    if raw.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif", ".gif"
    low = raw[:262144].lower()
    if b"<svg" in low[:4096] and low.lstrip(b"\xef\xbb\xbf \t\r\n").startswith((b"<svg", b"<?xml", b"<!--", b"<!doctype svg")):
        # Рисунок кодом агенту проще всего отдать SVG-файлом; скрипты и обработчики в нём не нужны и опасны.
        if any(bad in low for bad in (b"<script", b"javascript:", b"<foreignobject", b"<iframe", b"<embed", b"<!entity")) or re.search(rb"\son[a-z]+\s*=", low):
            raise ImageError("В SVG нельзя скрипты, обработчики событий и внешние вставки: уберите их и повторите")
        return "image/svg+xml", ".svg"
    raise ImageError("Это не PNG, JPEG, WebP, GIF или SVG")


def attach_bytes(message_id: str, user_id: str, raw: bytes, *, name: str = "", event_id: str = "", default_name: str = "картинка", model: str = "") -> dict:
    """Готовая картинка от агента: проверить байты, сохранить в «Файлы → Агенты» и прикрепить к ответу один раз."""
    row = db.conn.fetch_one("SELECT props FROM core_messages WHERE id = %s", (message_id,)) if message_id else None
    if message_id and not row:
        raise ImageError("Ответ агента уже закрыт")
    existing = list(((row or {}).get("props") or {}).get("attachments") or [])
    duplicate = next((f for f in existing if event_id and f.get("eventId") == event_id), None)
    if duplicate:
        return duplicate
    if not raw or len(raw) > 32 * 1024 * 1024:
        raise ImageError("Картинка пустая или больше 32 МБ")
    mime, ext = _sniff(raw)
    safe = re.sub(r"[^\w\- ]+", "", name)[:50].strip() or default_name
    from app.modules.files.uploads import save_upload_bytes

    saved = save_upload_bytes(f"{safe}{ext}", raw, mime, user_id)
    file = {"name": saved["filename"], "url": saved["url"], "size": saved["size"], "type": mime, "key": saved["key"]}
    if event_id:
        file["eventId"] = event_id
    attach_to_job(message_id, file)
    if mime != "image/svg+xml":
        try:  # картинка агента из чата — тоже в галерею студии (запроса нода не присылает — имя файла)
            from app.modules.studio.router import record_image

            record_image(user_id, {**file, "model": model}, prompt=name, source="chat")
        except Exception:  # noqa: BLE001
            pass
    return file


def save_native(message_id: str, user_id: str, *, event_id: str, data: str, name: str = "") -> dict:
    """PNG/JPEG/WebP из встроенного image_gen ноды: проверить байты, сохранить и прикрепить один раз."""
    try:
        raw = base64.b64decode(data, validate=True)
    except (ValueError, TypeError) as exc:
        raise ImageError("Нода прислала повреждённую картинку") from exc
    return attach_bytes(message_id, user_id, raw, name=name, event_id=event_id, default_name="картинка-gpt", model="gpt")


def attach_to_job(message_id: str, file: dict) -> None:
    """Прикрепить картинку к ответу агента, который сейчас работает (ключ MCP запуска знает его id)."""
    if not message_id:
        return
    row = db.conn.fetch_one("SELECT props FROM core_messages WHERE id = %s", (message_id,))
    if not row:
        return
    files = list((row.get("props") or {}).get("attachments") or [])
    if file.get("eventId") and any(f.get("eventId") == file["eventId"] for f in files):
        return
    files.append({k: file[k] for k in ("name", "url", "size", "type", "key", "eventId") if k in file})
    from app.modules.core_chat.router import update_agent_message

    update_agent_message(message_id, props={"attachments": files[-20:]})
