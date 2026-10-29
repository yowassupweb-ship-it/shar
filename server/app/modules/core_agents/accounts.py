"""Настройки → Ядро: личные подключения человека к агентам.

  GET    /api/core/accounts                       мои подключения, есть ли нода на связи, расход за 30 дней
  PUT    /api/core/accounts/gemini                {key} — ключ Google Cloud / AI Studio: проверяем у Google и сохраняем
  PATCH  /api/core/accounts/{provider}            {model} — модель по умолчанию
  POST   /api/core/accounts/{provider}/login      войти в подписку (claude, codex): нода запускает вход в CLI
  POST   /api/core/accounts/{provider}/login/code {code} — код со страницы входа (Claude просит вставить его обратно)
  DELETE /api/core/accounts/{provider}/login      отменить вход
  DELETE /api/core/accounts/{provider}            отключить (ключ стираем, на ноде — выход из CLI)
  GET    /api/core/usage?days=30&all=0            расход: мой; all=1 — по всей компании (админ)

Вход в подписку: Шар ставит ноде задачу login, нода запускает `claude auth login` / `codex login --device-auth`
в личном каталоге человека и присылает ссылку (и код у Codex). Человек открывает ссылку у себя и подтверждает —
дальше всё работает само. Ход входа нода пишет в core_accounts.login, интерфейс видит его живым событием.
"""

from __future__ import annotations

import logging
import re

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.db import db
from app.core.security import Identity, current_identity
from app.modules.core_agents import store

router = APIRouter()
log = logging.getLogger("shar.core.agents")

GOOGLE_MODELS = "https://generativelanguage.googleapis.com/v1beta/models"


def _guard(me: Identity) -> None:
    from app.modules.core_chat.router import allowed

    if not allowed(me):
        raise HTTPException(status_code=403, detail="«Ядро» вам пока не включено — его включает администратор")
    if not store.ready():
        raise HTTPException(status_code=503, detail="Агенты ещё не включены на сервере: нужна схема (выкладка с -Schema)")


def _provider(name: str) -> str:
    if name not in store.PROVIDERS:
        raise HTTPException(status_code=404, detail="Нет такого агента")
    return name


def push_account(user_id: str, provider: str) -> None:
    """Живое обновление карточки подключения (ход входа, готово, ошибка)."""
    try:
        from app.core.realtime import sse_manager

        sse_manager.push(user_id, {"type": "core_account", "account": store.public_account(store.account(user_id, provider))})
    except Exception as exc:  # noqa: BLE001
        log.debug("core: account push failed: %s", exc)


def _overview(me: Identity) -> dict:
    accounts = [store.public_account(store.account(me.user_id, p)) for p in store.PROVIDERS]
    nodes = store.online_nodes()
    return {"accounts": accounts, "node": {"online": bool(nodes), "clis": sorted({p for n in nodes for p in store.PROVIDERS if store.node_has(n, p)})},
            "usage": store.usage(me.user_id, 30)}


@router.get("/api/core/accounts")
def list_accounts(me: Identity = Depends(current_identity)):
    _guard(me)
    return _overview(me)


# ── Gemini по ключу ──────────────────────────────────────────────────────────

class GeminiBody(BaseModel):
    key: str = Field(min_length=20, max_length=200)


def _gemini_models(key: str) -> list[dict]:
    """Проверка ключа у Google: список моделей, которые им можно звать. Неверный ключ — понятная ошибка."""
    try:
        res = requests.get(GOOGLE_MODELS, params={"key": key, "pageSize": 200}, timeout=12)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Google не ответил: {exc.__class__.__name__}") from exc
    if res.status_code in (400, 401, 403):
        detail = ((res.json() if res.headers.get("content-type", "").startswith("application/json") else {}).get("error") or {}).get("message") or ""
        raise HTTPException(status_code=400, detail=f"Google не принял ключ{': ' + detail if detail else ''}")
    if not res.ok:
        raise HTTPException(status_code=502, detail=f"Google ответил {res.status_code}")
    models = []
    for m in res.json().get("models") or []:
        name = str(m.get("name") or "").removeprefix("models/")
        if not name.startswith("gemini") or "generateContent" not in (m.get("supportedGenerationMethods") or []):
            continue
        if any(x in name for x in ("embedding", "tts", "image", "audio", "live")):
            continue
        models.append({"id": name, "label": m.get("displayName") or name})
    # Сначала дешёвые и быстрые: Flash-Lite — по умолчанию (решение #589), дальше Flash и Pro; внутри — новые версии
    # выше, стабильные раньше превью.
    def rank(m: dict) -> tuple:
        version = re.match(r"gemini-(\d+(?:\.\d+)?)", m["id"])
        family = 0 if "flash-lite" in m["id"] else 1 if "flash" in m["id"] else 2
        return (family, -float(version.group(1)) if version else 0, "preview" in m["id"] or "exp" in m["id"], m["id"])

    return sorted(models, key=rank)[:30]


