"""Сообщение в «Ядре» → задача ноде → ответ агента в чате.

Человек пишет в чат: если у него подключён агент, рядом с его сообщением сразу появляется ответ агента в статусе
queued («ждёт ноду»), а в core_jobs — задача run. Нода берёт её (node.py) и получает всё для запуска: текст, историю
чата, где человек сейчас (context), вложения, профиль и навыки (memory.prompt_context), ключ MCP на этот запуск и —
для Gemini — ключ человека. Дальше нода пишет в то же сообщение шаги, текст и ход работы (node.py → events).
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from app.core.db import db
from app.core.db.connection import Json
from app.modules.core_agents import memory, store

log = logging.getLogger("shar.core.agents")

# Новая сессия получает хвост разговора — коротко: длинное прошлое дороже, чем польза от него (сжатое есть в сессии CLI).
HISTORY = 10
HISTORY_CHARS = 1500
JOB_KEY_HOURS = 3
KINDS = {"note": "заметка", "document": "документ", "table": "таблица", "presentation": "презентация", "task": "задача",
         "event": "событие", "file": "файл", "folder": "папка", "chat": "чат", "mail": "письмо", "section": "раздел"}


def pick_agent(user_id: str, wanted: str, peer: str) -> Optional[dict]:
    """Кто отвечает: выбранный в поле ввода («claude» или «claude:opus»), агент чата или первый подключённый."""
    agents = store.ready_agents(user_id)
    for choice in (wanted, peer):
        provider, _, model = (choice or "").partition(":")
        found = next((a for a in agents if a["provider"] == provider), None)
        if found:
            return {**found, "model": model or found["model"]}
    return agents[0] if agents else None


def dispatch(user_id: str, thread: dict, user_message: dict, *, wanted: str = "", effort: str = "") -> Optional[dict]:
    """Поставить ответ агента в очередь. Нет подключённых агентов — None (интерфейс сам предложит подключить)."""
    from app.modules.core_chat.router import post_agent_message

    if not store.ready():
        return None
    agent = pick_agent(user_id, wanted, thread.get("peer") or "")
    if agent is None:
        return None
    provider = agent["provider"]
    props: dict[str, Any] = {"provider": provider, "model": agent["model"], "effort": effort or "medium", "steps": []}
    node_id = None
    if store.PROVIDERS[provider]["how"] == "login":
        node_id = store.account(user_id, provider).get("node_id")
        if not store.node_online(node_id):
            return post_agent_message(user_id, thread["id"], agent["label"], status="failed", body="Нода, где вы вошли в "
                                      f"{agent['label']}, сейчас не на связи. Ответ придёт, когда администратор её запустит — "
                                      "или выберите другого агента.", props={**props, "failed": True})
    elif not store.online_nodes():
        return post_agent_message(user_id, thread["id"], agent["label"], status="failed",
                                  body="Нода агентов сейчас не на связи — попросите администратора её запустить.", props={**props, "failed": True})
    message = post_agent_message(user_id, thread["id"], agent["label"], status="queued", props={**props, "phase": "ждёт ноду"})
    store.enqueue("run", user_id, provider, node_id=node_id, message_id=message["id"], payload={
        "threadId": thread["id"], "userMessageId": user_message["id"], "model": agent["model"], "effort": effort or "medium"})
    return message


# ── что нода получает при взятии задачи ──────────────────────────────────────

def _history(thread_id: str, before_id: str) -> list[dict]:
    rows = db.conn.fetch_all(
        """SELECT role, actor, body, props FROM core_messages WHERE thread_id = %s AND status IN ('done', 'failed')
             AND created_at < (SELECT created_at FROM core_messages WHERE id = %s) ORDER BY created_at DESC LIMIT %s""",
        (thread_id, before_id, HISTORY)) or []
    out = []
    for r in reversed(rows):
        text = (r["body"] or "").strip()
        answered = (r.get("props") or {}).get("answered")
        if text:
            out.append({"role": r["role"], "actor": r["actor"], "text": text[:HISTORY_CHARS] + (f"\n[ответ человека: {answered}]" if answered else "")})
    return out


def _where(context: list[dict]) -> str:
    """«Где человек сейчас» — словами: раздел и открытые окна (то, что он не зачеркнул в поле ввода)."""
    lines = []
    for c in context or []:
        kind = KINDS.get(c.get("kind") or "", c.get("kind") or "")
        ref = f" (id {c['id']})" if c.get("id") else ""
        url = f" — {c['url']}" if c.get("url") else ""
        lines.append(f"- {kind}: «{c.get('title') or ''}»{ref}{url}")
    return "\n".join(lines)


def _mcp_key(user_id: str, provider: str, message_id: str) -> tuple[str, int]:
    """Ключ MCP на один запуск: права человека, весь «Офис», календарь, задачи, файлы, люди и память. Отзывается в
    конце запуска (store.finish_job), а не успели — сгорает сам через JOB_KEY_HOURS."""
    import secrets as _secrets

    from app.modules.mcp import apps, keys

    token = keys.PREFIX + _secrets.token_urlsafe(32)
    from app.modules.core_agents import permissions

    scope = {"access": "create", "kinds": list(keys.KINDS), "folders": None, "shared": True, "apps": list(apps.APPS), "job": message_id,
             "mode": permissions.mode_of(user_id)}
    row = db.conn.fetch_one(
        "INSERT INTO mcp_keys (user_id, name, token_hash, token_start, scope, expires_at) "
        "VALUES (%s, %s, %s, %s, %s, now() + make_interval(hours => %s)) RETURNING id",
        (user_id, f"{keys.JOB_PREFIX}{store.PROVIDERS[provider]['label']}", keys._hash(token), token[:len(keys.PREFIX) + 4], Json(scope), JOB_KEY_HOURS))
    return token, int(row["id"])


SYSTEM = """Вы — личный агент сотрудника в Шаре (рабочая система компании «{company}»). Человек: {name}{position}.
Сейчас {now}, время местное.

