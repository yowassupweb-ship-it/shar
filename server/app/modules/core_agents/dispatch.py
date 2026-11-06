"""Сообщение в «Ядре» → задача ноде → ответ агента в чате.

Человек пишет в чат: если у него подключён агент, рядом с его сообщением сразу появляется ответ агента в статусе
queued («ждёт ноду»), а в core_jobs — задача run. Нода берёт её (node.py) и получает всё для запуска: текст, историю
чата, где человек сейчас (context), вложения, профиль и навыки (memory.prompt_context), ключ MCP на этот запуск и —
для Gemini — ключ человека. Дальше нода пишет в то же сообщение шаги, текст и ход работы (node.py → events).
"""

from __future__ import annotations

import hashlib
import logging
import re
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


def dispatch(user_id: str, thread: dict, user_message: dict, *, wanted: str = "", effort: str = "", plan: bool = False) -> Optional[dict]:
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
        "threadId": thread["id"], "userMessageId": user_message["id"], "model": agent["model"], "effort": effort or "medium",
        # План-режим есть только у Kimi (режим «plan» его протокола ACP); остальным агентам флаг не нужен.
        **({"plan": True} if plan and provider == "kimi" else {})})
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


_NOUNS = r"(?:документ|таблиц|заметк|файл|презентац|слайд|лист|страниц|текст|задач|событи|письм|ячейк|строк|колонк|столбц|абзац|заголов)\w*"
# Указатель на открытое: «здесь/тут/сюда», «на экране», «этот документ», «в таблице», «посмотри» без объекта.
_DEIXIS = re.compile(
    r"(?<![\w-])(?:здесь|тут|сюда|отсюда|на\s+экране|перед\s+глазами|открыт\w*|текущ\w+\s+" + _NOUNS + r"|"
    r"(?:этот|эта|это|эту|этом|этой|этого|эти|этих|данн\w+|выделенн\w+)\s+" + _NOUNS + r"|"
    r"(?:в|на|из|по|над|к|об|про)\s+" + _NOUNS + r"|посмотри|глянь|взгляни)(?![\w-])", re.I | re.U)


def refers_to_screen(text: str) -> bool:
    """В просьбе есть указатель на то, что у человека открыто. Без него открытое — только справка (см. build_run)."""
    return bool(_DEIXIS.search(text or ""))


def _short(where: str, limit: int = 3) -> str:
    """В справке — не больше нескольких строк: пять окон «на фоне» уже сами по себе тянут внимание агента."""
    return "\n".join(where.splitlines()[:limit])


def key_scope(user_id: str, provider: str, message_id: str) -> dict:
    """Права ключа MCP на запуск: человека, весь «Офис», календарь, задачи, файлы, люди, память. job — ответ, к которому
    привязаны вопросы, картинки и разрешения агента; mode — режим разрешений на этот момент."""
    from app.modules.core_agents import permissions
    from app.modules.mcp import apps, keys

    return {"access": "create", "kinds": list(keys.KINDS), "folders": None, "shared": True, "apps": list(apps.APPS), "job": message_id,
            "provider": provider, "mode": permissions.mode_of(user_id)}


def _mcp_key(user_id: str, provider: str, message_id: str) -> tuple[str, int]:
    """Ключ MCP на один запуск: права человека, весь «Офис», календарь, задачи, файлы, люди и память. Отзывается в
    конце запуска (store.finish_job), а не успели — сгорает сам через JOB_KEY_HOURS."""
    import secrets as _secrets

    from app.modules.mcp import apps, keys

    token = keys.PREFIX + _secrets.token_urlsafe(32)
    scope = key_scope(user_id, provider, message_id)
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
  Правьте точечно (edit_document, edit_note, update_table с cells), не переписывайте целиком без просьбы. Перед рискованной
  правкой используйте dry_run=true и покажите человеку diff; запись делайте отдельным вызовом без dry_run.
- По коду ошибки действуйте точно: stale_version — перечитайте материал; text_not_found — возьмите фрагмент из свежего
  read_item; permission_required — request_permission; permission_denied/not_found — не повторяйте тот же вызов вслепую.