@router.put("/api/core/accounts/gemini")
def put_gemini(body: GeminiBody, me: Identity = Depends(current_identity)):
    _guard(me)
    key = body.key.strip()
    models = _gemini_models(key)
    if not models:
        raise HTTPException(status_code=400, detail="Ключ принят, но моделей Gemini для чата по нему нет — проверьте, что включён Gemini API")
    try:
        sealed = store.seal(key)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    current = store.account(me.user_id, "gemini")
    model = current.get("model") if any(m["id"] == current.get("model") for m in models) else models[0]["id"]
    store.save_account(me.user_id, "gemini", state="ready", secret_enc=sealed, models=models, model=model, account=f"ключ …{key[-4:]}", error="")
    push_account(me.user_id, "gemini")
    return _overview(me)


# ── модель, вход, выход ──────────────────────────────────────────────────────

class ModelBody(BaseModel):
    model: str = Field(default="", max_length=80)


@router.patch("/api/core/accounts/{provider}")
def set_model(provider: str, body: ModelBody, me: Identity = Depends(current_identity)):
    _guard(me)
    provider = _provider(provider)
    row = store.account(me.user_id, provider)
    models = row.get("models") or store.LOGIN_MODELS.get(provider, [])
    if body.model and not any(m["id"] == body.model for m in models):
        raise HTTPException(status_code=400, detail="Такой модели нет в списке")
    store.save_account(me.user_id, provider, model=body.model)
    push_account(me.user_id, provider)
    return _overview(me)


def _pick_node(provider: str) -> dict:
    """Нода для входа: где есть CLI провайдера и меньше всего людей с подпиской на ней."""
    nodes = [n for n in store.online_nodes() if store.node_has(n, provider)]
    if not nodes:
        raise HTTPException(status_code=409, detail="Нода агентов не на связи — попросите администратора её запустить")
    loads = {r["node_id"]: r["n"] for r in (db.conn.fetch_all(
        "SELECT node_id, count(*)::int AS n FROM core_accounts WHERE node_id IS NOT NULL GROUP BY node_id") or [])}
    return min(nodes, key=lambda n: loads.get(n["id"], 0))


@router.post("/api/core/accounts/{provider}/login")
def start_login(provider: str, me: Identity = Depends(current_identity)):
    _guard(me)
    provider = _provider(provider)
    if store.PROVIDERS[provider]["how"] != "login":
        raise HTTPException(status_code=400, detail="Сюда вход не нужен — вставьте ключ")
    row = store.account(me.user_id, provider)
    # Человек уже «живёт» на ноде (там его каталог) — входим там же, если она на связи.
    node = {"id": row["node_id"]} if row.get("node_id") and store.node_online(row["node_id"]) else _pick_node(provider)
    store.save_account(me.user_id, provider, state="pending" if row["state"] != "ready" else "ready", node_id=node["id"],
                       login={"state": "starting", "message": "Нода готовит вход…"}, error="")
    store.enqueue("login", me.user_id, provider, node_id=node["id"])
    push_account(me.user_id, provider)
    return _overview(me)


class CodeBody(BaseModel):
    code: str = Field(min_length=4, max_length=600)


@router.post("/api/core/accounts/{provider}/login/code")
def send_code(provider: str, body: CodeBody, me: Identity = Depends(current_identity)):
    _guard(me)
    provider = _provider(provider)
    row = store.account(me.user_id, provider)
    if (row.get("login") or {}).get("state") != "waiting" or not row.get("node_id"):
        raise HTTPException(status_code=409, detail="Вход не ждёт код — нажмите «Войти» ещё раз")
    store.enqueue("login_code", me.user_id, provider, node_id=row["node_id"], payload={"code": body.code.strip()})
    store.save_account(me.user_id, provider, login={**row["login"], "state": "verifying", "message": "Проверяю код…"})
    push_account(me.user_id, provider)
    return _overview(me)


@router.delete("/api/core/accounts/{provider}/login")
def cancel_login(provider: str, me: Identity = Depends(current_identity)):
    _guard(me)
    provider = _provider(provider)
    row = store.account(me.user_id, provider)
    if row.get("node_id"):
        store.enqueue("login_cancel", me.user_id, provider, node_id=row["node_id"])
    store.save_account(me.user_id, provider, state="ready" if row["state"] == "ready" else "none", login={})
    push_account(me.user_id, provider)
    return _overview(me)


@router.delete("/api/core/accounts/{provider}")
def disconnect(provider: str, me: Identity = Depends(current_identity)):
    _guard(me)
    provider = _provider(provider)
    row = store.account(me.user_id, provider)
    if store.PROVIDERS[provider]["how"] == "login" and row.get("node_id"):
        store.enqueue("logout", me.user_id, provider, node_id=row["node_id"])
    store.save_account(me.user_id, provider, state="none", secret_enc="", account="", login={}, error="")
    push_account(me.user_id, provider)
    return _overview(me)


@router.get("/api/core/usage")
def get_usage(days: int = 30, all: bool = False, me: Identity = Depends(current_identity)):
    _guard(me)
    days = max(1, min(days, 365))
    if all:
        if not me.is_admin:
            raise HTTPException(status_code=403, detail="Расход всей компании видит администратор")
        rows = store.usage(None, days)
        names = {str(u["id"]): u.get("name") or u.get("username") for u in (db.get_users() or [])}
        return {"usage": [{**r, "name": names.get(r["userId"], r["userId"])} for r in rows]}
    return {"usage": store.usage(me.user_id, days), "days": store.usage_days(me.user_id, days)}