Как работать:
- Отвечайте по-русски, коротко и по делу. Markdown можно (таблицы, списки, код).
- Всё в Шаре вы делаете инструментами MCP сервера «shar»: «Офис» (заметки, документы, таблицы), календарь, задачи,
  «Файлы», люди, память и навыки. Права — ровно права человека.
- Человек работает рядом с вами в реальном времени: документ, который вы правите, у него может быть открыт.
  Правьте точечно (edit_document, edit_note, update_table с cells), не переписывайте целиком без просьбы.
- «В документе», «здесь», «сюда», «в таблице» без названия — это открытое у человека сейчас (строка «Сейчас у меня
  на экране» в начале его сообщения; первым — то, что перед глазами), даже если раньше в разговоре был другой
  документ: пишите в него. Новый материал создавайте, только если просят новый или ничего
  не открыто. Открытое у человека заново не открывайте (open_in_shar) — он и так его видит.
- Режим разрешений человека: {mode}. Где нужно его согласие, сервер не выполнит инструмент без approval_id — тогда
  вызовите request_permission (что именно сделаете, одной фразой), коротко скажите, что ждёте, и закончите ответ.
- Не уверены, чего хочет человек, или есть варианты — спросите ask_user с кнопками и закончите ответ: выбор придёт
  следующим сообщением. Лучше один точный вопрос, чем работа «мимо».
- Переписки (чаты, почта, соцсети) вам закрыты. Если нужен их текст — попросите переслать («Переслать агенту»).
- Показать человеку материал — open_in_shar (документ, задачу, календарь), а не только ссылкой.
- Подстраивайтесь под человека: поправил вашу работу или сказал «всегда/никогда» — profile_note. Важный факт,
  договорённость, где что лежит — memory_add (полезное всей компании — shared: true). Повторяющаяся задача или
  человек объяснил, как её делать, — skill_write. Перед задачей посмотрите, нет ли навыка под неё.
- Ссылки на материалы Шара давайте внутренними адресами из ответов инструментов (url): /office?kind=…&id=…, /tasks?task=…