- {image_rule}
- Файлы из «Файлов» правятся на месте: сначала file_read (rights, editable, editWith), затем file_edit с base_updated_at; формат
  сохраняется (кодировка, CRLF, оформление docx/pptx). Править можно свой файл и тот, где вам дано право редактирования;
  ошибка permission_denied — файл открыт только на просмотр. Прежняя версия остаётся (file_versions, file_restore_version).
- Что открыто у человека (блок в начале его сообщения) — только справка. Просьба чаще всего к открытому НЕ относится:
  вопрос, новая задача, другой материал, просто разговор. Тогда не читайте открытое, не упоминайте его и не
  привязывайте к нему ответ. Что названо по имени или в самой просьбе — важнее открытого.
- Открытое — предмет просьбы, только если в ней есть указатель: «здесь», «тут», «сюда», «этот документ», «в таблице»
  без названия, «посмотри» без объекта. Тогда это материал из блока (первым — тот, что перед глазами), даже если раньше
  в разговоре был другой: сначала прочитайте его (read_item по id), потом отвечайте или правьте. Не спрашивайте то, что
  видно в самом материале: где что стоит, какой диапазон, что уже написано. Открытое заново не открывайте (open_in_shar).
- Новый материал создавайте, только если просят новый или правке негде быть.
- Режим разрешений человека: {mode}. Где нужно его согласие, сервер не выполнит инструмент без approval_id — тогда
  вызовите request_permission с конкретным планом (tools — список, если нужно несколько инструментов), коротко скажите,
  что ждёте, и закончите ответ.
- Не уверены, чего хочет человек, или есть варианты — спросите ask_user с кнопками и закончите ответ: выбор придёт
  следующим сообщением. Лучше один точный вопрос, чем работа «мимо».
- Переписки (чаты, почта, соцсети) вам закрыты. Если нужен их текст — попросите переслать («Переслать агенту»).
- Показать человеку материал — open_in_shar (документ, задачу, календарь), а не только ссылкой.
- «Напомни позже», «запусти завтра», «проверяй каждый день/неделю» — agent_schedule, а не обещание написать самому.
  Текущие входящие уведомления — events_list. Разовый запуск требует at, ежедневный — time, еженедельный — time и weekdays.
- Учитесь на ходу, не откладывая. Человек поправил вашу работу («не так», «лучше так», «всегда/никогда») — сразу
  profile_note в раздел «Поправки» одной конкретной строкой: что именно было не так и как правильно. Выяснили
  предпочтение (тон, формат, куда класть, с кем согласовывать) — profile_note. Важный факт, договорённость,
  где что лежит — memory_add (полезное всей компании — shared: true). Задача повторяется или человек объяснил, как её
  делать, — skill_write (когда применять + шаги + что проверить). Если вам помогло или подвело знание из памяти или
  навыка — поправьте его (memory_add с новой версией, skill_write). Не записывайте лишнее: пересказ разговора и то,
  что уже есть в профиле, — шум. Перед задачей посмотрите блок «Из памяти по теме просьбы» и навыки: не изобретайте заново.
- Ссылки на материалы Шара давайте внутренними адресами из ответов инструментов (url): /office?kind=…&id=…, /tasks?task=…

