"""Картинки для агентов «Ядра»: каждый агент рисует своим средством, Gemini не обязателен.

GPT рисует встроенным image_gen через подписку Codex: нода присылает готовые байты событием attachment, а save_native
проверяет их и прикрепляет к ответу. Любой другой агент (Claude, Kimi, Gemini и внешние по MCP), создав картинку сам,
отдаёт её файлом в папку outbox ноды (быстро) или инструментом image_attach (base64 или вложение Шара). Gemini по ключу человека (MCP image_generate) остаётся
лишь запасным путём. Файлы во всех путях попадают в /api/uploads/… и «Файлы → Агенты».

Модель Gemini — самая новая из доступных ключу «…-image» (список моделей ключа, кэш на час).
"""
from __future__ import annotations

import base64
import re
import time
from typing import Optional

import requests

from app.core.db import db
from app.modules.core_agents import store

API = "https://generativelanguage.googleapis.com/v1beta"
TIMEOUT = 120
ASPECTS = {"1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "4:5", "5:4", "21:9"}
MAX_SOURCE_BYTES = 15 * 1024 * 1024
_models: dict[str, tuple[float, str]] = {}  # отпечаток ключа → (когда, модель)


class ImageError(RuntimeError):
    pass


def _key(user_id: str) -> str:
    row = store.account(user_id, "gemini")
    key = store.unseal(row.get("secret_enc") or "") if row else ""
    if not key:
        raise ImageError("Ключа Gemini нет, и он не обязателен: нарисуйте картинку своим встроенным средством (или соберите её сами) и отдайте человеку через image_attach. Чтобы image_generate работал, подключите Gemini: Настройки → Ядро → Gemini (ключ из AI Studio)")
    return key


def _version(name: str) -> tuple:
    """«models/gemini-3.1-flash-image-preview» → (3, 1, не-preview, flash): новее и стабильнее — выше."""
    nums = [int(n) for n in re.findall(r"(\d+)", name.split("gemini-", 1)[-1].split("-image")[0])[:2]]
    return (*(nums + [0, 0])[:2], "preview" not in name, "flash" in name)


def _model(key: str) -> str:
    stamp = key[-6:]
    cached = _models.get(stamp)
    if cached and time.time() - cached[0] < 3600:
        return cached[1]
    try:
        # Ключ — заголовком, не в адресе: адрес попадает в тексты ошибок, а они — агенту и в чат.
        res = requests.get(f"{API}/models", params={"pageSize": 200}, headers={"x-goog-api-key": key}, timeout=15)
        if res.status_code != 200:
            raise ImageError(f"Google отказал в списке моделей ({res.status_code}): {_google_error(res)}")
        names = [m["name"] for m in res.json().get("models", [])
                 if "image" in m.get("name", "") and "generateContent" in (m.get("supportedGenerationMethods") or [])
                 and "gemini" in m.get("name", "")]
    except (requests.RequestException, ValueError) as exc:
        raise ImageError(f"Google не ответил на список моделей ({exc.__class__.__name__})") from exc
    if not names:
        raise ImageError("Ключу Google недоступна ни одна модель картинок Gemini — проверьте ключ в AI Studio")
    best = max(names, key=_version)
    _models[stamp] = (time.time(), best)
    return best


def _google_error(res) -> str:
    """Текст ошибки Google без адреса запроса."""
    try:
        return str(res.json().get("error", {}).get("message", ""))[:300]
    except ValueError:
        return ""


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


def generate(user_id: str, prompt: str, *, aspect: str = "", source_url: str = "", name: str = "", refs: Optional[list[dict]] = None,
             extra_text: str = "", extra_images: Optional[list[tuple[str, bytes]]] = None) -> dict:
    """Нарисовать (или поправить source_url) и сохранить. Возвращает вложение: {name, url, size, type, key}.
    refs — референсы человека из студии ({url, name, kind, note}): уходят к модели картинками вместе с пояснением, что это."""
    prompt = str(prompt or "").strip()
    if not prompt:
        raise ImageError("Опишите, что нарисовать")
    key = _key(user_id)
    model = _model(key)
    refs = list(refs or [])[:6]
    text = prompt[:4000]
    if extra_text:
        text += "\n\n" + extra_text[:2500]
    if refs:
        what = {"style": "стиль", "character": "персонаж", "product": "предмет", "logo": "логотип", "scene": "место и фон"}
        text += "\n\nПриложены референсы — следуй им: " + "; ".join(
            f"картинка {n + 1} — {what.get(str(r.get('kind')), 'пример')} «{r.get('name') or ''}»" + (f" ({r['note']})" if r.get("note") else "")
            for n, r in enumerate(refs)) + "."
    parts: list[dict] = [{"text": text}]
    if source_url:
        mime, data = _source(source_url)
        parts.append({"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}})
    for mime, data in extra_images or []:  # например, схема меток правок поверх исходного фото
        parts.append({"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}})
    for ref in refs:
        try:
            mime, data = _source(str(ref.get("url") or ""))
        except ImageError:
            continue  # недоступный референс не должен срывать рисование
        parts.append({"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}})
    config: dict = {"responseModalities": ["IMAGE", "TEXT"]}
    if aspect in ASPECTS:
        config["imageConfig"] = {"aspectRatio": aspect}
    try:
        res = requests.post(f"{API}/{model}:generateContent", headers={"x-goog-api-key": key},
                            json={"contents": [{"role": "user", "parts": parts}], "generationConfig": config}, timeout=TIMEOUT)
    except requests.RequestException as exc:
        raise ImageError(f"Google не ответил ({exc.__class__.__name__})") from exc
    if res.status_code != 200:
        try:
            detail = res.json().get("error", {}).get("message", "")
        except ValueError:
            detail = res.text[:200]
        raise ImageError(f"Google отказал ({res.status_code}): {detail[:300]}")
    body = res.json()
    image, note = None, ""
    for part in ((body.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []:
        inline = part.get("inlineData") or part.get("inline_data")
        if inline and not image:
            image = inline
        elif part.get("text"):
            note += part["text"]
    if not image:
        reason = (body.get("candidates") or [{}])[0].get("finishReason") or (body.get("promptFeedback") or {}).get("blockReason") or ""
        raise ImageError(f"Модель не вернула картинку{f' ({reason})' if reason else ''}{f': {note[:200]}' if note else ''}")
    mime = image.get("mimeType") or image.get("mime_type") or "image/png"
    data = base64.b64decode(image.get("data") or "")
    ext = {"image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime, ".png")
    safe = re.sub(r"[^\w\- ]+", "", name or prompt)[:50].strip() or "картинка"
    from app.modules.files.uploads import save_upload_bytes

    saved = save_upload_bytes(f"{safe}{ext}", data, mime, user_id)
    _count_usage(user_id, body.get("usageMetadata") or {}, model)
    return {"name": saved["filename"], "url": saved["url"], "size": saved["size"], "type": mime, "key": saved["key"],
            "model": model.split("/")[-1], "note": note.strip()[:500]}


def _count_usage(user_id: str, usage: dict, model: str) -> None:
    """Расход ключа Gemini — в ту же статистику, что ответы (Настройки → Ядро → Расход)."""
    try:
        store.add_usage(user_id, "gemini", model.split("/")[-1], {"input_tokens": usage.get("promptTokenCount") or 0,
                                                                  "output_tokens": usage.get("candidatesTokenCount") or 0})
    except Exception:  # noqa: BLE001 — статистика не должна ронять картинку
        pass


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


def latest_model(user_id: Optional[str]) -> str:
    try:
        return _model(_key(user_id or "")).split("/")[-1]
    except ImageError:
        return ""