{memory}"""


def build_run(job: dict) -> dict:
    """Задача run для ноды целиком. Вызывается при взятии — профиль и ключи самые свежие, секреты в очереди не лежат."""
    from datetime import datetime

    payload = job.get("payload") or {}
    user_id = job["user_id"]
    provider = job["provider"]
    message = db.conn.fetch_one("SELECT * FROM core_messages WHERE id = %s", (payload.get("userMessageId"),)) or {}
    thread = db.conn.fetch_one("SELECT * FROM core_threads WHERE id = %s", (payload.get("threadId"),)) or {}
    user = db.get_user_by_id(user_id) or {}
    props = message.get("props") or {}
    where = _where(props.get("context") or [])
    from app.modules.mcp.files import absolute

    attachments = [{"name": a.get("name"), "url": absolute(a.get("url") or ""), "size": a.get("size"), "type": a.get("type")}
                   for a in props.get("attachments") or []]
    token, key_id = _mcp_key(user_id, provider, job["message_id"])
    db.conn.execute_query("UPDATE core_jobs SET mcp_key_id = %s WHERE id = %s", (key_id, job["id"]))
    system = SYSTEM.format(
        company=_company(), name=user.get("name") or user.get("username") or "сотрудник",
        position=f", {user['position']}" if user.get("position") else "",
        now=datetime.now().strftime("%A, %d.%m.%Y %H:%M"), mode=_mode_text(user_id),
        memory=memory.prompt_context(user_id) if _memory_ready() else "")
    reply = props.get("replyTo") or {}
    # Ответ кнопкой разрешения: человек видит «Разрешить», агенту уходит служебное — с approval_id.
    text = (props.get("agentNote") or message.get("body") or "").strip()
    if reply.get("text"):
        text = f"> {reply['text'][:600]}\n\n{text}"
    if props.get("forwarded"):
        text = f"{_forwarded(props['forwarded'])}\n\n{text or 'Разберись с пересланным.'}"
    # «Где я» — в самом сообщении, рядом с просьбой: из системной части агент в продолжающемся разговоре его
    # упускает («документ» = тот, что он сам создал раньше), а GPT и Gemini при продолжении сессии её не получают вовсе.
    # Системная часть от этого не меняется от хода к ходу — лучше кэшируется.
    if where:
        text = f"[Сейчас у меня на экране — «документ», «этот», «здесь», «сюда» значит это:\n{where}]\n\n{text}"
    out: dict[str, Any] = {
        "id": str(job["id"]), "kind": "run", "provider": provider, "userId": user_id, "messageId": job["message_id"],
        "threadId": thread.get("id"), "model": payload.get("model") or "", "effort": payload.get("effort") or "medium",
        "system": system, "prompt": text, "attachments": attachments,
        "history": _history(thread.get("id") or "", message.get("id") or ""),
        "resume": ((thread.get("sessions") or {}).get(provider) or "") if thread else "",
        "mcp": {"url": _public_url("/api/mcp"), "token": token},
    }
    from app.modules.core_agents import mcp_servers

    out["extraMcp"] = mcp_servers.for_run(user_id)  # личные MCP человека — с секретами, только в задаче ноде
    if provider == "gemini":
        out["apiKey"] = store.unseal(store.account(user_id, "gemini").get("secret_enc") or "")
    return out


def _mode_text(user_id: str) -> str:
    from app.modules.core_agents import permissions

    mode = permissions.mode_of(user_id)
    return f"«{permissions.MODES[mode]['label']}» — {permissions.MODES[mode]['hint'].lower()}"


def _forwarded(items: list[dict]) -> str:
    """Пересланное из чатов — блоком перед сообщением. Это всё, что агент знает о переписке: доступа к чатам у него нет."""
    lines = ["## Пересланные сообщения из чата Шара (человек переслал сам; других сообщений вы не видите)"]
    for item in items[:50]:
        files = f" [вложения: {', '.join(item.get('files') or [])}]" if item.get("files") else ""
        lines.append(f"**{item.get('author') or 'Кто-то'}** ({item.get('at') or ''}):{files}\n{(item.get('text') or '').strip()[:4000]}")
    return "\n\n".join(lines)


def _memory_ready() -> bool:
    from app.modules.workspace import store as ws_store

    return ws_store.table_ready("core_skills")


def _company() -> str:
    import os

    return os.getenv("SHAR_COMPANY_NAME", "Вокруг света")


def _public_url(path: str) -> str:
    from app.modules.mcp.files import absolute

    return absolute(path)
