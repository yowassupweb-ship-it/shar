"""Подключённые API компании для агентов «Ядра» (перенесено из MBOX, server/integrations.mjs).

Ключи хранятся в Шаре зашифрованными; агент зовёт API через Шар (integration_call) и самих ключей не видит — ни в
ответах, ни на ноде. Готовые сервисы — Topvisor, Яндекс Вебмастер, Яндекс Метрика, Яндекс Wordstat; любое другое API
админ добавляет сам: адрес, способ входа, ключ.

Доступ — по сотруднику: API нужно не всем. Админ отмечает, кому какой сервис открыт (или «всем»); агент сотрудника видит
только открытые ему. Подключить и удалить API может админ — руками в «Админка → Ядро» или словами агенту в чате
(инструменты integration_save / integration_delete открыты только агенту админа).

  GET    /api/core/integrations                 сервисы, что заполнено (без секретов), кому открыто
  PUT    /api/core/integrations/{service}       {fields | label, base_url, auth_type, auth_name, notes, secret, access}
  DELETE /api/core/integrations/{service}       своё API — удалить; готовый сервис — очистить ключи
  POST   /api/core/integrations/{service}/test  проверить подключение
"""

from __future__ import annotations

import base64
import ipaddress
import json
import logging
import re
import socket
from typing import Any, Optional
from urllib.parse import urlencode, urlparse

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.db.connection import Json
from app.core.security import Identity, require_admin
from app.modules.core_agents import store

router = APIRouter()
log = logging.getLogger("shar.core.integrations")

MAX_RESPONSE_CHARS = 60_000
CALL_TIMEOUT = 60
SERVICE_ID = re.compile(r"^[a-z][a-z0-9_-]{1,39}$")
PATH_PATTERN = re.compile(r"^[A-Za-z0-9_\-./:=,%@+~!*']*$")

BUILTIN: dict[str, dict[str, Any]] = {
    "topvisor": {
        "label": "Topvisor", "base": "https://api.topvisor.com/v2/json", "docs": "https://topvisor.com/ru/api/v2/", "method": "POST",
        "hint": "Позиции, проекты, ключевые фразы, аудит. Путь — имя метода API v2, например get/projects_2/projects; параметры — в body (JSON).",
        "fields": [{"key": "user_id", "label": "User-Id"}, {"key": "api_key", "label": "API-ключ", "secret": True},
                   {"key": "project_id", "label": "ID проекта по умолчанию", "optional": True}],
        "required": ["user_id", "api_key"],
        "headers": lambda v: {"user-id": v["user_id"], "authorization": f"bearer {v['api_key']}"},
        "test": {"method": "POST", "path": "get/projects_2/projects", "body": {"limit": 1}},
    },
    "yandex_webmaster": {
        "label": "Яндекс Вебмастер", "base": "https://api.webmaster.yandex.net/v4", "method": "GET",
        "docs": "https://yandex.ru/dev/webmaster/doc/dg/concepts/getting-started.html",
        "hint": "Индексация, поисковые запросы, диагностика сайта. Путь вида user/{user-id}/hosts.",
        "fields": [{"key": "token", "label": "OAuth-токен", "secret": True}, {"key": "host_id", "label": "ID сайта по умолчанию", "optional": True}],
        "required": ["token"],
        "headers": lambda v: {"authorization": f"OAuth {v['token']}"},
        "test": {"method": "GET", "path": "user"},
    },
    "yandex_metrica": {
        "label": "Яндекс Метрика", "base": "https://api-metrika.yandex.net", "method": "GET", "docs": "https://yandex.ru/dev/metrika/ru/",
        "hint": "Отчёты и счётчики. Пути: management/v1/counters, stat/v1/data?ids=…&metrics=….",
        "fields": [{"key": "token", "label": "OAuth-токен", "secret": True}, {"key": "counter_id", "label": "ID счётчика по умолчанию", "optional": True}],
        "required": ["token"],
        "headers": lambda v: {"authorization": f"OAuth {v['token']}"},
        "test": {"method": "GET", "path": "management/v1/counters", "query": {"per_page": 1}},
    },
    "yandex_wordstat": {
        # С 2026 Wordstat — через Yandex Search API (AI Studio): API-ключ сервисного аккаунта с ролью search-api.webSearch.user.
        "label": "Яндекс Wordstat", "base": "https://searchapi.api.cloud.yandex.net/v2/wordstat", "method": "POST",
        "docs": "https://aistudio.yandex.ru/docs/ru/search-api/api-ref/Wordstat/getTop",
        "hint": "Частотность запросов. Все методы — POST с JSON в body, folderId подставляется сам. topRequests {phrase, numPhrases, regions, devices}; "
                "dynamics {phrase, period, fromDate}; regionsDistribution {phrase}; getRegionsTree.",
        "fields": [{"key": "api_key", "label": "API-ключ сервисного аккаунта", "secret": True},
                   {"key": "folder_id", "label": "ID каталога Yandex Cloud (b1g…)", "optional": True}],
        "required": ["api_key"],
        "headers": lambda v: {"authorization": f"Api-Key {v['api_key']}"},
        "body": lambda v, body: {**body, "folderId": v["folder_id"]} if isinstance(body, dict) and v.get("folder_id") and not body.get("folderId") else body,
        "test": {"method": "POST", "path": "topRequests", "body": {"phrase": "туры по россии", "numPhrases": 1}},
    },
}
AUTH_TYPES = {"bearer": "Authorization: Bearer <ключ>", "oauth": "Authorization: OAuth <ключ> (Яндекс)",
              "header": "Свой заголовок: <имя>: <ключ>", "basic": "Basic: ключ вида логин:пароль", "query": "Ключ в параметре адреса: ?<имя>=<ключ>"}

