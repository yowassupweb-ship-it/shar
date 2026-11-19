"""Управление компьютером человека агентом «Ядра» — через Shar OS, без агента на самом компьютере.

Агент работает на ноде (сервер), а экран и мышь — у человека. Мост:
  1. Shar OS с включённым управлением (по умолчанию выключено, включает сам человек в Настройки → Устройства) раз в
     полминуты отмечается: POST /api/computer/presence — «этот компьютер можно, вот его экран» (Redis, живёт 75 с).
  2. Инструмент агента (computer_*) кладёт команду: событие computer_request уходит именно этому человеку, с id
     устройства; ждём ответ в Redis (BLPOP) — так работает при любом числе процессов сервера.
  3. Shar OS выполняет (снимок экрана, клик, ввод), показывает плашку «Агент управляет» с кнопкой «Стоп» и
     клавишей Ctrl+Alt+Q, и отвечает: POST /api/computer/result/{id} — снимок экрана после действия.

Чужой компьютер недоступен: команда уходит только устройствам того, чей это запуск агента. Инструменты открыты
только запускам «Ядра» (ключ с job), не личным MCP-ключам внешних программ.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Any, Optional

import redis as _redis
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity

router = APIRouter()

PRESENCE_TTL = 75
REQUEST_TTL = 90
WAIT_SECONDS = 25
MAX_IMAGE_BYTES = 3 * 1024 * 1024

_DEV = "shar:computer:dev:"
_REQ = "shar:computer:req:"
_RES = "shar:computer:res:"


def _redis_client():
    return _redis.Redis.from_url(os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0"), decode_responses=True,
                                 socket_connect_timeout=2, socket_timeout=WAIT_SECONDS + 5)


class ComputerError(Exception):
    """Понятная агенту причина, почему действие не выполнено."""


# ── присутствие Shar OS ──────────────────────────────────────────────────────

class PresenceBody(BaseModel):
    deviceId: str = Field(min_length=8, max_length=80)
    name: str = Field(default="", max_length=120)
    width: int = Field(default=0, ge=0, le=20000)
    height: int = Field(default=0, ge=0, le=20000)


def _safe(device_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", device_id):
        raise HTTPException(status_code=400, detail="Неверный id устройства")
    return device_id


@router.post("/api/computer/presence")
def presence(body: PresenceBody, me: Identity = Depends(current_identity)):
    """Shar OS: «на этом компьютере управление включено» — раз в 30 с, пока включено."""
    r = _redis_client()
    r.set(f"{_DEV}{me.user_id}:{_safe(body.deviceId)}", json.dumps({
        "deviceId": body.deviceId, "name": body.name.strip()[:120] or "Компьютер", "width": body.width, "height": body.height, "at": time.time(),
    }), ex=PRESENCE_TTL)
    return {"ok": True}


@router.delete("/api/computer/presence/{device_id}")
def presence_off(device_id: str, me: Identity = Depends(current_identity)):
    """Выключили управление (или нажали «Стоп») — устройство сразу пропадает для агента."""
    _redis_client().delete(f"{_DEV}{me.user_id}:{_safe(device_id)}")
    return {"ok": True}


def devices(user_id: str) -> list[dict]:
    r = _redis_client()
    out = []
    for key in r.scan_iter(match=f"{_DEV}{user_id}:*", count=50):
        raw = r.get(key)
        if raw:
            try:
                out.append(json.loads(raw))
            except ValueError:
                continue
    return sorted(out, key=lambda d: -float(d.get("at") or 0))


# ── ответ Shar OS ────────────────────────────────────────────────────────────

class ResultBody(BaseModel):
    ok: bool = True
    error: str = Field(default="", max_length=500)
    image: str = Field(default="", max_length=MAX_IMAGE_BYTES * 4 // 3 + 16)
    width: int = 0
    height: int = 0
    info: dict = Field(default_factory=dict)


@router.post("/api/computer/result/{request_id}")
def result(request_id: str, body: ResultBody, me: Identity = Depends(current_identity)):
    if not re.fullmatch(r"[a-f0-9]{32}", request_id):
        raise HTTPException(status_code=400, detail="Неверный id запроса")
    r = _redis_client()
    owner = r.get(f"{_REQ}{request_id}")
    if owner != me.user_id:
        raise HTTPException(status_code=404, detail="Запрос не найден или устарел")
    r.rpush(f"{_RES}{request_id}", body.model_dump_json())
    r.expire(f"{_RES}{request_id}", 60)
    r.delete(f"{_REQ}{request_id}")
    return {"ok": True}


# ── вызов из инструмента агента ──────────────────────────────────────────────

def call(user_id: str, action: str, args: dict[str, Any], device: str = "") -> dict[str, Any]:
    found = devices(user_id)
    if device:
        found = [d for d in found if d.get("deviceId") == device or d.get("name") == device]
    if not found:
        raise ComputerError("Управление компьютером недоступно: человек его не включил или Shar OS закрыта. Попросите включить: "
                            "Shar OS → Настройки → Устройства → «Управление компьютером агентом». Пароли и оплату не вводите.")
    target = found[0]
    request_id = uuid.uuid4().hex
    r = _redis_client()
    r.set(f"{_REQ}{request_id}", user_id, ex=REQUEST_TTL)
    sse_manager.push(user_id, {"type": "computer_request", "id": request_id, "deviceId": target["deviceId"], "action": action, "args": args})
    got = r.blpop([f"{_RES}{request_id}"], timeout=WAIT_SECONDS)
    r.delete(f"{_REQ}{request_id}")
    if not got:
        raise ComputerError(f"Shar OS на «{target['name']}» не ответила за {WAIT_SECONDS} с — компьютер спит или приложение занято. Повторите позже.")
    data = json.loads(got[1])
    if not data.get("ok"):
        raise ComputerError(data.get("error") or "Shar OS не выполнила действие")
    return {"device": target["name"], **data}


# ── инструменты агента (подключаются в mcp/tools.py) ─────────────────────────

def _int(args: dict, key: str) -> int:
    try:
        return int(round(float(args[key])))
    except (KeyError, TypeError, ValueError):
        raise ComputerError(f"Нужно число {key} — координата на последнем снимке экрана") from None


def _answer(data: dict, note: str) -> dict[str, Any]:
    out: dict[str, Any] = {"done": note, "device": data.get("device"), "screen": {"width": data.get("width"), "height": data.get("height")}}
    if data.get("info"):
        out["info"] = data["info"]
    if data.get("image"):
        out["__image__"] = data["image"]  # router.py отдаёт его агенту картинкой
    return out


def _run(access, action: str, args: dict[str, Any], note: str) -> dict[str, Any]:
    from app.modules.mcp.tools import ToolError

    try:
        return _answer(call(access.me.user_id, action, args, str(args.get("device") or "")), note)
    except ComputerError as exc:
        raise ToolError(str(exc), "computer_unavailable") from None


def screenshot(access, args):
    return _run(access, "screenshot", {}, "снимок экрана")


def click(access, args):
    button = str(args.get("button") or "left")
    if button not in ("left", "right", "middle"):
        button = "left"
    x, y = _int(args, "x"), _int(args, "y")
    return _run(access, "click", {"x": x, "y": y, "button": button, "double": bool(args.get("double"))}, f"клик {button} в ({x}, {y})")


def move(access, args):
    x, y = _int(args, "x"), _int(args, "y")
    return _run(access, "move", {"x": x, "y": y}, f"курсор в ({x}, {y})")


def drag(access, args):
    a = {"x": _int(args, "x"), "y": _int(args, "y"), "to_x": _int(args, "to_x"), "to_y": _int(args, "to_y")}
    return _run(access, "drag", a, f"перетаскивание ({a['x']}, {a['y']}) → ({a['to_x']}, {a['to_y']})")


def scroll(access, args):
    dy = max(-50, min(50, int(args.get("dy") or 0)))
    a = {"x": _int(args, "x"), "y": _int(args, "y"), "dy": dy}
    return _run(access, "scroll", a, f"прокрутка {dy} в ({a['x']}, {a['y']})")


def type_text(access, args):
    text = str(args.get("text") or "")
    if not text or len(text) > 2000:
        raise_tool("Нужен text от 1 до 2000 знаков")
    return _run(access, "type", {"text": text}, f"набрано {len(text)} знаков")


def key(access, args):
    combo = str(args.get("keys") or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9+\-_ ]{1,40}", combo):
        raise_tool("keys — сочетание вроде ctrl+s, alt+tab, enter, ctrl+shift+t")
    return _run(access, "key", {"keys": combo}, f"клавиши {combo}")


def raise_tool(message: str):
    from app.modules.mcp.tools import ToolError

    raise ToolError(message, "invalid_arguments")


_XY = {"x": {"type": "integer", "description": "по горизонтали, в пикселях последнего снимка экрана"},
       "y": {"type": "integer", "description": "по вертикали, в пикселях последнего снимка экрана"}}
_DEVICE = {"device": {"type": "string", "description": "имя компьютера, если их несколько; по умолчанию — последний активный"}}
_RULES = (" Компьютер человека, у него на глазах: он видит курсор и плашку «Агент управляет». Перед действием — снимок экрана; "
          "после каждого действия придёт новый снимок — проверьте, что получилось. Ничего не покупайте, не отправляйте, не удаляйте "
          "и не вводите пароли без прямой просьбы человека; формы с последствиями заполните и остановитесь перед кнопкой.")

TOOLS: list[dict[str, Any]] = [
    {"name": "computer_screenshot", "handler": screenshot, "level": "read", "core": True,
     "description": "Снимок экрана компьютера человека (Shar OS с включённым управлением)." + _RULES,
     "inputSchema": {"type": "object", "properties": {**_DEVICE}}},
    {"name": "computer_click", "handler": click, "level": "edit", "core": True,
     "description": "Клик мышью по точке на экране (координаты — с последнего снимка). double=true — двойной." + _RULES,
     "inputSchema": {"type": "object", "properties": {**_XY, "button": {"type": "string", "enum": ["left", "right", "middle"]},
                                                     "double": {"type": "boolean"}, **_DEVICE}, "required": ["x", "y"]}},
    {"name": "computer_move", "handler": move, "level": "edit", "core": True,
     "description": "Навести курсор (без клика): всплывающие подсказки и меню по наведению.",
     "inputSchema": {"type": "object", "properties": {**_XY, **_DEVICE}, "required": ["x", "y"]}},
    {"name": "computer_drag", "handler": drag, "level": "edit", "core": True,
     "description": "Перетащить левой кнопкой из (x, y) в (to_x, to_y).",
     "inputSchema": {"type": "object", "properties": {**_XY, "to_x": {"type": "integer"}, "to_y": {"type": "integer"}, **_DEVICE},
                     "required": ["x", "y", "to_x", "to_y"]}},
    {"name": "computer_scroll", "handler": scroll, "level": "edit", "core": True,
     "description": "Прокрутить колесом в точке (x, y): dy > 0 — вниз, < 0 — вверх (в «щелчках» колеса, до 50).",
     "inputSchema": {"type": "object", "properties": {**_XY, "dy": {"type": "integer"}, **_DEVICE}, "required": ["x", "y", "dy"]}},
    {"name": "computer_type", "handler": type_text, "level": "edit", "core": True,
     "description": "Набрать текст в поле, где стоит курсор (сначала кликните в поле). Любой язык." + _RULES,
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, **_DEVICE}, "required": ["text"]}},
    {"name": "computer_key", "handler": key, "level": "edit", "core": True,
     "description": "Нажать клавишу или сочетание: enter, esc, tab, backspace, delete, up/down/left/right, home, end, pageup, pagedown, "
                    "f1–f12, win, ctrl+c, ctrl+v, ctrl+s, alt+tab, ctrl+shift+t…",
     "inputSchema": {"type": "object", "properties": {"keys": {"type": "string"}, **_DEVICE}, "required": ["keys"]}},
]
