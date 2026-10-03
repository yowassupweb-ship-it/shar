"""Состояние сервера и разрешённые действия для админки.

Всё читается из /proc, systemctl и git без лишних зависимостей. Действия — только
из списка SHAR_ADMIN_ACTIONS (JSON: {"pull": ["shar", "pull"], ...}); строка от клиента
никогда не попадает в шелл (shell=False, фиксированный argv). Нет настройки — нет действий."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from typing import Any, Dict, List

from app.config import settings
from app.core.db import db
from app.core.storage import UPLOAD_DIR, s3_storage

SERVICES: List[str] = [s.strip() for s in os.getenv("SHAR_SERVICES", "shar-server,nginx,redis-server,postgresql").split(",") if s.strip()]
APP_DIR = os.getenv("SHAR_APP_DIR", "").strip()


def allowed_actions() -> Dict[str, List[str]]:
    try:
        raw = json.loads(os.getenv("SHAR_ADMIN_ACTIONS", "") or "{}")
    except ValueError:
        return {}
    return {str(k): [str(a) for a in v] for k, v in raw.items() if isinstance(v, list) and v and all(isinstance(a, (str, int)) for a in v)}


def _read_meminfo() -> Dict[str, int]:
    values: Dict[str, int] = {}
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                kb = rest.strip().split(" ")[0]
                if kb.isdigit():
                    values[key] = int(kb) * 1024
    except Exception:
        pass
    return values


def _run(argv: List[str], timeout: int = 5) -> str:
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return (out.stdout or out.stderr).strip()
    except Exception:
        return ""


def _database() -> Dict[str, Any]:
    info: Dict[str, Any] = {"kind": "postgresql"}
    try:
        row = db.conn.fetch_one("SELECT pg_database_size(current_database()) AS size_bytes, current_database() AS name, version() AS version")
        if row:
            info.update({"sizeBytes": int(row.get("size_bytes") or 0), "name": row.get("name"),
                         "version": str(row.get("version") or "").split(" on ")[0]})
        conns = db.conn.fetch_one("SELECT count(*) AS c FROM pg_stat_activity WHERE datname = current_database()")
        info["connections"] = int((conns or {}).get("c") or 0)
        tables = db.conn.fetch_all("SELECT relname AS name, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 8") or []
        info["topTables"] = [{"name": t.get("name"), "rows": int(t.get("rows") or 0)} for t in tables]
    except Exception as e:
        info["error"] = type(e).__name__
    return info


def _storage() -> Dict[str, Any]:
    storage: Dict[str, Any] = {"enabled": bool(s3_storage.enabled)}
    for attr in ("bucket", "endpoint", "region"):
        if getattr(s3_storage, attr, None):
            storage[attr] = str(getattr(s3_storage, attr))
    total = files = 0
    for root, _dirs, names in os.walk(UPLOAD_DIR):
        for name in names:
            try:
                total += os.path.getsize(os.path.join(root, name))
                files += 1
            except OSError:
                pass
    storage["localUploads"] = {"path": str(UPLOAD_DIR), "sizeBytes": total, "files": files}
    return storage


def _redis() -> Dict[str, Any]:
    try:
        import redis as sync_redis  # noqa: PLC0415

        info = sync_redis.Redis.from_url(settings.redis_url, socket_connect_timeout=2, socket_timeout=2).info()
        return {"connected": True, "version": info.get("redis_version"), "usedMemoryBytes": int(info.get("used_memory") or 0),
                "clients": int(info.get("connected_clients") or 0), "uptimeDays": int(info.get("uptime_in_days") or 0)}
    except Exception as e:
        return {"connected": False, "error": type(e).__name__}


def status() -> Dict[str, Any]:
    mem = _read_meminfo()
    total, available = mem.get("MemTotal", 0), mem.get("MemAvailable", 0)
    swap_total, swap_free = mem.get("SwapTotal", 0), mem.get("SwapFree", 0)
    try:
        du = shutil.disk_usage("/")
        disk = {"total": du.total, "used": du.used, "free": du.free}
    except Exception:
        disk = {"total": 0, "used": 0, "free": 0}
    uptime = 0.0
    try:
        with open("/proc/uptime") as fh:
            uptime = float(fh.read().split()[0])
    except Exception:
        pass
    try:
        load = list(os.getloadavg())
    except Exception:
        load = [0.0, 0.0, 0.0]
    return {
        "database": _database(),
        "storage": _storage(),
        "redis": _redis(),
        "memory": {"total": total, "available": available, "used": max(0, total - available),
                   "swapTotal": swap_total, "swapUsed": max(0, swap_total - swap_free)},
        "disk": disk,
        "uptimeSeconds": int(uptime),
        "loadAverage": load,
        "services": {name: (_run(["systemctl", "is-active", name]) or "unknown") for name in SERVICES},
        "commit": _run(["git", "-C", APP_DIR, "log", "--oneline", "-1"], 10) if APP_DIR else "",
        "journal": _run(["journalctl", "--disk-usage"], 10),
        "actions": sorted(allowed_actions()),
    }


def run_action(name: str) -> Dict[str, Any]:
    argv = allowed_actions().get(name)
    if not argv:
        raise KeyError(name)
    out = subprocess.run(argv, capture_output=True, text=True, timeout=900 if name == "pull" else 300)
    text = re.sub(r"\x1b\[[0-9;]*m", "", (out.stdout or "") + (out.stderr or ""))
    return {"action": name, "exitCode": out.returncode, "output": text[-8000:]}
