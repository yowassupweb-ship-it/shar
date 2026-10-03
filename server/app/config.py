"""Настройки сервиса — только из окружения, один раз при старте.

Всё, что раньше читалось через os.getenv по разным файлам бэкенда, собрано
здесь: одно место, где видно, чем управляется сервис (список — .env.example).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent


def _flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    return default if raw is None else raw.strip().lower() not in ("0", "false", "no", "")


def _csv(name: str, default: str) -> tuple[str, ...]:
    return tuple(p.strip() for p in os.getenv(name, default).split(",") if p.strip())


def _path(name: str, default: Path) -> Path:
    raw = os.getenv(name, "").strip()
    return Path(raw).expanduser() if raw else default


@dataclass(frozen=True)
class Settings:
    # --- сервис ---
    host: str = "127.0.0.1"
    port: int = 8100
    # Откуда браузеру можно ходить с куками. Пустой список — только тот же origin.
    cors_origins: tuple[str, ...] = ()

    # --- сессии и доступ ---
    enforce_auth: bool = True
    session_cache_ttl: float = 15.0
    # Обмен старой localStorage-«авторизации» на серверную сессию. Нужен только
    # на время перехода: открытая дверь для любого, кто знает логин.
    legacy_adopt: bool = False
    # Server-to-server: бэкенд зовёт сам себя и внешние системы (X-Shar-* ключи).
    internal_push_key: str = ""
    integration_api_key: str = ""
    admin_token: str = ""
    # Ключ шифрования секретов в базе (пароли почтовых ящиков). Любая строка.
    secret_key: str = ""

    # --- хранилища ---
    redis_url: str = "redis://127.0.0.1:6379/0"
    data_dir: Path = SERVER_ROOT / "data"
    uploads_dir: Path = SERVER_ROOT / "data" / "uploads"
    # Каталог JSON-файлов старого Next (data/*.json) — разовый импорт в Postgres.
    legacy_data_dir: Path | None = None

    # --- web-push (VAPID) ---
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:admin@shar-os.local"

    # --- фоновые задачи ---
    mail_watch: bool = True
    auto_migrate: bool = True

    # --- лимиты ---
    max_upload_bytes: int = 200 * 1024 * 1024
    client_errors_max_bytes: int = 256 * 1024
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Settings":
        data_dir = _path("SHAR_DATA_DIR", SERVER_ROOT / "data")
        legacy = os.getenv("SHAR_LEGACY_DATA_DIR", "").strip()
        return cls(
            host=os.getenv("SHAR_V2_HOST", "127.0.0.1"),
            port=int(os.getenv("SHAR_V2_PORT", "8100")),
            cors_origins=_csv("CORS_ORIGINS", ""),
            enforce_auth=_flag("SHAR_ENFORCE_AUTH", True),
            session_cache_ttl=float(os.getenv("SHAR_SESSION_CACHE_TTL", "15")),
            legacy_adopt=_flag("SHAR_LEGACY_ADOPT", False),
            internal_push_key=os.getenv("SHAR_INTERNAL_PUSH_KEY", "").strip(),
            integration_api_key=os.getenv("SHAR_INTEGRATION_API_KEY", "").strip(),
            admin_token=os.getenv("SHAR_ADMIN_TOKEN", "").strip(),
            secret_key=os.getenv("SHAR_SECRET_KEY", "").strip(),
            redis_url=os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0"),
            data_dir=data_dir,
            uploads_dir=_path("SHAR_UPLOADS_DIR", data_dir / "uploads"),
            legacy_data_dir=Path(legacy).expanduser() if legacy else None,
            vapid_public_key=(os.getenv("WEB_PUSH_PUBLIC_KEY") or os.getenv("NEXT_PUBLIC_WEB_PUSH_PUBLIC_KEY") or "").strip(),
            vapid_private_key=os.getenv("WEB_PUSH_PRIVATE_KEY", "").strip(),
            vapid_subject=os.getenv("WEB_PUSH_SUBJECT", "mailto:admin@shar-os.local").strip(),
            mail_watch=_flag("SHAR_MAIL_WATCH", True),
            auto_migrate=_flag("SHAR_AUTO_MIGRATE", True),
            max_upload_bytes=int(os.getenv("SHAR_MAX_UPLOAD_BYTES", str(200 * 1024 * 1024))),
        )


settings = Settings.from_env()
