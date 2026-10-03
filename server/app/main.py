"""Шар v2 API — самостоятельный бэкенд.

Порядок обработки запроса:
  1. CORS и лог медленных/ошибочных запросов;
  2. auth-middleware: сессия и права (app/core/security.py);
  3. роутер модуля из app/modules/*.

Запуск: uvicorn app.main:app --port 8100  (или python -m app)
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import Settings
from app.core import lifecycle
from app.core.security import AuthGate, SessionVerifier, session_cookie_value
from app.modules import ROUTERS
from app.modules.ops.client_errors import unhandled_exception_to_console

log = logging.getLogger("shar")

_SLOW_REQUEST_SECONDS = float(os.getenv("SHAR_SLOW_REQUEST_SECONDS", "3"))
_LOG_ALL_REQUESTS = os.getenv("SHAR_LOG_ALL", "").strip().lower() in ("1", "true", "yes")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        verifier = SessionVerifier(settings.session_cache_ttl)
        app.state.settings = settings
        app.state.verifier = verifier
        app.state.gate = AuthGate(verifier, enforce=settings.enforce_auth, internal_key=settings.internal_push_key)
        async with lifecycle.run(settings):
            yield

    app = FastAPI(title="Шар v2 API", lifespan=lifespan, docs_url="/api/v2/docs", openapi_url="/api/v2/openapi.json", redoc_url=None)

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.middleware("http")
    async def access_log(request: Request, call_next):
        started = time.monotonic()
        response = await call_next(request)
        elapsed = time.monotonic() - started
        if _LOG_ALL_REQUESTS:
            log.info("%s %s -> %s (%.2fs)", request.method, request.url.path, response.status_code, elapsed)
        elif response.status_code >= 400:
            log.warning("%s %s -> %s", request.method, request.url.path, response.status_code)
        elif elapsed >= _SLOW_REQUEST_SECONDS:
            log.warning("SLOW %s %s -> %s (%.1fs)", request.method, request.url.path, response.status_code, elapsed)
        return response

    # Объявлен после access_log, значит выполняется раньше него (внешний слой — последний).
    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        gate: AuthGate = request.app.state.gate
        decision = await gate.check(
            request.method, request.url.path, dict(request.query_params), {k.lower(): v for k, v in request.headers.items()}
        )
        if not decision.allowed:
            return JSONResponse({"error": decision.error}, status_code=decision.status)
        request.state.identity = decision.identity
        response = await call_next(request)
        if request.url.path == "/api/auth/logout":
            request.app.state.verifier.forget(session_cookie_value(request.headers.get("cookie", "")))
        return response

    app.add_exception_handler(Exception, unhandled_exception_to_console)
    for router in ROUTERS:
        app.include_router(router)
    return app


app = create_app()
