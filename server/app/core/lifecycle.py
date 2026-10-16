"""Запуск и остановка сервиса: прогрев базы, фоновые задачи, наблюдение за почтой."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import anyio.to_thread

from app.config import Settings
from app.core.db import db
from app.core.realtime import redis_fanout_loop, sse_manager

log = logging.getLogger("shar.lifecycle")

# Каждый sync-роут идёт в пул потоков Starlette, а PostgresConnection держит ОДНО
# соединение на поток — значит размер пула и есть потолок одновременных соединений
# с Postgres. По умолчанию в anyio их 40: при шторме запросов (клиенты разом
# перешли на опрос) это 40 одновременных попыток подключения к базе с куда
# меньшим max_connections. Лишние запросы должны ждать в пуле (дёшево), а не
# ломиться в базу (дорого и каскадно).
DB_THREAD_POOL_SIZE = 20


async def _warm_db_connections(count: int) -> None:
    """Открыть соединение на каждом рабочем потоке заранее: холодное подключение
    к удалённому Postgres (DNS+TCP+TLS+auth) бывало до ~20 с, и первый запрос на
    новом потоке платил за него целиком."""

    def _warm_one() -> bool:
        try:
            conn = db.conn._get_thread_conn()
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.fetchall()
            cur.close()
            return True
        except Exception as e:
            log.warning("[DB warm-up] connection failed: %s", e)
            return False

    results = await asyncio.gather(*(anyio.to_thread.run_sync(_warm_one) for _ in range(count)), return_exceptions=True)
    log.info("[DB warm-up] %d/%d connections pre-warmed", sum(1 for r in results if r is True), count)


async def _safe_sync(label: str, fn) -> None:
    try:
        await anyio.to_thread.run_sync(fn)
    except Exception as e:  # старт не должен падать из-за разовой миграции
        log.warning("[%s] failed (non-fatal): %s", label, e)


@asynccontextmanager
async def run(settings: Settings):
    from app.core.legacy_import import import_legacy_data
    from app.modules.calendar.maintenance import migrate_legacy_calendar_rows
    from app.modules.calendar.reminders import reminder_loop
    from app.modules.calls.rooms import evict_disabled_users_from_calls
    from app.modules.mail import idle as mail_realtime
    from app.modules.mail.crypto import migrate_legacy_passwords
    from app.modules.ops.health_probe import health_probe_loop

    sse_manager.set_loop(asyncio.get_running_loop())
    anyio.to_thread.current_default_thread_limiter().total_tokens = DB_THREAD_POOL_SIZE
    try:
        # Ограничено: недоступная база задерживает старт на секунды, а не навсегда;
        # то, что не прогрелось, подключится лениво.
        await asyncio.wait_for(_warm_db_connections(DB_THREAD_POOL_SIZE), timeout=30.0)
    except asyncio.TimeoutError:
        log.warning("[DB warm-up] timed out after 30s — continuing, remaining connections will warm lazily")

    if settings.auto_migrate:
        from app import migrate  # noqa: PLC0415

        await anyio.to_thread.run_sync(migrate.run)  # без схемы сервис не стартует — ошибка видна сразу
    if settings.startup_maintenance:
        await _safe_sync("Mail secrets", migrate_legacy_passwords)
        await _safe_sync("Legacy data import", import_legacy_data)
        await _safe_sync("Calendar migration", migrate_legacy_calendar_rows)
        # Отключённого за время жизни процесса пользователя нужно вывести из конференций.
        await _safe_sync("calls eviction", evict_disabled_users_from_calls)
    else:
        log.info("startup maintenance disabled")

    tasks = [
        asyncio.create_task(health_probe_loop(), name="health-probe"),
        asyncio.create_task(redis_fanout_loop(), name="redis-fanout"),  # ОДНО pub/sub-соединение на процесс
    ]
    if settings.scheduled_jobs:
        tasks.append(asyncio.create_task(reminder_loop(), name="reminders"))
    else:
        log.info("scheduled jobs disabled")
    if settings.mail_watch:
        try:
            started = await anyio.to_thread.run_sync(mail_realtime.start_all)
            log.info("[Mail] watching %s mailboxes", started)
        except Exception as e:
            log.warning("[Mail] watchers did not start (non-fatal): %s", e)

    try:
        yield
    finally:
        mail_realtime.stop_all()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
