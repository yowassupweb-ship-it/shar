"""Нода «Ядра»: сервер компании, где работают агенты. Звонит в Шар сама — Шару не нужен к ней доступ.

Админ (Админка → Ядро → Ноды):
  GET    /api/core/nodes                 ноды: на связи ли, какие CLI стоят, сколько людей вошло
  POST   /api/core/nodes                 {name} → токен и команда установки (токен показываем один раз)
  POST   /api/core/nodes/{id}/token      выпустить новый токен (старый перестаёт работать сразу)
  DELETE /api/core/nodes/{id}

Нода (Authorization: Bearer shar_node_…):
  POST   /api/core/node/poll             {version, clis, running: [id задач]} → {jobs, cancel}; держит до 25 с, пока нет работы
  POST   /api/core/node/jobs/{id}/events {events: [...]} — ход задачи (шаги, текст, итог, ход входа)

Без секретов (их скачивает установщик):
  GET    /api/core/node/install.sh       установка на Ubuntu/Debian: curl … | sudo bash -s -- <адрес Шара> <токен>
  GET    /api/core/node/agent.mjs        сам агент ноды (Node.js, без зависимостей)
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app.core.db import db
from app.core.db.connection import Json
from app.core.security import Identity, require_admin
from app.modules.core_agents import accounts, dispatch, store

router = APIRouter()
log = logging.getLogger("shar.core.agents")

KIT = Path(__file__).parent / "kit"
POLL_SECONDS = 25
MAX_STEPS = 400
MAX_BODY = 60_000


# ── админ ────────────────────────────────────────────────────────────────────

def _node_view(row: dict) -> dict:
    online = bool(row.get("last_seen")) and (time.time() - row["last_seen"].timestamp()) < store.ONLINE_SECONDS
    users = db.conn.fetch_one("SELECT count(DISTINCT user_id)::int AS n FROM core_accounts WHERE node_id = %s AND state = 'ready'", (row["id"],))["n"]
    return {"id": str(row["id"]), "name": row["name"], "start": row["token_start"], "online": online, "enabled": row["enabled"],
            "lastSeen": row["last_seen"].isoformat() if row.get("last_seen") else None, "info": row.get("info") or {}, "users": users,
            "createdAt": row["created_at"].isoformat()}


def _install_command(request: Request, token: str) -> str:
    base = str(request.base_url).rstrip("/")
    forwarded = request.headers.get("x-forwarded-host")
    if forwarded:
        base = f"{request.headers.get('x-forwarded-proto', 'https')}://{forwarded}"
    return f"curl -fsSL {base}/api/core/node/install.sh | sudo bash -s -- {base} {token}"


class NodeBody(BaseModel):
    name: str = Field(default="", max_length=60)


def _ready() -> None:
    if not store.ready():
        raise HTTPException(status_code=503, detail="Агенты ещё не включены на сервере: нужна схема (выкладка с -Schema)")


@router.get("/api/core/nodes")
def list_nodes(me: Identity = Depends(require_admin)):
    _ready()
    rows = db.conn.fetch_all("SELECT * FROM core_nodes ORDER BY id") or []
    return {"nodes": [_node_view(r) for r in rows]}


@router.post("/api/core/nodes", status_code=201)
def create_node(body: NodeBody, request: Request, me: Identity = Depends(require_admin)):
    _ready()
    token = store.new_node_token()
    row = db.conn.fetch_one(
        "INSERT INTO core_nodes (name, token_hash, token_start, created_by) VALUES (%s, %s, %s, %s) RETURNING *",
        (body.name.strip() or "Нода", store.token_hash(token), token[:len(store.NODE_PREFIX) + 4], me.user_id))
    return {"node": _node_view(row), "token": token, "command": _install_command(request, token)}


@router.post("/api/core/nodes/{node_id}/token")
def reissue_token(node_id: int, request: Request, me: Identity = Depends(require_admin)):
    _ready()
    token = store.new_node_token()
    row = db.conn.fetch_one("UPDATE core_nodes SET token_hash = %s, token_start = %s WHERE id = %s RETURNING *",
                            (store.token_hash(token), token[:len(store.NODE_PREFIX) + 4], node_id))
    if not row:
        raise HTTPException(status_code=404, detail="Нода не найдена")
    return {"node": _node_view(row), "token": token, "command": _install_command(request, token)}


@router.delete("/api/core/nodes/{node_id}")
def delete_node(node_id: int, me: Identity = Depends(require_admin)):
    _ready()
    db.conn.execute_query("UPDATE core_jobs SET status = 'failed', error = 'Ноду удалили', finished_at = now() "
                          "WHERE node_id = %s AND status IN ('queued', 'taken')", (node_id,))
    db.conn.execute_query("UPDATE core_accounts SET state = 'none', node_id = NULL, login = '{}'::jsonb "
                          "WHERE node_id = %s AND provider <> 'gemini'", (node_id,))
    if not db.conn.fetch_one("DELETE FROM core_nodes WHERE id = %s RETURNING id", (node_id,)):
        raise HTTPException(status_code=404, detail="Нода не найдена")
    return {"ok": True}


# ── установка ────────────────────────────────────────────────────────────────

@router.get("/api/core/node/install.sh", response_class=PlainTextResponse)
def install_script():
    return PlainTextResponse((KIT / "install.sh").read_text(encoding="utf-8"), media_type="text/x-shellscript")


@router.get("/api/core/node/agent.mjs", response_class=PlainTextResponse)
def agent_script():
    return PlainTextResponse((KIT / "shar-node.mjs").read_text(encoding="utf-8"), media_type="text/javascript")


# ── нода ─────────────────────────────────────────────────────────────────────

def _node(request: Request) -> dict:
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    node = store.node_by_token(token) if token and store.ready() else None
    if node is None:
        raise HTTPException(status_code=401, detail="Нужен действующий токен ноды (Админка → Ядро → Ноды)")
    return node


class PollBody(BaseModel):
    version: str = Field(default="", max_length=40)
    host: str = Field(default="", max_length=120)
    clis: dict[str, str] = Field(default_factory=dict)
    running: list[str] = Field(default_factory=list, max_length=200)
    wait: bool = True


def _seen(node: dict, body: PollBody) -> None:
    info = {"version": body.version, "host": body.host, "clis": {k: v[:60] for k, v in body.clis.items() if k in store.PROVIDERS and v},
            "running": len(body.running)}
    db.conn.execute_query("UPDATE core_nodes SET last_seen = now(), info = %s WHERE id = %s", (Json(info), node["id"]))
    node["info"] = info


def _take(node: dict) -> Optional[dict]:
    job = store.claim(node)
    if job is None:
        return None
    try:
        if job["kind"] == "run":
            from app.modules.core_chat.router import update_agent_message

            current = db.conn.fetch_one("SELECT status FROM core_messages WHERE id = %s", (job["message_id"],))
            if not current or current["status"] == "cancelled":
                store.finish_job(job["id"], "cancelled")
                return _take(node)
            update_agent_message(job["message_id"], status="working", props={"phase": "думает"})
            return dispatch.build_run(job)
        out = {"id": str(job["id"]), "kind": job["kind"], "provider": job["provider"], "userId": job["user_id"]}
        if job["kind"] == "login_code":
            out["code"] = (job.get("payload") or {}).get("code") or ""
            store.finish_job(job["id"], "done")  # код отдан — задача выполнена, дальше идёт вход
        return out
    except Exception as exc:  # noqa: BLE001 — сломанная задача не должна ронять опрос всей ноды
        log.exception("core: could not hand job %s to node", job["id"])
        store.finish_job(job["id"], "failed", str(exc))
        return None


@router.post("/api/core/node/poll")
async def poll(body: PollBody, request: Request):
    node = await run_in_threadpool(_node, request)
    deadline = time.monotonic() + (POLL_SECONDS if body.wait else 0)
    while True:
        await run_in_threadpool(_seen, node, body)
        cancel = await run_in_threadpool(store.cancelled_among, node["id"], body.running)
        job = await run_in_threadpool(_take, node)
        if job or cancel or time.monotonic() >= deadline or await request.is_disconnected():
            return {"jobs": [job] if job else [], "cancel": cancel}
        await asyncio.sleep(1.0)


class EventsBody(BaseModel):
    events: list[dict[str, Any]] = Field(default_factory=list, max_length=100)


def _apply_run(job: dict, events: list[dict]) -> dict:
    from app.modules.core_chat.router import update_agent_message

    message_id = job["message_id"]
    for ev in events:
        kind = ev.get("type")
        if kind == "session" and ev.get("id"):
            payload = job.get("payload") or {}
            db.conn.execute_query("UPDATE core_threads SET sessions = sessions || %s WHERE id = %s",
                                  (Json({job["provider"]: str(ev["id"])[:200]}), payload.get("threadId")))
            continue
        props: dict[str, Any] = {}
        for key in ("phase", "reasoning", "rateLimit", "work", "model"):
            if key in ev:
                props[key] = ev[key]
        if "steps" in ev:
            props["steps"] = list(ev["steps"] or [])[-MAX_STEPS:]
        body = str(ev["body"])[:MAX_BODY] if "body" in ev and ev["body"] is not None else None
        if kind == "progress":
            if body is None and not props:
                continue
            if update_agent_message(message_id, body=body, props=props or None) is None:
                return {"stop": True}  # человек остановил ответ
        elif kind in ("done", "failed"):
            work = ev.get("work") or {}
            if work:
                props["work"] = {**work, "cost_usd": store.add_usage(job["user_id"], job["provider"], ev.get("model") or (job.get("payload") or {}).get("model") or "", work)}
            if kind == "failed":
                props["failed"] = True
                body = body or f"Не получилось: {ev.get('error') or 'агент завершился с ошибкой'}"
                if ev.get("authExpired"):  # подписка разлогинилась — карточка в настройках покажет «Войти»
                    store.save_account(job["user_id"], job["provider"], state="none", error="Вход истёк — войдите снова")
                    accounts.push_account(job["user_id"], job["provider"])
            update_agent_message(message_id, body=body or "", status="done" if kind == "done" else "failed", props=props)
            store.finish_job(job["id"], kind, str(ev.get("error") or ""))
    return {"ok": True}


def _apply_account(job: dict, events: list[dict]) -> dict:
    user_id, provider = job["user_id"], job["provider"]
    for ev in events:
        kind = ev.get("type")
        row = store.account(user_id, provider)
        if kind == "login":
            state = ev.get("state") or ""
            login = {k: ev[k] for k in ("state", "url", "code", "message", "needsCode") if k in ev}
            if state == "done":
                store.save_account(user_id, provider, state="ready", account=str(ev.get("account") or "")[:120], login={}, error="", node_id=job["node_id"])
                store.finish_job(job["id"], "done")
            elif state == "failed":
                store.save_account(user_id, provider, state="ready" if row["state"] == "ready" else "none", login={},
                                   error=str(ev.get("message") or "Вход не получился")[:300])
                store.finish_job(job["id"], "failed", str(ev.get("message") or ""))
            else:
                store.save_account(user_id, provider, login=login)
        elif kind == "account":  # проверка: вошёл ли человек на самом деле
            if ev.get("loggedIn"):
                store.save_account(user_id, provider, state="ready", account=str(ev.get("account") or row.get("account") or "")[:120], node_id=job["node_id"])
            else:
                store.save_account(user_id, provider, state="none", account="")
            store.finish_job(job["id"], "done")
        elif kind in ("done", "failed"):
            store.finish_job(job["id"], kind, str(ev.get("error") or ""))
        accounts.push_account(user_id, provider)
    return {"ok": True}


def _events(node: dict, job_id: str, events: list[dict]) -> dict:
    job = store.job(job_id, node["id"]) if job_id.isdigit() else None
    if job is None:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    if job["status"] not in ("taken", "queued") and job["kind"] != "login":
        return {"stop": True}
    return _apply_run(job, events) if job["kind"] == "run" else _apply_account(job, events)


@router.post("/api/core/node/jobs/{job_id}/events")
async def job_events(job_id: str, body: EventsBody, request: Request):
    node = await run_in_threadpool(_node, request)
    return await run_in_threadpool(_events, node, job_id, body.events)