schema.register("core_integrations", """
CREATE TABLE IF NOT EXISTS core_integrations (
    service TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    auth_type TEXT NOT NULL DEFAULT 'bearer',
    auth_name TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    values_enc TEXT NOT NULL DEFAULT '',
    access JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
""")


class IntegrationError(Exception):
    pass


# ── хранение ─────────────────────────────────────────────────────────────────

def _row(service: str) -> Optional[dict]:
    return db.conn.fetch_one("SELECT * FROM core_integrations WHERE service = %s", (service,))


def _values(row: Optional[dict]) -> dict[str, str]:
    if not row or not row.get("values_enc"):
        return {}
    try:
        return json.loads(store.unseal(row["values_enc"]) or "{}")
    except ValueError:
        return {}


def _access(row: Optional[dict]) -> list[str]:
    return [str(x) for x in ((row or {}).get("access") or [])]


def open_to(service: str, user_id: str, is_admin: bool = False) -> bool:
    """Открыт ли сервис сотруднику: админу — всегда, остальным — если отмечен он или «все» (*)."""
    if is_admin:
        return True
    access = _access(_row(service))
    return "*" in access or user_id in access


def listing(user_id: str = "", is_admin: bool = True) -> list[dict]:
    rows = {r["service"]: r for r in (db.conn.fetch_all("SELECT * FROM core_integrations ORDER BY lower(label)") or [])}
    out = []
    for sid, spec in BUILTIN.items():
        row = rows.get(sid)
        values = _values(row)
        out.append({"service": sid, "label": spec["label"], "kind": "builtin", "baseUrl": spec["base"], "docs": spec.get("docs", ""), "hint": spec["hint"],
                    "configured": all(values.get(k) for k in spec["required"]), "access": _access(row),
                    "fields": [{"key": f["key"], "label": f["label"], "secret": bool(f.get("secret")), "optional": bool(f.get("optional")),
                                "filled": bool(values.get(f["key"])), "value": "" if f.get("secret") else values.get(f["key"], "")} for f in spec["fields"]]})
    for sid, row in rows.items():
        if sid in BUILTIN:
            continue
        has_secret = bool(_values(row).get("secret"))
        out.append({"service": sid, "label": row["label"], "kind": "custom", "baseUrl": row["base_url"], "docs": "", "hint": row["notes"],
                    "configured": has_secret, "access": _access(row), "authType": row["auth_type"], "authName": row["auth_name"],
                    "fields": [{"key": "secret", "label": "Ключ", "secret": True, "optional": False, "filled": has_secret, "value": ""}]})
    if not is_admin:
        out = [i for i in out if i["configured"] and ("*" in i["access"] or user_id in i["access"])]
    return out


def _validate_base(raw: str) -> str:
    url = urlparse(str(raw or "").strip())
    if url.scheme != "https" or not url.hostname:
        raise IntegrationError("Нужен полный адрес https://api.example.com/v1")
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(url.hostname, 443)}
    except socket.gaierror as exc:
        raise IntegrationError(f"Адрес {url.hostname} не находится") from exc
    if any(not ipaddress.ip_address(a.split("%")[0]).is_global for a in addresses):
        raise IntegrationError("Внутренние и локальные адреса запрещены")
    return f"{url.scheme}://{url.netloc}{url.path.rstrip('/')}"


