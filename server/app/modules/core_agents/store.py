"""Данные агентов «Ядра»: ноды, личные подключения, очередь задач ноде, расход.

Схема работы (решение — MBOX #589, заметка «AI-нода Шара»):
  - Агенты работают ТОЛЬКО на ноде — отдельном сервере компании. Нода сама звонит в Шар (исходящие HTTPS-запросы,
    длинный опрос): ей не нужен белый адрес, а Шару — доступ к ней по SSH.
  - У каждого человека свои подключения: Gemini — его ключ Google Cloud (хранится у нас зашифрованным, отдаётся ноде
    только на время запуска), Claude и GPT (Codex) — вход в его подписку. Вход идёт в CLI на ноде, в личном каталоге
    человека: учётные данные подписки лежат на ноде и никуда не уходят. Поэтому человек «привязан» к ноде, где входил.
  - Инструменты Шара агент получает по MCP (/api/mcp) с ключом на один запуск: права человека, журнал, отзыв в конце.
  - Профиль, память и навыки — в базе Шара (memory.py), а не на ноде.

Таблицы:
  core_nodes     ноды: токен (только SHA-256), что на ней стоит, когда была на связи
  core_accounts  подключение человека к провайдеру: состояние, ключ (Gemini, шифр), учётка, нода, ход входа
  core_jobs      задачи ноде: run (ответить в чате), login / login_code / logout / check
  core_usage     расход по дням: запуски, токены, приблизительная цена (только для оплаты по ключу — Gemini)
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
from typing import Any, Optional

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings
from app.core import schema
from app.core.db import db
from app.core.db.connection import Json

log = logging.getLogger("shar.core.agents")

NODE_PREFIX = "shar_node_"
ONLINE_SECONDS = 75
PROVIDERS = {
    "gemini": {"label": "Gemini", "vendor": "Google", "how": "key"},
    "claude": {"label": "Claude", "vendor": "Anthropic", "how": "login"},
    "codex": {"label": "GPT", "vendor": "OpenAI (Codex)", "how": "login"},
}
# Модели подписок — псевдонимы самих CLI: они сами ведут их к актуальным версиям.
# Модели подписок нода узнаёт у самого провайдера (kit/shar-node.mjs: modelsOf) — пока не узнала, CLI берёт свою.
def pick_models(provider: str, models: list[dict], current: str = "") -> tuple[list[dict], str]:
    """Список моделей от ноды и модель по умолчанию: выбранная человеком, если она ещё есть; иначе для Claude —
    новейший Sonnet (баланс скорости и ума), для остальных — первая в каталоге."""
    clean = [{"id": str(m.get("id") or ""), "label": str(m.get("label") or m.get("id") or "")} for m in models if m.get("id")][:40]
    ids = [m["id"] for m in clean]
    if current in ids:
        return clean, current
    if provider == "claude":
        sonnet = next((m for m in ids if "sonnet" in m), "")
        return clean, sonnet or (ids[0] if ids else "")
    return clean, ids[0] if ids else ""
# Цены Gemini API за 1 млн токенов, $ (вход / выход), сверенные 29.10.2026 (MBOX #589). Модель без цены здесь —
# считаем только токены, деньги не выдумываем. Кэш считаем по цене входа (верхняя оценка).
# Подписки Claude и GPT денег за токены не берут — цену не считаем.
GEMINI_PRICES = {"flash-lite": (0.30, 2.50)}

schema.register("core_agents", """
CREATE TABLE IF NOT EXISTS core_nodes (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_start TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    info JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_seen TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS core_accounts (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'none',
    secret_enc TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    models JSONB NOT NULL DEFAULT '[]'::jsonb,
    node_id BIGINT,
    login JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS core_jobs (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    node_id BIGINT,
    message_id TEXT NOT NULL DEFAULT '',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'queued',
    mcp_key_id BIGINT,
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    taken_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);
-- Последние окна лимита подписки (Claude: пятичасовое, недельное) — нода присылает после каждого ответа.
ALTER TABLE core_accounts ADD COLUMN IF NOT EXISTS limits JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_core_jobs_queue ON core_jobs(status, id) WHERE status IN ('queued', 'taken');
CREATE INDEX IF NOT EXISTS idx_core_jobs_message ON core_jobs(message_id) WHERE message_id <> '';
CREATE TABLE IF NOT EXISTS core_usage (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    day DATE NOT NULL DEFAULT current_date,
    runs INTEGER NOT NULL DEFAULT 0,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    cached_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    cost_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, provider, day)
);
""")


def ready() -> bool:
    from app.modules.workspace import store  # поздний импорт: workspace тянет S3

    return store.table_ready("core_usage")


# ── шифр ключей ──────────────────────────────────────────────────────────────

def _fernet() -> Optional[Fernet]:
    if not settings.secret_key:
        return None
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(("shar-core:" + settings.secret_key).encode()).digest()))


def seal(value: str) -> str:
    f = _fernet()
    if f is None:
        raise RuntimeError("На сервере не задан SHAR_SECRET_KEY: ключи хранить нечем")
    return f.encrypt(value.encode()).decode()


def unseal(value: str) -> str:
    f = _fernet()
    if f is None or not value:
        return ""
    try:
        return f.decrypt(value.encode()).decode()
    except InvalidToken:
        return ""


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_node_token() -> str:
    return NODE_PREFIX + secrets.token_urlsafe(32)


# ── ноды ─────────────────────────────────────────────────────────────────────

def node_by_token(token: str) -> Optional[dict]:
    if not token.startswith(NODE_PREFIX):
        return None
    return db.conn.fetch_one("SELECT * FROM core_nodes WHERE token_hash = %s AND enabled", (token_hash(token),))


def online_nodes() -> list[dict]:
    return db.conn.fetch_all(
        f"SELECT * FROM core_nodes WHERE enabled AND last_seen > now() - interval '{ONLINE_SECONDS} seconds' ORDER BY last_seen DESC") or []


def node_online(node_id: Any) -> bool:
    if not node_id:
        return False
    return bool(db.conn.fetch_one(
        f"SELECT 1 AS ok FROM core_nodes WHERE id = %s AND enabled AND last_seen > now() - interval '{ONLINE_SECONDS} seconds'", (int(node_id),)))


def node_has(node: dict, provider: str) -> bool:
    """Стоит ли на ноде CLI провайдера (нода сообщает это при каждом опросе)."""
    return bool(((node.get("info") or {}).get("clis") or {}).get(provider))


# ── подключения ──────────────────────────────────────────────────────────────

def account(user_id: str, provider: str) -> dict:
    row = db.conn.fetch_one("SELECT * FROM core_accounts WHERE user_id = %s AND provider = %s", (user_id, provider))
    return row or {"user_id": user_id, "provider": provider, "state": "none", "secret_enc": "", "account": "", "model": "",
                   "models": [], "node_id": None, "login": {}, "error": ""}


def save_account(user_id: str, provider: str, **fields: Any) -> dict:
    current = account(user_id, provider)
    merged = {**current, **fields}
    row = db.conn.fetch_one(
        """INSERT INTO core_accounts (user_id, provider, state, secret_enc, account, model, models, node_id, login, error)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (user_id, provider) DO UPDATE SET state = EXCLUDED.state, secret_enc = EXCLUDED.secret_enc,
             account = EXCLUDED.account, model = EXCLUDED.model, models = EXCLUDED.models, node_id = EXCLUDED.node_id,
             login = EXCLUDED.login, error = EXCLUDED.error, updated_at = now()
           RETURNING *""",
        (user_id, provider, merged["state"], merged["secret_enc"], merged["account"], merged["model"], Json(merged["models"] or []),
         merged["node_id"], Json(merged["login"] or {}), merged["error"] or ""))
    return row


def public_account(row: dict) -> dict:
    provider = row["provider"]
    meta = PROVIDERS[provider]
    node_ok = node_online(row.get("node_id")) if meta["how"] == "login" else bool(online_nodes())
    models = row.get("models") or [{"id": "", "label": "по умолчанию"}]
    secret = unseal(row.get("secret_enc") or "") if meta["how"] == "key" else ""
    return {
        "provider": provider, "label": meta["label"], "vendor": meta["vendor"], "how": meta["how"], "state": row["state"],
        "account": row.get("account") or "", "model": row.get("model") or (models[0]["id"] if models else ""), "models": models,
        "keyHint": f"…{secret[-4:]}" if secret else "", "nodeOnline": node_ok, "error": row.get("error") or "",
        "login": row.get("login") or {}, "limits": row.get("limits") or [],
        "updatedAt": row["updated_at"].isoformat() if row.get("updated_at") else None,
    }


def ready_agents(user_id: str) -> list[dict]:
    """Кому из своих агентов человек может написать прямо сейчас (подключён и нода на связи)."""
    rows = db.conn.fetch_all("SELECT * FROM core_accounts WHERE user_id = %s AND state = 'ready'", (user_id,)) or []
    out = []
    for row in sorted(rows, key=lambda r: list(PROVIDERS).index(r["provider"]) if r["provider"] in PROVIDERS else 9):
        if row["provider"] in PROVIDERS:
            out.append(public_account(row))
    return out


# ── задачи ноде ──────────────────────────────────────────────────────────────

def enqueue(kind: str, user_id: str, provider: str, *, node_id: Any = None, message_id: str = "", payload: Optional[dict] = None) -> dict:
    return db.conn.fetch_one(
        "INSERT INTO core_jobs (kind, user_id, provider, node_id, message_id, payload) VALUES (%s, %s, %s, %s, %s, %s) RETURNING *",
        (kind, user_id, provider, int(node_id) if node_id else None, message_id, Json(payload or {})))


def claim(node: dict) -> Optional[dict]:
    """Взять задачу: свою (закреплённую за нодой) или общую, если на ноде есть нужный CLI. Протухшее в очереди — снимаем."""
    db.conn.execute_query(
        "UPDATE core_jobs SET status = 'failed', error = 'Нода не взяла задачу за 10 минут', finished_at = now() "
        "WHERE status = 'queued' AND created_at < now() - interval '10 minutes'")
    clis = [p for p in PROVIDERS if node_has(node, p)]
    return db.conn.fetch_one(
        """UPDATE core_jobs SET status = 'taken', node_id = %s, taken_at = now()
           WHERE id = (SELECT id FROM core_jobs WHERE status = 'queued'
                       AND (node_id = %s OR (node_id IS NULL AND provider = ANY(%s)))
                       ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
           RETURNING *""", (node["id"], node["id"], clis))


def finish_job(job_id: Any, status: str, error: str = "") -> Optional[dict]:
    row = db.conn.fetch_one(
        "UPDATE core_jobs SET status = %s, error = %s, finished_at = now() WHERE id = %s AND status IN ('queued', 'taken') RETURNING *",
        (status, error[:600], int(job_id)))
    if row and row.get("mcp_key_id"):
        db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s AND revoked_at IS NULL", (row["mcp_key_id"],))
    return row


def cancel_by_message(message_id: str) -> None:
    """Человек нажал «Остановить»: задача снимается, ключ MCP отзывается сразу, нода узнает при следующем опросе."""
    for row in db.conn.fetch_all("SELECT id FROM core_jobs WHERE message_id = %s AND status IN ('queued', 'taken')", (message_id,)) or []:
        finish_job(row["id"], "cancelled")


def job(job_id: Any, node_id: Any) -> Optional[dict]:
    return db.conn.fetch_one("SELECT * FROM core_jobs WHERE id = %s AND node_id = %s", (int(job_id), int(node_id)))


def cancelled_among(node_id: Any, job_ids: list[Any]) -> list[str]:
    """Какие из идущих на ноде запусков человек остановил (или их сообщение уже не ждёт ответа)."""
    ids = [int(j) for j in job_ids if str(j).isdigit()]
    if not ids:
        return []
    rows = db.conn.fetch_all(
        """SELECT j.id FROM core_jobs j LEFT JOIN core_messages m ON m.id = j.message_id
           WHERE j.id = ANY(%s) AND j.node_id = %s
             AND (j.status NOT IN ('queued', 'taken') OR (j.kind = 'run' AND (m.id IS NULL OR m.status = 'cancelled')))""",
        (ids, int(node_id))) or []
    return [str(r["id"]) for r in rows]


# ── расход ───────────────────────────────────────────────────────────────────

def price(provider: str, model: str, work: dict) -> float:
    if provider != "gemini":
        return 0.0
    tier = next((GEMINI_PRICES[k] for k in GEMINI_PRICES if k in (model or "").lower()), None)
    if tier is None:
        return 0.0
    out = int(work.get("output_tokens") or 0) + int(work.get("thinking_tokens") or 0)
    return round((int(work.get("input_tokens") or 0) * tier[0] + out * tier[1]) / 1_000_000, 4)


def add_usage(user_id: str, provider: str, model: str, work: dict) -> float:
    cost = price(provider, model, work)
    db.conn.execute_query(
        """INSERT INTO core_usage (user_id, provider, runs, input_tokens, cached_tokens, output_tokens, cost_usd)
           VALUES (%s, %s, 1, %s, %s, %s, %s)
           ON CONFLICT (user_id, provider, day) DO UPDATE SET runs = core_usage.runs + 1,
             input_tokens = core_usage.input_tokens + EXCLUDED.input_tokens, cached_tokens = core_usage.cached_tokens + EXCLUDED.cached_tokens,
             output_tokens = core_usage.output_tokens + EXCLUDED.output_tokens, cost_usd = core_usage.cost_usd + EXCLUDED.cost_usd""",
        (user_id, provider, int(work.get("input_tokens") or 0), int(work.get("cached_input_tokens") or 0),
         int(work.get("output_tokens") or 0) + int(work.get("thinking_tokens") or 0), cost))
    return cost


def usage(user_id: Optional[str], days: int = 30) -> list[dict]:
    """Расход по дням и провайдерам; user_id = None — по всей компании (для админа), с разбивкой по людям."""
    where, params = "day > current_date - %s", [days]
    if user_id:
        where += " AND user_id = %s"
        params.append(user_id)
    rows = db.conn.fetch_all(
        f"""SELECT user_id, provider, sum(runs)::int AS runs, sum(input_tokens)::bigint AS input, sum(cached_tokens)::bigint AS cached,
                   sum(output_tokens)::bigint AS output, sum(cost_usd)::float AS cost, max(day) AS last_day
            FROM core_usage WHERE {where} GROUP BY user_id, provider ORDER BY sum(cost_usd) DESC, sum(input_tokens) DESC""",
        tuple(params)) or []
    return [{"userId": r["user_id"], "provider": r["provider"], "runs": r["runs"], "inputTokens": int(r["input"]), "cachedTokens": int(r["cached"]),
             "outputTokens": int(r["output"]), "costUsd": round(r["cost"] or 0, 4), "lastDay": r["last_day"].isoformat()} for r in rows]


def usage_days(user_id: str, days: int = 30) -> list[dict]:
    rows = db.conn.fetch_all(
        "SELECT day, provider, runs, input_tokens + output_tokens AS tokens, cost_usd::float AS cost FROM core_usage "
        "WHERE user_id = %s AND day > current_date - %s ORDER BY day", (user_id, days)) or []
    return [{"day": r["day"].isoformat(), "provider": r["provider"], "runs": r["runs"], "tokens": int(r["tokens"]), "costUsd": r["cost"]} for r in rows]
