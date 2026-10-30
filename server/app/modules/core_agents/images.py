"""Картинки для агентов «Ядра»: генерация и правка через Gemini по ключу человека (Настройки → Ядро → Gemini).

Рисует любой агент — Claude, GPT или Gemini — инструментом MCP image_generate: сам Шар зовёт модель картинок Google
ключом человека, кладёт файл туда же, куда вложения чатов (/api/uploads/…), и прикрепляет к ответу агента —
картинка сразу видна в чате и лежит в «Файлах → Агенты». Без ключа Gemini — понятная ошибка, что подключить.

Модель — самая новая из доступных ключу «…-image» (список моделей ключа, кэш на час): так не нужно править код,
когда Google выпускает новую.
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
        raise ImageError("Картинки рисует Gemini по ключу Google — подключите его: Настройки → Ядро → Gemini (ключ из AI Studio)")
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


def generate(user_id: str, prompt: str, *, aspect: str = "", source_url: str = "", name: str = "") -> dict:
    """Нарисовать (или поправить source_url) и сохранить. Возвращает вложение: {name, url, size, type, key}."""
    prompt = str(prompt or "").strip()
    if not prompt:
        raise ImageError("Опишите, что нарисовать")
    key = _key(user_id)
    model = _model(key)
    parts: list[dict] = [{"text": prompt[:4000]}]
    if source_url:
        mime, data = _source(source_url)
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


def attach_to_job(message_id: str, file: dict) -> None:
    """Прикрепить картинку к ответу агента, который сейчас работает (ключ MCP запуска знает его id)."""
    if not message_id:
        return
    row = db.conn.fetch_one("SELECT props FROM core_messages WHERE id = %s", (message_id,))
    if not row:
        return
    files = list((row.get("props") or {}).get("attachments") or [])
    files.append({k: file[k] for k in ("name", "url", "size", "type", "key") if k in file})
    from app.modules.core_chat.router import update_agent_message

    update_agent_message(message_id, props={"attachments": files[-20:]})


def latest_model(user_id: Optional[str]) -> str:
    try:
        return _model(_key(user_id or "")).split("/")[-1]
    except ImageError:
        return ""
