from __future__ import annotations

import json
import logging
import time as _time
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.config import settings
from app.core.ratelimit import limiter
from app.core.security import Identity, require_admin
from app.modules.users.router import _normalize_dt

router = APIRouter()

logger = logging.getLogger(__name__)


# ── Client error telemetry ───────────────────────────────────────────────────
# Lightweight capture so on-device failures (iOS keyboard, PWA offline, routing,
# render crashes) surface as real data instead of "a user said it broke". The
# frontend (lib/telemetry.ts) ships window.onerror / unhandledrejection / React
# error-boundary events here; we log them (visible in journalctl) and append to a
# capped JSONL file in runtime-data. Deliberately tiny — no DB table, self-rotating
# so it can't fill the small VPS disk.
class ClientErrorBody(BaseModel):
    message: str
    kind: Optional[str] = "error"          # error | unhandledrejection | react | manual
    stack: Optional[str] = None
    url: Optional[str] = None
    userId: Optional[str] = None
    userName: Optional[str] = None
    userAgent: Optional[str] = None
    appVersion: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None


_CLIENT_ERRORS_DIR = settings.data_dir / "runtime"


_CLIENT_ERRORS_FILE = _CLIENT_ERRORS_DIR / "client-errors.jsonl"


_CLIENT_ERRORS_LOCK = Lock()


_CLIENT_ERRORS_MAX_BYTES = 3 * 1024 * 1024   # rotate (keep tail) past ~3MB


_CLIENT_ERRORS_RETENTION_DAYS = 3            # errors "live" ~3 days, then get pruned


def _client_error_within_retention(line: str, cutoff: datetime) -> bool:
    """Keep a JSONL line only if its ts is newer than cutoff. Unparseable/undated
    lines are kept (fail-open) — better to over-retain than silently drop data."""
    try:
        ts = _normalize_dt(json.loads(line).get("ts"))
        return ts is None or ts >= cutoff
    except Exception:
        return True


def _persist_error_entry(entry: dict) -> None:
    """Append one error record to the shared JSONL store (client + server + health
    all land here so the admin console is a single pane). Lock-guarded, with a
    size-triggered rotate that also drops by age. Never raises."""
    try:
        with _CLIENT_ERRORS_LOCK:
            _CLIENT_ERRORS_DIR.mkdir(parents=True, exist_ok=True)
            # On a size-triggered rotation, drop by age (3d) as well as by count —
            # so a burst can't push out still-recent errors, and stale ones age out.
            try:
                if _CLIENT_ERRORS_FILE.exists() and _CLIENT_ERRORS_FILE.stat().st_size > _CLIENT_ERRORS_MAX_BYTES:
                    cutoff = datetime.now(timezone.utc) - timedelta(days=_CLIENT_ERRORS_RETENTION_DAYS)
                    lines = _CLIENT_ERRORS_FILE.read_text(encoding="utf-8", errors="ignore").splitlines()
                    kept = [ln for ln in lines if _client_error_within_retention(ln, cutoff)][-2000:]
                    _CLIENT_ERRORS_FILE.write_text("\n".join(kept) + "\n", encoding="utf-8")
            except Exception:
                pass
            with _CLIENT_ERRORS_FILE.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.warning(f"[client-error] persist failed: {e}")


# De-dupe identical server/health messages so one broken endpoint hit repeatedly (or
# a subsystem that stays down) doesn't flood the console — collapse to one line per
# (kind, message) within this window.
_SERVER_ERROR_DEDUPE_SECONDS = 60


_server_error_last: Dict[str, float] = {}


def record_server_error(kind: str, message: str, stack: Optional[str] = None,
                        url: Optional[str] = None, extra: Optional[Dict[str, Any]] = None) -> None:
    """Record a backend-side problem (unhandled exception, failed health probe) into
    the same store the client errors use, so it surfaces in the admin console."""
    key = f"{kind}:{message[:200]}"
    now = _time.monotonic()
    last = _server_error_last.get(key, 0.0)
    if now - last < _SERVER_ERROR_DEDUPE_SECONDS:
        return
    _server_error_last[key] = now
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "ip": None,
        "kind": (kind or "server")[:40],
        "message": (message or "")[:2000],
        "stack": (stack or "")[:8000] if stack else None,
        "url": (url or "")[:1000],
        "userId": None,
        "userName": "server",
        "userAgent": "backend",
        "appVersion": None,
        "extra": extra,
    }
    logger.warning(f"[server-error] {entry['kind']} :: {entry['message'][:200]} @ {entry['url']}")
    _persist_error_entry(entry)


