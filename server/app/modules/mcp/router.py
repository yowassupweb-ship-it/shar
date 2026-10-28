"""MCP-сервер «Офиса»: POST /api/mcp — JSON-RPC 2.0 по Streamable HTTP (MCP 2025-06-18), ответ обычным JSON.

Без сессий и потоков (GET — 405): каждый запрос несёт ключ `Authorization: Bearer shar_mcp_…`, выпущенный
в «Настройки → MCP». Маршрут открыт в security.PUBLIC_METHODS: сессия Шара здесь не нужна, личность и доступ — по ключу.
Каждый вызов инструмента пишется в журнал ключа (видно в настройках).

Подключение (Claude Code):
  claude mcp add --transport http shar https://<домен>/api/mcp --header "Authorization: Bearer <ключ>"
Клиентам без своих заголовков (ChatGPT: «Без аутентификации») — тот же ключ в адресе: https://<домен>/api/mcp/<ключ>.
Ключ в адресе попадает в журналы прокси — держать его с узким доступом и срок ставить небольшой.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from app.core.ratelimit import limiter
from app.modules.mcp import keys, tools

router = APIRouter()
log = logging.getLogger("shar.mcp")

PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "shar-office", "title": "Шар · Офис", "version": "1.1.0"}
INSTRUCTIONS = (
    "Документы, заметки, таблицы и презентации «Офиса» Шара — от имени владельца ключа, с его правами и только там, "
    "куда он открыл доступ этому ключу. Сначала найдите материал (list_items, list_folders), прочитайте (read_item), "
    "правьте точечно (edit_note, edit_document, update_table). Перед каждой правкой сохраняется версия — человек может "
    "вернуть прежнее. Если материал изменили, пока вы работали, правка не пройдёт: перечитайте и повторите. "
    "Ссылка на материал Шара — поле url из list_items/read_item (/office?kind=<вид>&id=<id>), домен в ссылку не нужен; "
    "ссылки вида /d/<токен> и /t/<токен> — публичные, их выдаёт человек, по id они не открываются."
)
CALLS_PER_MINUTE = 120


def _error(rpc_id: Any, code: int, message: str, status: int = 200) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}, status_code=status)


def _result(rpc_id: Any, result: dict[str, Any]) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "result": result})


def _call_tool(ctx: keys.KeyContext, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Вызов инструмента и запись в журнал ключа: что, над чем, получилось ли."""
    tool = tools.BY_NAME[name]
    item_id = str(args.get("id") or "")
    try:
        data = tools.run(ctx, tool, args)
    except tools.ToolError as exc:
        keys.log_call(ctx, name, item_id, error=str(exc))
        return {"isError": True, "content": [{"type": "text", "text": str(exc)}]}
    except Exception as exc:
        log.exception("mcp tool %s failed for %s", name, ctx.me.user_id)
        keys.log_call(ctx, name, item_id, error="Внутренняя ошибка")
        return {"isError": True, "content": [{"type": "text", "text": f"Не получилось: {exc}"}]}
    if name not in ("list_items", "list_folders"):  # чтение списков в журнал не пишем: шум
        keys.log_call(ctx, name, str(data.get("id") or item_id), str(data.get("title") or ""))
    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}], "structuredContent": data}


@router.get("/api/mcp")
def mcp_get():
    # Поток событий сервера не нужен: все ответы — в ответ на POST.
    return Response(status_code=405, headers={"Allow": "POST"})


@router.get("/api/mcp/{token}")
def mcp_get_keyed(token: str):
    return mcp_get()


@router.post("/api/mcp/{token}")
async def mcp_post_keyed(token: str, request: Request):
    # Только ключи (shar_mcp_…): так адрес не пересекается с /api/mcp/keys и прочим управлением ключами.
    if not token.startswith(keys.PREFIX):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return await _handle(request, token)


@router.post("/api/mcp")
async def mcp_post(request: Request):
    auth = request.headers.get("authorization", "")
    return await _handle(request, auth[7:].strip() if auth.lower().startswith("bearer ") else "")


async def _handle(request: Request, token: str):
    ctx = await run_in_threadpool(keys.context_for_token, token) if token else None
    if ctx is None:
        return JSONResponse({"error": "Нужен действующий ключ MCP: Настройки → MCP"}, status_code=401,
                            headers={"WWW-Authenticate": 'Bearer realm="shar-mcp"'})
    try:
        message = await request.json()
    except ValueError:
        return _error(None, -32700, "Parse error", 400)
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        return _error(message.get("id") if isinstance(message, dict) else None, -32600, "Invalid Request", 400)

    rpc_id = message.get("id")
    method = message["method"]
    params = message.get("params") or {}
    if rpc_id is None:  # уведомление (notifications/initialized и т. п.): ответа не ждут
        return Response(status_code=202)

    if method == "initialize":
        asked = str(params.get("protocolVersion") or "")
        return _result(rpc_id, {
            "protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
            "instructions": f"{INSTRUCTIONS}\n{tools.summary(ctx)}",
        })
    if method == "ping":
        return _result(rpc_id, {})
    if method == "tools/list":
        return _result(rpc_id, {"tools": tools.describe(ctx)})
    if method == "tools/call":
        name = str(params.get("name") or "")
        if name not in tools.BY_NAME:
            return _error(rpc_id, -32602, f"Нет инструмента {name}")
        if not limiter.allow(f"mcp:{ctx.key_id}", CALLS_PER_MINUTE, 60):
            return _result(rpc_id, {"isError": True, "content": [{"type": "text", "text": "Слишком много вызовов, подождите минуту"}]})
        args = params.get("arguments") or {}
        return _result(rpc_id, await run_in_threadpool(_call_tool, ctx, name, args if isinstance(args, dict) else {}))
    return _error(rpc_id, -32601, f"Method not found: {method}")
