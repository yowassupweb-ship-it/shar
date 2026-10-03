from __future__ import annotations

import asyncio

import anyio.to_thread

from app.core.db import db
from app.core.realtime import redis_client
from app.modules.ops.client_errors import record_server_error


def _health_check_db() -> None:
    """Cheapest reachable DB round-trip — reads the single settings row. Raises if
    the database is unreachable, which the probe turns into a console entry."""
    db.get_settings()


_redis_ever_up = False  # only alert on Redis *going down*, not "never configured"


async def health_probe_loop() -> None:
    """Periodic backend self-check (the "API health" error-catcher): confirms the
    two external dependencies that actually break — Postgres and Redis — are
    reachable. Failures land in the admin error console (kind "health") so an
    outage surfaces without waiting for a user to hit a broken feature.

    Redis is optional here (the WS layer falls back to an in-memory queue), and
    local dev runs without it — so we only alert on Redis if it was reachable at
    least once this process's lifetime, i.e. a real regression rather than a
    never-configured local box. DB is always required, so it always alerts."""
    global _redis_ever_up
    await asyncio.sleep(20)  # let startup (DB warm-up, scheduler) settle first
    while True:
        try:
            try:
                await asyncio.wait_for(anyio.to_thread.run_sync(_health_check_db), timeout=10)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                record_server_error("health", f"DB unreachable: {type(e).__name__}: {e}", url="db")
            try:
                await asyncio.wait_for(redis_client.ping(), timeout=5)
                _redis_ever_up = True
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if _redis_ever_up:
                    record_server_error("health", f"Redis unreachable: {type(e).__name__}: {e}", url="redis")
        except asyncio.CancelledError:
            break
        except Exception:
            pass
        await asyncio.sleep(120)  # every ~2 min
