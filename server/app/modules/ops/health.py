"""Здоровье сервиса для мониторинга: база и Redis. Без секретов и подробностей."""

from __future__ import annotations

import asyncio

import anyio.to_thread
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.core.db import db
from app.core.realtime import redis_client

router = APIRouter(tags=["health"])


def _db_ok() -> bool:
    return db.conn.fetch_one("SELECT 1 AS ok") is not None


async def _check(coro) -> str:
    try:
        await asyncio.wait_for(coro, timeout=3)
        return "ok"
    except Exception as exc:  # причину не раскрываем наружу — она в логах
        return type(exc).__name__


@router.get("/api/v2/health")
async def health():
    async def db_probe():
        if not await anyio.to_thread.run_sync(_db_ok):
            raise RuntimeError("db")

    db_state, redis_state = await asyncio.gather(_check(db_probe()), _check(redis_client.ping()))
    ok = db_state == "ok"  # Redis не критичен: сокеты деградируют до опроса
    return JSONResponse({"status": "ok" if ok else "degraded", "db": db_state, "redis": redis_state}, status_code=200 if ok else 503)
