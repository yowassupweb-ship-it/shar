"""MCP-сервер «Офиса»: POST /api/mcp — JSON-RPC 2.0 по Streamable HTTP (MCP 2025-06-18), ответ обычным JSON.

Без сессий и потоков (GET — 405): каждый запрос несёт ключ `Authorization: Bearer shar_mcp_…`, выпущенный
в «Настройки → MCP». Маршрут открыт в security.PUBLIC_METHODS: сессия Шара здесь не нужна, личность — по ключу.

Подключение (Claude Code):
  claude mcp add --transport http shar https://<домен>/api/mcp --header "Authorization: Bearer <ключ>"
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
SERVER_INFO = {"name": "shar-office", "title": "Шар · Офис", "version": "1.0.0"}
INSTRUCTIONS = (
    "Документы, заметки, таблицы и презентации «Офиса» Шара — от имени владельца ключа и с его правами. "
    "Сначала найдите материал (list_items, list_folders), потом читайте (read_item) и правьте. "
    "Правки видны коллегам сразу, прежние версии остаются в истории версий материала."
)
CALLS_PER_MINUTE = 120


def _error(rpc_id: Any, code: int, message: str, status: int = 200) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}, status_code=status)


def _result(rpc_id: Any, result: dict[str, Any]) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "result": result})


@router.get("/api/mcp")
def mcp_get():
    # Поток событий сервера не нужен: все ответы — в ответ на POST.
    return Response(status_code=405, headers={"Allow": "POST"})


@router.post("/api/mcp")
async def mcp_post(request: Request):
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    me = await run_in_threadpool(keys.identity_for_token, token) if token else None
    if me is None:
        return JSONResponse({"error": "Нужен ключ MCP: Настройки → MCP"}, status_code=401,
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
            "instructions": INSTRUCTIONS,
        })
    if method == "ping":
        return _result(rpc_id, {})
    if method == "tools/list":
        return _result(rpc_id, {"tools": tools.describe()})
    if method == "tools/call":
        name = str(params.get("name") or "")
        tool = tools.BY_NAME.get(name)
        if tool is None:
            return _error(rpc_id, -32602, f"Нет инструмента {name}")
        if not limiter.allow(f"mcp:{me.user_id}", CALLS_PER_MINUTE, 60):
            return _result(rpc_id, {"isError": True, "content": [{"type": "text", "text": "Слишком много вызовов, подождите минуту"}]})
        args = params.get("arguments") or {}
        try:
            data = await run_in_threadpool(tool["handler"], me, args if isinstance(args, dict) else {})
        except tools.ToolError as exc:
            return _result(rpc_id, {"isError": True, "content": [{"type": "text", "text": str(exc)}]})
        except Exception as exc:  # сбой инструмента — агенту понятной ошибкой, в лог — целиком
            log.exception("mcp tool %s failed for %s", name, me.user_id)
            return _result(rpc_id, {"isError": True, "content": [{"type": "text", "text": f"Не получилось: {exc}"}]})
        return _result(rpc_id, {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}], "structuredContent": data})
    return _error(rpc_id, -32601, f"Method not found: {method}")
