"""Нода «Ядра»: сервер компании, где работают агенты. Звонит в Шар сама — Шару не нужен к ней доступ.

Админ (Админка → Ядро → Ноды):
  GET    /api/core/nodes                 ноды: на связи ли, какие CLI стоят, сколько людей вошло
  POST   /api/core/nodes                 {name} → токен и команда установки (токен показываем один раз)
  POST   /api/core/nodes/{id}/token      выпустить новый токен (старый перестаёт работать сразу)
  DELETE /api/core/nodes/{id}

Нода (Authorization: Bearer shar_node_…):
  POST   /api/core/node/poll             {version, clis, running: [id задач], slots: свободные места} → {jobs, cancel}; держит до 25 с, пока нет работы
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
# Шаг проверки очереди внутри долгого опроса: от этого зависит, через сколько нода подхватит новое сообщение (в среднем — полшага).
POLL_STEP = 0.25
MAX_STEPS = 400

# Пробуждение опроса событием: пока нода висит в долгом опросе, новую задачу или отмену она получает сразу, а не на
# следующем шаге POLL_STEP (в среднем −0,12 с к ответу). Шаг остаётся запасным: процессов может быть несколько, и событие
# дойдёт только до опросов в том же процессе.
_waiters: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()


def wake_pollers() -> None:
    """Разбудить долгие опросы нод. Безопасно звать из любого потока (запросы выполняются в пуле потоков)."""
    for loop, event in list(_waiters):
        try:
            loop.call_soon_threadsafe(event.set)
        except RuntimeError:  # цикл уже закрыт — опрос ушёл
            _waiters.discard((loop, event))
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
    return PlainTextResponse(_kit_text("install.sh"), media_type="text/x-shellscript")


@router.get("/api/core/node/agent.mjs", response_class=PlainTextResponse)
def agent_script():
    return PlainTextResponse(_kit_text("shar-node.mjs"), media_type="text/javascript")


def _agent_hash() -> str:
    """Отпечаток актуального агента ноды: нода сверяет его со своим и, разойдясь, в простое перезапускается за свежим."""
    import hashlib

    return hashlib.sha256(_kit_text("shar-node.mjs").encode("utf-8")).hexdigest()[:16]


# GPT получает встроенную генерацию картинок с 1.2.4; Kimi восстанавливает MCP при продолжении диалога с 1.2.2.
PROVIDER_MIN_VERSION = {"gemini": (1, 1, 0), "codex": (1, 2, 4), "kimi": (1, 2, 2)}


def _version(node: dict) -> tuple:
    try:
        return tuple(int(x) for x in str((node.get("info") or {}).get("version") or "0").split(".")[:3])
    except ValueError:
        return (0,)


def _kit_text(name: str) -> str:
    # Из рабочей копии на Windows файл может прийти с CRLF — bash на ноде на нём споткнётся.
    return (KIT / name).read_bytes().decode("utf-8").replace("\r\n", "\n")


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
    slots: int = Field(default=1, ge=0, le=200)  # старые ноды не передают slots и по-прежнему получают одну задачу
    # Что умеет эта нода: warm — держать процесс агента на чат (ключ MCP она берёт и продлевает сама).
    caps: list[str] = Field(default_factory=list, max_length=10)
    wait: bool = True


def _seen(node: dict, body: PollBody) -> None:
    info = {"version": body.version, "host": body.host, "clis": {k: v[:60] for k, v in body.clis.items() if (k in store.PROVIDERS or k == "browser") and v},
            "running": len(body.running), "caps": [c[:20] for c in body.caps][:10]}
    db.conn.execute_query("UPDATE core_nodes SET last_seen = now(), info = %s WHERE id = %s", (Json(info), node["id"]))
    node["info"] = info


def _take(node: dict) -> Optional[dict]:
    job = store.claim(node)
    if job is None:
        return None
    try:
        if job["kind"] == "run":
            from app.modules.core_chat.router import update_agent_message

            if _version(node) < PROVIDER_MIN_VERSION.get(job["provider"], (0,)):
                note = ("Нода агентов устарела и небезопасна для этого агента — администратору: перезапустите службу "
                        "shar-node (sudo systemctl restart shar-node) или выполните новую команду установки из Админки → Ядро.")
                store.finish_job(job["id"], "failed", note)
                update_agent_message(job["message_id"], body=note, status="failed", props={"failed": True})
                return _take(node)

            current = db.conn.fetch_one("SELECT status FROM core_messages WHERE id = %s", (job["message_id"],))
            if not current or current["status"] == "cancelled":
                store.finish_job(job["id"], "cancelled")
                return _take(node)
            update_agent_message(job["message_id"], status="working", props={"phase": "думает"})
            return dispatch.build_run(job, warm="warm" in ((node.get("info") or {}).get("caps") or []))
        out = {"id": str(job["id"]), "kind": job["kind"], "provider": job["provider"], "userId": job["user_id"]}
        if job["kind"] == "check" and (job.get("payload") or {}).get("limits"):
            out["limits"] = True  # кнопка «Проверить лимиты»: нода спросит у провайдера текущие окна
            out["model"] = str((job.get("payload") or {}).get("model") or "")  # по выбранной в чате модели
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
    deadline = time.monotonic() + (POLL_SECONDS if body.wait and body.slots else 0)
    wake = asyncio.Event()
    entry = (asyncio.get_running_loop(), wake)
    _waiters.add(entry)
    try:
        # Отданное ноде, о чём она не знает (оборвался прошлый опрос), — обратно в очередь: иначе ответ висел бы вечно.
        await run_in_threadpool(store.requeue_lost, node["id"], body.running)
        seen_at = 0.0
        while True:
            # «Жив» нода отмечается раз в 5 с, а не на каждом круге: круг теперь короткий (задача уходит ноде за ~0,25 с, а не за ~1 с),
            # и запись в базу на каждом круге была бы лишней нагрузкой.
            if time.monotonic() - seen_at >= 5:
                await run_in_threadpool(_seen, node, body)
                seen_at = time.monotonic()
            cancel = await run_in_threadpool(store.cancelled_among, node["id"], body.running)
            # Нода ушла, пока мы ждали (перезапуск, сеть) — задачу ей не отдаём: ответ ушёл бы в пустоту.
            if await request.is_disconnected():
                return {"jobs": [], "cancel": cancel, "agent": _agent_hash()}
            job = await run_in_threadpool(_take, node) if body.slots else None
            if job or cancel or time.monotonic() >= deadline or await request.is_disconnected():
                return {"jobs": [job] if job else [], "cancel": cancel, "agent": _agent_hash()}
            try:
                await asyncio.wait_for(wake.wait(), POLL_STEP)
            except asyncio.TimeoutError:
                pass
            wake.clear()
    finally:
        _waiters.discard(entry)


# ── ключ MCP для тёплого процесса агента ─────────────────────────────────────
# Обычный запуск получает ключ на один ответ и отзывает его в конце. Тёплый процесс живёт между ответами, поэтому ключ у него
# один на процесс: нода берёт его при запуске, а на каждое следующее сообщение продлевает и привязывает к новому ответу
# (job в области ключа — к какому ответу относятся вопросы, картинки, разрешения агента). Живёт не дольше WARM_KEY_MINUTES
# после последнего сообщения; нода отзывает его, когда процесс закрылся.
WARM_KEY_MINUTES = 25


class KeyBody(BaseModel):
    keyId: int = Field(default=0, ge=0)


def _warm_key(node: dict, job_id: str, key_id: int) -> dict:
    import secrets as _secrets

    from app.modules.mcp import keys

    job = store.job(job_id, node["id"])
    if not job or job["kind"] != "run" or job["status"] != "taken" or job["provider"] != "claude":
        raise HTTPException(status_code=404, detail="Задача не найдена или уже закончена")
    scope = {**dispatch.key_scope(job["user_id"], job["provider"], job["message_id"]), "warm": True, "node": int(node["id"])}
    if key_id:
        row = db.conn.fetch_one(
            "UPDATE mcp_keys SET scope = %s, expires_at = now() + make_interval(mins => %s) "
            "WHERE id = %s AND user_id = %s AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) "
            "AND scope->>'warm' = 'true' AND scope->>'node' = %s RETURNING id",
            (Json(scope), WARM_KEY_MINUTES, key_id, job["user_id"], str(node["id"])))
        if not row:
            raise HTTPException(status_code=410, detail="Ключ тёплого процесса истёк — нужен новый")
        return {"keyId": key_id}
    token = keys.PREFIX + _secrets.token_urlsafe(32)
    row = db.conn.fetch_one(
        "INSERT INTO mcp_keys (user_id, name, token_hash, token_start, scope, expires_at) "
        "VALUES (%s, %s, %s, %s, %s, now() + make_interval(mins => %s)) RETURNING id",
        (job["user_id"], f"{keys.JOB_PREFIX}{store.PROVIDERS[job['provider']]['label']}", keys._hash(token), token[:len(keys.PREFIX) + 4],
         Json(scope), WARM_KEY_MINUTES))
    return {"keyId": int(row["id"]), "token": token}


@router.post("/api/core/node/jobs/{job_id}/mcp-key")
async def warm_key(job_id: str, body: KeyBody, request: Request):
    """Ключ MCP тёплого процесса: без keyId — новый (токен отдаём один раз), с keyId — продлить и привязать к ответу этой задачи."""
    node = await run_in_threadpool(_node, request)
    return await run_in_threadpool(_warm_key, node, job_id, body.keyId)


@router.post("/api/core/node/keys/{key_id}/revoke")
async def warm_key_revoke(key_id: int, request: Request):
    """Процесс закрылся — ключ отзываем сразу. Только свой: ключи, выданные этой ноде для тёплых процессов."""
    node = await run_in_threadpool(_node, request)
    await run_in_threadpool(
        db.conn.execute_query,
        "UPDATE mcp_keys SET revoked_at = now() WHERE id = %s AND revoked_at IS NULL AND scope->>'warm' = 'true' AND scope->>'node' = %s",
        (key_id, str(node["id"])))
    return {"ok": True}


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
        if kind == "attachment":
            from app.modules.core_agents import images

            try:
                if len(str(ev.get("data") or "")) > 48 * 1024 * 1024:
                    raise images.ImageError("Картинка больше допустимых 32 МБ")
                images.save_native(message_id, job["user_id"], event_id=str(ev.get("eventId") or "")[:160],
                                   data=str(ev.get("data") or ""), name=str(ev.get("name") or ""))
            except images.ImageError as exc:
                update_agent_message(message_id, props={"reasoning": str(exc)})
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
            if ev.get("limits"):  # окна лимита подписки — в шапку чата (core_accounts.limits)
                store.merge_limits(job["user_id"], job["provider"], list(ev["limits"]))
                accounts.push_account(job["user_id"], job["provider"])
            work = ev.get("work") or {}
            if work:
                props["work"] = {**work, "cost_usd": store.add_usage(job["user_id"], job["provider"], ev.get("model") or (job.get("payload") or {}).get("model") or "", work)}
            if kind == "failed":
                props["failed"] = True
                body = body or f"Не получилось: {ev.get('error') or 'агент завершился с ошибкой'}"
                if ev.get("authExpired"):  # подписка разлогинилась — карточка в настройках покажет «Войти»
                    store.save_account(job["user_id"], job["provider"], state="none", error="Вход истёк — войдите снова")
                    accounts.push_account(job["user_id"], job["provider"])
            if kind == "done" and ev.get("plan"):
                # План-режим: ответ — это план; «Выполнить план» продолжает ту же сессию уже без план-режима.
                props["ask"] = {"kind": "plan", "question": "План готов. Выполнить?"}
                props["actions"] = [{"label": "Выполнить план", "value": "Выполняй этот план."},
                                    {"label": "Не выполнять", "value": "Пока не выполняй — я подумаю."}]
            update_agent_message(message_id, body=body or "", status="done" if kind == "done" else "failed", props=props)
            try:
                from app.modules.core_agents import task_agent

                task_agent.finished(job, kind, body or "")  # запуск по задаче → отчёт в задаче
            except Exception as exc:  # отчёт не должен ломать завершение ответа
                log.warning("task agent report failed: %s", exc)
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
                models, model = store.pick_models(provider, ev.get("models") or [], row.get("model") or "")
                store.save_account(user_id, provider, state="ready", account=str(ev.get("account") or "")[:120], login={}, error="",
                                   node_id=job["node_id"], models=models, model=model)
                store.finish_job(job["id"], "done")
            elif state == "failed":
                store.save_account(user_id, provider, state="ready" if row["state"] == "ready" else "none", login={},
                                   error=str(ev.get("message") or "Вход не получился")[:300])
                store.finish_job(job["id"], "failed", str(ev.get("message") or ""))
            else:
                store.save_account(user_id, provider, login=login)
        elif kind == "account":  # проверка: вошёл ли человек на самом деле
            if ev.get("loggedIn"):
                models, model = store.pick_models(provider, ev.get("models") or [], row.get("model") or "")
                store.save_account(user_id, provider, state="ready", account=str(ev.get("account") or row.get("account") or "")[:120],
                                   node_id=job["node_id"], **({"models": models, "model": model} if models else {}))
            else:
                store.save_account(user_id, provider, state="none", account="")
            if isinstance(ev.get("limits"), list):
                store.merge_limits(user_id, provider, list(ev["limits"]))
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