def save(service: str, data: dict[str, Any], actor: str) -> None:
    service = service.strip().lower()
    row = _row(service)
    access = data.get("access")
    access = [str(x) for x in access] if isinstance(access, list) else _access(row)
    if service in BUILTIN:
        spec = BUILTIN[service]
        values = _values(row)
        for f in spec["fields"]:
            value = (data.get("fields") or {}).get(f["key"])
            if isinstance(value, str) and (value.strip() or not f.get("secret")):
                values[f["key"]] = value.strip()
        label, base, auth_type, auth_name, notes = spec["label"], spec["base"], "", "", ""
    else:
        if not SERVICE_ID.match(service):
            raise IntegrationError("Код сервиса: латиница, цифры, - и _, 2–40 знаков, с буквы")
        label = str(data.get("label") or (row or {}).get("label") or service).strip()[:80]
        base = _validate_base(data.get("base_url") or data.get("baseUrl") or (row or {}).get("base_url") or "")
        auth_type = data.get("auth_type") if data.get("auth_type") in AUTH_TYPES else (row or {}).get("auth_type") or "bearer"
        auth_name = str(data.get("auth_name") or (row or {}).get("auth_name") or "").strip()[:60]
        if auth_type in ("header", "query") and not auth_name:
            raise IntegrationError("Для этого способа входа нужно имя заголовка или параметра")
        notes = str(data.get("notes") if data.get("notes") is not None else (row or {}).get("notes") or "")[:500]
        values = _values(row)
        if isinstance(data.get("secret"), str) and data["secret"].strip():
            values["secret"] = data["secret"].strip()
    db.conn.execute_query(
        """INSERT INTO core_integrations (service, label, base_url, auth_type, auth_name, notes, values_enc, access, updated_by)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (service) DO UPDATE SET label = EXCLUDED.label, base_url = EXCLUDED.base_url, auth_type = EXCLUDED.auth_type,
             auth_name = EXCLUDED.auth_name, notes = EXCLUDED.notes, values_enc = EXCLUDED.values_enc, access = EXCLUDED.access,
             updated_by = EXCLUDED.updated_by, updated_at = now()""",
        (service, label, base, auth_type, auth_name, notes, store.seal(json.dumps(values)) if values else "", Json(access), actor))


def delete(service: str) -> None:
    db.conn.execute_query("DELETE FROM core_integrations WHERE service = %s", (service,))


# ── вызов ────────────────────────────────────────────────────────────────────