{memory}"""


def build_run(job: dict, warm: bool = False) -> dict:
    """Задача run для ноды целиком. Вызывается при взятии — профиль и ключи самые свежие, секреты в очереди не лежат.
    warm — нода умеет держать процесс агента на чат (caps: warm): ключ MCP она берёт сама и продлевает на каждое сообщение
    (node.warm_key), поэтому здесь его не выдаём — mcp.lazy."""
    from datetime import datetime, timedelta, timezone

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
    lazy = warm and provider == "claude"
    token, key_id = ("", None) if lazy else _mcp_key(user_id, provider, job["message_id"])
    if key_id:
        db.conn.execute_query("UPDATE core_jobs SET mcp_key_id = %s WHERE id = %s", (key_id, job["id"]))
    base = dict(
        company=_company(), name=user.get("name") or user.get("username") or "сотрудник",
        position=f", {user['position']}" if user.get("position") else "",
        image_rule=("Картинки рисуйте своим встроенным image_gen: он работает через вашу подписку GPT; готовый файл Шар покажет человеку сам."
                    if provider == "codex" else
                    "Картинки рисуйте сами, своим средством (встроенный генератор, код, SVG) — Gemini не нужен. Проще всего SVG-файл: пишете "
                    "его прямо в папку для готовых картинок (путь в блоке «Готовые картинки» сообщения) — Шар сам покажет его в чате, "
                    "рендерить и кодировать в base64 не нужно. image_attach (base64) — только если папки нет; image_generate — запасной "
                    "путь при подключённом Gemini."))
    now_text = datetime.now(timezone(timedelta(hours=3))).strftime("%A, %d.%m.%Y %H:%M МСК")
    mode_text = _mode_text(user_id)
    system = SYSTEM.format(**base, now=now_text, mode=mode_text, memory=memory.prompt_context(user_id) if _memory_ready() else "")
    # Что менять не нужно, пока процесс агента живой: правила без времени, режима и памяти. Совпало — процесс продолжает чат.
    system_key = hashlib.sha1(SYSTEM.format(**base, now="", mode="", memory="").encode("utf-8")).hexdigest()[:16]
    reply = props.get("replyTo") or {}
    # Ответ кнопкой разрешения: человек видит «Разрешить», агенту уходит служебное — с approval_id.
    text = (props.get("agentNote") or message.get("body") or "").strip()
    ask = text  # собственные слова человека: по ним решаем, про открытое ли речь (цитата и пересланное — не в счёт)
    if reply.get("text"):
        text = f"> {reply['text'][:600]}\n\n{text}"
    if props.get("forwarded"):
        text = f"{_forwarded(props['forwarded'])}\n\n{text or 'Разберись с пересланным.'}"
    # «Где я» — в самом сообщении, рядом с просьбой: из системной части агент в продолжающемся разговоре его
    # упускает («документ» = тот, что он сам создал раньше), а GPT и Gemini при продолжении сессии её не получают вовсе.
    # Системная часть от этого не меняется от хода к ходу — лучше кэшируется.
    # Память по теме просьбы — прямо в сообщении: полезное из прошлых разговоров, оценок и навыки, подходящие к задаче.
    try:
        recalled = memory.recall(user_id, ask) if _memory_ready() else ""
    except Exception as exc:  # noqa: BLE001 — память не должна ронять запуск
        log.debug("recall failed: %s", exc)
        recalled = ""
    if recalled:
        text = f"[{recalled}]\n\n{text}"
    # Подсказку делаем сильной, только когда в просьбе есть указатель на открытое («здесь», «в таблице»…). Иначе это
    # справка: раньше строка велела «читать read_item» всегда, и агент привязывался к открытому файлу даже в разговоре
    # про другое.
    if where:
        if refers_to_screen(ask):
            text = (f"[Сейчас у меня на экране — «документ», «таблица», «этот», «здесь», «сюда» значит это "
                    f"(если в просьбе не названо другое; о чём речь — сначала прочитайте read_item по id):\n{where}]\n\n{text}")
        else:
            text = (f"[Справка, не часть просьбы: у меня сейчас открыто\n{_short(where)}\n"
                    "Просьба ниже, скорее всего, про другое. Не читайте это, не упоминайте и не привязывайте к нему ответ — "
                    f"используйте, только если просьба явно про открытое.]\n\n{text}")
    out: dict[str, Any] = {
        "id": str(job["id"]), "kind": "run", "provider": provider, "userId": user_id, "messageId": job["message_id"],
        "threadId": thread.get("id"), "model": payload.get("model") or "", "effort": payload.get("effort") or "medium",
        "system": system, "prompt": text, "attachments": attachments, "plan": bool(payload.get("plan")) and provider == "kimi",
        "history": _history(thread.get("id") or "", message.get("id") or ""),
        "resume": ((thread.get("sessions") or {}).get(provider) or "") if thread else "",
        "mcp": {"url": _public_url("/api/mcp"), **({"lazy": True} if lazy else {"token": token})},
        # Для тёплого процесса: ключ правил и то, что на каждое сообщение свежее (время, режим разрешений).
        "systemKey": system_key, "volatile": f"{now_text}, время местное; режим разрешений: {mode_text}",
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