@router.post("/api/client-errors")
def report_client_error(body: ClientErrorBody, request: Request):
    # Маршрут открыт без сессии (ошибки экрана входа тоже нужны), поэтому он режется
    # по частоте и размеру: иначе это бесплатная запись в файл для кого угодно.
    ip = request.client.host if request.client else "?"
    if not limiter.allow(f"client-errors:{ip}", 60, 60):
        return JSONResponse({"ok": False}, status_code=429)
    extra = body.extra
    if extra is not None and len(json.dumps(extra, ensure_ascii=False, default=str)) > 4000:
        extra = {"truncated": True}
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "ip": request.client.host if request.client else None,
        "kind": (body.kind or "error")[:40],
        "message": (body.message or "")[:2000],
        "stack": (body.stack or "")[:8000] if body.stack else None,
        "url": (body.url or "")[:1000],
        "userId": ((body.userId or "")[:100] or None),
        "userName": ((body.userName or "")[:200] or None),
        "userAgent": (body.userAgent or "")[:500],
        "appVersion": ((body.appVersion or "")[:80] or None),
        "extra": extra,
    }
    logger.warning(
        f"[client-error] {entry['kind']} u={entry.get('userName') or entry.get('userId')} "
        f":: {entry['message'][:200]} @ {entry['url']}"
    )
    _persist_error_entry(entry)
    return {"ok": True}


@router.get("/api/client-errors")
def get_client_errors(limit: int = 200, me: Identity = Depends(require_admin)):  # me=None при вызове из админки (там своя зависимость)
    """Recent client errors, newest first (admin console). Prunes anything past the
    retention window on read, so viewing the console also keeps the file trimmed."""
    try:
        if not _CLIENT_ERRORS_FILE.exists():
            return {"errors": [], "retentionDays": _CLIENT_ERRORS_RETENTION_DAYS}
        cutoff = datetime.now(timezone.utc) - timedelta(days=_CLIENT_ERRORS_RETENTION_DAYS)
        with _CLIENT_ERRORS_LOCK:
            lines = _CLIENT_ERRORS_FILE.read_text(encoding="utf-8", errors="ignore").splitlines()
            kept = [ln for ln in lines if _client_error_within_retention(ln, cutoff)]
            if len(kept) != len(lines):
                _CLIENT_ERRORS_FILE.write_text(("\n".join(kept) + "\n") if kept else "", encoding="utf-8")
        out = []
        for ln in kept[-max(1, min(limit, 1000)):]:
            try:
                out.append(json.loads(ln))
            except Exception:
                pass
        out.reverse()
        return {"errors": out, "retentionDays": _CLIENT_ERRORS_RETENTION_DAYS, "total": len(kept)}
    except Exception as e:
        return {"errors": [], "error": str(e)}


async def unhandled_exception_to_console(request: Request, exc: Exception):
    """Catch-all for unhandled server exceptions: record them in the same admin
    console the client errors use (kind "server"), then return a plain 500. HTTP
    4xx/validation errors have their own handlers and don't reach here, so this is
    only genuine backend faults."""
    import traceback as _tb
    try:
        record_server_error(
            "server",
            f"{type(exc).__name__}: {exc}",
            stack="".join(_tb.format_exception(type(exc), exc, exc.__traceback__)),
            url=str(getattr(request, "url", "") and request.url.path),
            extra={"method": request.method},
        )
    except Exception:
        pass
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


def clear_errors() -> None:
    with _CLIENT_ERRORS_LOCK:
        if _CLIENT_ERRORS_FILE.exists():
            _CLIENT_ERRORS_FILE.write_text("", encoding="utf-8")