def call(service: str, *, method: str = "", path: str = "", query: Optional[dict] = None, body: Any = None, max_chars: int = 30_000) -> dict:
    """Вызов API с подстановкой ключа. Возвращает {ok, status, data, truncated} и никогда — секрет."""
    row = _row(service)
    values = _values(row)
    extra: dict[str, str] = {}
    if service in BUILTIN:
        spec = BUILTIN[service]
        missing = [f["label"] for f in spec["fields"] if f["key"] in spec["required"] and not values.get(f["key"])]
        if missing:
            return {"ok": False, "error": "not_configured", "message": f"{spec['label']}: не заполнено — {', '.join(missing)}. Ключи вносит администратор."}
        base, headers, default = spec["base"], spec["headers"](values), spec["method"]
        if "body" in spec and body is not None:
            body = spec["body"](values, json.loads(body) if isinstance(body, str) and body.strip().startswith("{") else body)
    else:
        if not row:
            return {"ok": False, "error": "unknown_service", "message": f"Сервис «{service}» не найден. Список — integration_list."}
        secret = values.get("secret") or ""
        if not secret:
            return {"ok": False, "error": "not_configured", "message": f"{row['label']}: ключ не задан."}
        base, default = row["base_url"], "GET"
        kind = row["auth_type"]
        headers = ({"authorization": f"Bearer {secret}"} if kind == "bearer" else {"authorization": f"OAuth {secret}"} if kind == "oauth"
                   else {row["auth_name"].lower(): secret} if kind == "header"
                   else {"authorization": "Basic " + base64.b64encode(secret.encode()).decode()} if kind == "basic" else {})
        if kind == "query":
            extra = {row["auth_name"]: secret}
    verb = (method or default).upper()
    if verb not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        return {"ok": False, "error": "bad_method"}
    clean = str(path or "").lstrip("/")
    if not PATH_PATTERN.match(clean) or ".." in clean or "//" in clean:
        return {"ok": False, "error": "bad_path", "message": "Путь — относительный, без «..»; параметры — в query"}
    params = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in (query or {}).items() if v is not None}
    url = f"{base}/{clean}" + (("?" + urlencode({**params, **extra}, doseq=True)) if params or extra else "")
    has_body = body is not None and verb != "GET"
    try:
        res = requests.request(verb, url, headers={"accept": "application/json", **({"content-type": "application/json"} if has_body else {}), **headers},
                               data=(body if isinstance(body, str) else json.dumps(body)) if has_body else None,
                               timeout=CALL_TIMEOUT, allow_redirects=False)
    except requests.Timeout:
        return {"ok": False, "error": "timeout", "message": "API не ответило за 60 секунд"}
    except requests.RequestException as exc:
        return {"ok": False, "error": "request_failed", "message": str(exc)[:300]}
    try:
        data: Any = res.json()
    except ValueError:
        data = res.text
    # Topvisor отвечает 200 и при неверном ключе: ошибка — в поле errors.
    if service == "topvisor" and isinstance(data, dict) and data.get("errors"):
        err = data["errors"][0]
        return {"ok": False, "status": res.status_code, "error": "api_error", "message": f"Topvisor: {err.get('string') or err.get('message') or 'ошибка API'} (код {err.get('code', '?')})"}
    limit = min(max(int(max_chars or 30_000), 1000), MAX_RESPONSE_CHARS)
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    if len(text) > limit:
        return {"ok": res.ok, "status": res.status_code, "data": text[:limit], "truncated": True, "total_chars": len(text),
                "hint": "Ответ обрезан: уточните запрос (limit, фильтры, поля) или поднимите max_chars до 60000."}
    return {"ok": res.ok, "status": res.status_code, "data": data, "truncated": False}


def test(service: str) -> dict:
    if service in BUILTIN:
        probe = BUILTIN[service]["test"]
        result = call(service, method=probe["method"], path=probe["path"], query=probe.get("query"), body=probe.get("body"), max_chars=2000)
        if result.get("ok"):
            return {"ok": True, "message": "Подключение работает"}
        return {"ok": False, "message": result.get("message") or f"API ответило {result.get('status')}: {str(result.get('data'))[:200]}"}
    result = call(service, method="GET", path="", max_chars=500)
    if result.get("error"):
        return {"ok": False, "message": result.get("message") or result["error"]}
    return {"ok": result["status"] < 500, "message": f"Адрес отвечает (HTTP {result['status']}). Ключ проверится первым настоящим вызовом."}


# ── REST для админки ─────────────────────────────────────────────────────────

class SaveBody(BaseModel):
    fields: Optional[dict[str, str]] = None
    label: Optional[str] = Field(default=None, max_length=80)
    base_url: Optional[str] = Field(default=None, max_length=300)
    auth_type: Optional[str] = None
    auth_name: Optional[str] = Field(default=None, max_length=60)
    notes: Optional[str] = Field(default=None, max_length=500)
    secret: Optional[str] = Field(default=None, max_length=4000)
    access: Optional[list[str]] = Field(default=None, max_length=500)


def _ready() -> None:
    from app.modules.workspace import store as ws_store

    if not ws_store.table_ready("core_integrations"):
        raise HTTPException(status_code=503, detail="Интеграции ещё не включены на сервере: нужна схема (выкладка с -Schema)")


@router.get("/api/core/integrations")
def get_integrations(me: Identity = Depends(require_admin)):
    _ready()
    return {"integrations": listing(), "authTypes": AUTH_TYPES}


@router.put("/api/core/integrations/{service}")
def put_integration(service: str, body: SaveBody, me: Identity = Depends(require_admin)):
    _ready()
    try:
        save(service, body.model_dump(exclude_none=True), me.display_name)
    except (IntegrationError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"integrations": listing()}


@router.delete("/api/core/integrations/{service}")
def delete_integration(service: str, me: Identity = Depends(require_admin)):
    _ready()
    delete(service)
    return {"integrations": listing()}


@router.post("/api/core/integrations/{service}/test")
def test_integration(service: str, me: Identity = Depends(require_admin)):
    _ready()
    return test(service)
