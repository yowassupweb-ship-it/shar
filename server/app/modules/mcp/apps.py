"""Инструменты MCP сверх «Офиса»: календарь, задачи, люди и память агента «Ядра».

Как и у «Офиса», инструменты зовут обработчики интерфейса (calendar/router.py, todos/router.py) от имени человека:
права, уведомления участникам и живые обновления экранов — те же, что при правке руками.

Открываются ключу списком apps в доступе (keys.clean_scope): у личных ключей из «Настройки → MCP» по умолчанию их нет
(ключ, выданный раньше, не получает молча доступ к календарю), у ключей запусков «Ядра» — все.

Время — местное время Шара без зоны: 2026-11-03T15:00:00. Весь день — all_day: true и дата в start.
"""

from __future__ import annotations

import html
import re
import uuid
from datetime import datetime, timedelta
from typing import Any

from app.modules.calendar import router as cal
from app.modules.core_agents import memory
from app.modules.todos import router as todos

APPS = ("calendar", "tasks", "files", "people", "agent", "integrations", "tours")
APP_NAMES = {"calendar": "календарь", "tasks": "задачи", "files": "файлы", "people": "люди", "agent": "память и навыки агента",
             "integrations": "подключённые API компании", "tours": "туры «Вокруг света» (каталог сайта)"}

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$")
STATUSES = {"pending": "В ожидании", "in-progress": "В работе", "review": "На проверке", "approval": "На согласовании",
            "approved": "Согласовано", "stuck": "Застряла", "cancelled": "Отменена"}
PRIORITIES = ("low", "medium", "high")


def _err(text: str) -> Exception:
    from app.modules.mcp.tools import ToolError  # поздний импорт: tools подключает этот модуль

    return ToolError(text)


def _call(fn, *args, **kwargs):
    from app.modules.mcp.tools import _call as call

    return call(lambda: fn(*args, **kwargs))


# ── время ────────────────────────────────────────────────────────────────────

def _when(value: Any, name: str, *, required: bool = True) -> str:
    text = str(value or "").strip().replace(" ", "T")
    if not text:
        if required:
            raise _err(f"Нужно {name}: 2026-11-03T15:00 или 2026-11-03")
        return ""
    if _DATE.match(text):
        return f"{text}T00:00:00"
    if _DATETIME.match(text):
        return text if len(text) == 19 else f"{text}:00"
    try:  # с зоной — в местное время сервера
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone().replace(tzinfo=None).isoformat(timespec="seconds")
    except ValueError as exc:
        raise _err(f"{name}: не понимаю «{text}», нужно 2026-11-03T15:00") from exc


def _plus(start: str, minutes: int) -> str:
    return (datetime.fromisoformat(start) + timedelta(minutes=minutes)).isoformat(timespec="seconds")


# ── календарь ────────────────────────────────────────────────────────────────

def _event_view(e: dict[str, Any], me: str) -> dict[str, Any]:
    return {
        "id": e.get("masterId") or e.get("id"), "occurrenceId": e.get("recurrenceId") or None,
        "title": e.get("title") or "", "start": e.get("startDateTime") or e.get("startDate"), "end": e.get("endDateTime") or e.get("endDate"),
        "allDay": bool(e.get("allDay")), "description": e.get("description") or "", "location": e.get("location") or "",
        "participants": [str(p) for p in e.get("participants") or []], "sharedWithAll": bool(e.get("sharedWithAll")),
        "recurrenceRule": e.get("recurrenceRule") or None, "reminderMinutesBefore": e.get("reminderMinutesBefore"),
        "mine": str(e.get("createdBy") or e.get("userId") or "") == me, "author": e.get("createdByName") or "",
    }


def calendar_list(access, args: dict[str, Any]) -> dict[str, Any]:
    start = _when(args.get("from") or datetime.now().date().isoformat(), "from")[:10]
    end = _when(args.get("to") or (datetime.fromisoformat(start) + timedelta(days=7)).date().isoformat(), "to")[:10]
    if (datetime.fromisoformat(end) - datetime.fromisoformat(start)).days > 366:
        raise _err("Период — не больше года")
    data = _call(cal.get_events, startDate=start, endDate=f"{end}T23:59:59", type=None, tag=None, userId=None, personal=True, me=access.me)
    query = str(args.get("query") or "").lower().strip()
    events = [_event_view(e, access.me.user_id) for e in data.get("events") or []]
    if query:
        events = [e for e in events if query in f"{e['title']} {e['description']} {e['location']}".lower()]
    events.sort(key=lambda e: str(e["start"] or ""))
    return {"from": start, "to": end, "events": events[:300], "total": len(events)}


def _event_fields(args: dict[str, Any], *, partial: bool) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "title" in args or not partial:
        title = str(args.get("title") or "").strip()
        if not title:
            raise _err("Нужно название события (title)")
        out["title"] = title[:300]
    all_day = args.get("all_day")
    if "start" in args or not partial:
        start = _when(args.get("start"), "start")
        if all_day:
            start = f"{start[:10]}T00:00:00"
        end = _when(args.get("end"), "end", required=False) or (start if all_day else _plus(start, int(args.get("duration_minutes") or 60)))
        if all_day:
            end = f"{end[:10]}T00:00:00"
        if end < start:
            raise _err("Конец раньше начала")
        out.update(startDateTime=start, startDate=start, endDateTime=end, endDate=end)
    elif "end" in args:
        end = _when(args.get("end"), "end")
        out.update(endDateTime=end, endDate=end)
    if all_day is not None:
        out["allDay"] = bool(all_day)
    for src, dst in (("description", "description"), ("location", "location"), ("color", "color"), ("recurrence_rule", "recurrenceRule")):
        if src in args:
            out[dst] = args.get(src) or (None if dst == "recurrenceRule" else "")
    if "reminder_minutes" in args:
        value = args.get("reminder_minutes")
        out["reminderMinutesBefore"] = None if value in (None, "") else int(value)
    if "participants" in args:
        out["participants"] = [str(p) for p in args.get("participants") or [] if str(p).strip()][:100]
    if "shared_with_all" in args:
        out["sharedWithAll"] = bool(args.get("shared_with_all"))
    return out


def calendar_create(access, args: dict[str, Any]) -> dict[str, Any]:
    fields = _event_fields(args, partial=False)
    fields.setdefault("participants", [])
    fields.setdefault("sharedWithAll", False)
    fields.setdefault("allDay", False)
    payload = {**fields, "id": uuid.uuid4().hex, "type": "personal", "createdByName": access.me.display_name}
    created = _call(cal.create_event, payload, access.me)
    return {"created": _event_view(created, access.me.user_id), "url": "/calendar"}


def calendar_update(access, args: dict[str, Any]) -> dict[str, Any]:
    event_id = str(args.get("id") or "")
    fields = _event_fields({k: v for k, v in args.items() if k not in ("id", "scope", "occurrence_id")}, partial=True)
    if not fields:
        raise _err("Нечего менять: укажите хотя бы одно поле")
    scope = args.get("scope") or "all"
    if scope != "all":
        if not args.get("occurrence_id"):
            raise _err("Для одного повторения (scope=this/following) нужен occurrence_id из calendar_list")
        fields.update(editScope=scope, recurrenceId=args["occurrence_id"])
    updated = _call(cal.update_event_by_id, event_id, fields, access.me)
    return {"updated": _event_view(updated, access.me.user_id)}


def calendar_delete(access, args: dict[str, Any]) -> dict[str, Any]:
    if args.get("confirm") is not True:
        raise _err("Удаление события нужно подтвердить: confirm: true (сначала спросите человека, если он сам не просил)")
    event_id = str(args.get("id") or "")
    scope = "this" if args.get("scope") == "this" else "all"
    if scope == "this" and not args.get("occurrence_id"):
        raise _err("Для одного повторения нужен occurrence_id из calendar_list")
    _call(cal.delete_event_by_id, event_id, scope, args.get("occurrence_id"), access.me)
    return {"id": event_id, "deleted": True, "scope": scope}


# ── задачи ───────────────────────────────────────────────────────────────────

def markdown_to_html(text: str) -> str:
    """Текст задачи для старого экрана (он читает description как HTML) — тот же вид, что даёт клиентский markdownToHtml."""
    def inline(s: str) -> str:
        s = html.escape(s)
        s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
        s = re.sub(r"(?<!\*)\*(?!\*)(.+?)\*", r"<em>\1</em>", s)
        s = re.sub(r"`(.+?)`", r"<code>\1</code>", s)
        return re.sub(r"\[(.+?)\]\((https?://[^)\s]+|/[^)\s]*)\)", r'<a href="\2">\1</a>', s)

    out: list[str] = []
    kind = ""
    for raw in text.split("\n"):
        line = raw.rstrip()
        m = re.match(r"^\s*(?:[-*]|(\d+)\.)\s+(?:\[( |x)\]\s+)?(.*)$", line)
        want = ("ol" if m.group(1) else "ul") if m else ""
        if kind and want != kind:
            out.append(f"</{kind}>")
            kind = ""
        if m:
            if not kind:
                out.append(f"<{want}>")
                kind = want
            box = "" if m.group(2) is None else ("☑ " if m.group(2) == "x" else "☐ ")
            out.append(f"<li>{box}{inline(m.group(3))}</li>")
            continue
        h = re.match(r"^(#{1,3})\s+(.*)$", line)
        if h:
            out.append(f"<h{len(h.group(1))}>{inline(h.group(2))}</h{len(h.group(1))}>")
        elif line.strip():
            out.append(f"<p>{inline(line)}</p>")
    if kind:
        out.append(f"</{kind}>")
    return "".join(out)


def _task_view(t: dict[str, Any], *, full: bool = False) -> dict[str, Any]:
    md = (t.get("metadata") or {}).get("md") if isinstance(t.get("metadata"), dict) else None
    status = t.get("status") if t.get("status") in STATUSES else "pending"
    view = {
        "id": str(t.get("id")), "title": t.get("title") or "", "status": status, "statusName": STATUSES[status],
        "priority": t.get("priority") or "medium", "done": bool(t.get("isCompleted") or t.get("completed")),
        "dueDate": t.get("dueDate") or None, "listId": t.get("listId") or None,
        "assignees": [str(x) for x in (t.get("assignedToIds") or ([t["assignedToId"]] if t.get("assignedToId") else []))],
        "authorId": str(t.get("authorId") or ""), "updatedAt": t.get("updatedAt") or t.get("createdAt"), "url": f"/tasks?task={t.get('id')}",
    }
    if full:
        view["text"] = md if isinstance(md, str) else re.sub(r"<[^>]+>", " ", t.get("description") or "").strip()
    return view


def tasks_list(access, args: dict[str, Any]) -> dict[str, Any]:
    data = _call(todos.get_todos, userId=None, taskId=None, me=access.me)
    me = access.me.user_id
    items = [t for t in data.get("todos") or [] if not t.get("archived")]
    if not args.get("include_done"):
        items = [t for t in items if not (t.get("isCompleted") or t.get("completed"))]
    if args.get("mine"):
        items = [t for t in items if me in {str(x) for x in (t.get("assignedToIds") or [])} | {str(t.get("assignedToId") or "")}]
    if args.get("status"):
        items = [t for t in items if (t.get("status") or "pending") == args["status"]]
    if args.get("list_id"):
        items = [t for t in items if str(t.get("listId") or "") == str(args["list_id"])]
    query = str(args.get("query") or "").lower().strip()
    if query:
        items = [t for t in items if query in f"{t.get('title') or ''} {(t.get('metadata') or {}).get('md') or t.get('description') or ''}".lower()]
    items.sort(key=lambda t: str(t.get("updatedAt") or t.get("createdAt") or ""), reverse=True)
    limit = max(1, min(int(args.get("limit") or 50), 200))
    lists = [{"id": str(l.get("id")), "name": l.get("name")} for l in data.get("lists") or []]
    return {"tasks": [_task_view(t) for t in items[:limit]], "total": len(items), "lists": lists}


def task_read(access, args: dict[str, Any]) -> dict[str, Any]:
    data = _call(todos.get_todos, userId=None, taskId=str(args.get("id") or ""), me=access.me)
    found = (data.get("todos") or [None])[0]
    if not found:
        raise _err("Задача не найдена")
    return _task_view(found, full=True)


def _task_fields(args: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "title" in args:
        title = str(args.get("title") or "").strip()
        if not title:
            raise _err("Пустое название задачи")
        out["title"] = title[:300]
    if "text" in args:
        md = str(args.get("text") or "")
        out["description"] = markdown_to_html(md)
        out["metadata"] = {"md": md}
    if "status" in args:
        if args["status"] not in STATUSES:
            raise _err(f"status: одно из {', '.join(STATUSES)}")
        out["status"] = args["status"]
    if "priority" in args:
        if args["priority"] not in PRIORITIES:
            raise _err("priority: low, medium или high")
        out["priority"] = args["priority"]
    if "due_date" in args:
        out["dueDate"] = _when(args["due_date"], "due_date") if args.get("due_date") else None
    if "assignee_ids" in args:
        ids = [str(x) for x in args.get("assignee_ids") or [] if str(x).strip()]
        if not ids:
            raise _err("Нужен хотя бы один исполнитель (id из people_search)")
        out.update(assignedToIds=ids, assignedToId=ids[0])
    if "done" in args:
        out["isCompleted"] = bool(args["done"])
    if "list_id" in args:
        out["listId"] = args.get("list_id") or None
    return out


def task_create(access, args: dict[str, Any]) -> dict[str, Any]:
    if not str(args.get("title") or "").strip():
        raise _err("Нужно название задачи (title)")
    fields = _task_fields({"text": "", "assignee_ids": [access.me.user_id], **args})
    me = access.me.user_id
    payload = {"type": "todo", "status": "pending", "priority": "medium", "authorId": me, "assignedById": me, **fields}
    created = _call(todos.create_todo, None, payload, access.me)
    return {"created": _task_view(created, full=True)}


def task_update(access, args: dict[str, Any]) -> dict[str, Any]:
    task_id = str(args.get("id") or "")
    fields = _task_fields({k: v for k, v in args.items() if k != "id"})
    if not fields:
        raise _err("Нечего менять: укажите хотя бы одно поле")
    if "metadata" in fields:  # markdown кладём рядом с остальными метаданными задачи, а не вместо них
        current = (_call(todos.get_todos, userId=None, taskId=task_id, me=access.me).get("todos") or [{}])[0]
        meta = current.get("metadata") if isinstance(current.get("metadata"), dict) else {}
        fields["metadata"] = {**meta, **fields["metadata"]}
    _call(todos.update_todo, None, {"id": task_id, "type": "todo", **fields}, access.me)
    return task_read(access, {"id": task_id})


def task_delete(access, args: dict[str, Any]) -> dict[str, Any]:
    if args.get("confirm") is not True:
        raise _err("Удаление задачи нужно подтвердить: confirm: true (сначала спросите человека, если он сам не просил)")
    task_id = str(args.get("id") or "")
    _call(todos.delete_todo, task_id, "todo", access.me)
    return {"id": task_id, "deleted": True}


# ── люди ─────────────────────────────────────────────────────────────────────

def people_search(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.core.db import db

    query = str(args.get("query") or "").lower().strip()
    rows = db.get_users() or []
    out = []
    for u in rows:
        name = u.get("name") or u.get("username") or ""
        hay = f"{name} {u.get('username') or ''} {u.get('position') or ''} {u.get('department') or ''}".lower()
        if query and not all(w in hay for w in query.split()):
            continue
        out.append({"id": str(u.get("id")), "name": name, "position": u.get("position") or "", "department": u.get("department") or "",
                    "me": str(u.get("id")) == access.me.user_id})
    return {"people": out[:50], "total": len(out)}


# ── память и навыки ──────────────────────────────────────────────────────────

def _mem(fn, *args):
    try:
        return fn(*args)
    except memory.MemoryError_ as exc:
        raise _err(str(exc)) from exc


def profile_read(access, args: dict[str, Any]) -> dict[str, Any]:
    return {"profile": memory.profile(access.me.user_id)}


def profile_note(access, args: dict[str, Any]) -> dict[str, Any]:
    _mem(memory.profile_note, access.me.user_id, str(args.get("section") or ""), str(args.get("text") or ""), access.ctx.key_name)
    return {"ok": True}


def profile_write(access, args: dict[str, Any]) -> dict[str, Any]:
    text = str(args.get("markdown") or "")
    if not text.strip():
        raise _err("Пустой профиль: стирать профиль целиком нельзя")
    memory.set_profile(access.me.user_id, text, access.ctx.key_name)
    return {"ok": True, "size": len(text)}


def memory_add(access, args: dict[str, Any]) -> dict[str, Any]:
    return _mem(memory.add_note, access.me.user_id, str(args.get("text") or ""), list(args.get("tags") or []), access.ctx.key_name,
                bool(args.get("shared")))


def memory_search(access, args: dict[str, Any]) -> dict[str, Any]:
    return {"notes": memory.search_notes(access.me.user_id, str(args.get("query") or ""), str(args.get("tag") or ""), int(args.get("limit") or 20),
                                         str(args.get("scope") or "all"))}


def skill_list(access, args: dict[str, Any]) -> dict[str, Any]:
    return {"skills": memory.skills(access.me.user_id)}


def skill_read(access, args: dict[str, Any]) -> dict[str, Any]:
    found = memory.skill(access.me.user_id, str(args.get("name") or ""), count_use=True)
    if not found:
        raise _err("Навыка с таким именем нет (skill_list)")
    return found


def skill_write(access, args: dict[str, Any]) -> dict[str, Any]:
    shared = bool(args.get("shared"))
    if shared:
        author = memory.shared_skill_author(str(args.get("name") or "").strip().lower())
        if author not in (None, access.me.user_id) and not access.me.is_admin:
            raise _err("Этот общий навык написан для другого сотрудника: правит его автор или админ. Сделайте свой (shared: false)")
    return _mem(lambda: memory.write_skill(access.me.user_id, str(args.get("name") or ""), str(args.get("description") or ""),
                                           str(args.get("body") or ""), access.ctx.key_name, shared=shared))


def request_permission(access, args: dict[str, Any]) -> dict[str, Any]:
    """Попросить разрешения на действие, которое режим человека без согласия не пускает (permissions.py)."""
    from app.modules.core_agents import permissions

    message_id = access.ctx.scope.get("job")
    if not message_id:
        raise _err("Разрешение спрашивают только из чата «Ядра»")
    tool = str(args.get("tool") or "").strip()
    summary = " ".join(str(args.get("summary") or "").split())[:500]
    if not tool or not summary:
        raise _err("Нужны tool (какой инструмент) и summary (что именно сделаете — одной фразой)")
    approval_id = permissions.request(access.me.user_id, message_id, tool, summary)
    return {"asked": True, "approval": approval_id,
            "note": "Карточка «Разрешить / Запретить» показана. Коротко скажите, что ждёте решения, и закончите ответ."}


def ask_user(access, args: dict[str, Any]) -> dict[str, Any]:
    """Вопрос с кнопками прямо в ответе агента (запуск «Ядра»): человек нажимает — ответ приходит следующим сообщением."""
    message_id = access.ctx.scope.get("job")
    if not message_id:
        raise _err("Спросить с кнопками можно только из чата «Ядра» — задайте вопрос текстом")
    kind = args.get("kind") if args.get("kind") in ("confirm", "choice", "multi") else "choice"
    options = [str(o).strip()[:120] for o in args.get("options") or [] if str(o).strip()][:8]
    if kind == "confirm" and not options:
        options = ["Да", "Нет"]
    if not options:
        raise _err("Нужны варианты ответа (options)")
    from app.modules.core_chat.router import update_agent_message

    update_agent_message(message_id, props={"ask": {"kind": kind, "question": str(args.get("question") or "")[:500]},
                                            "actions": [{"label": o, "value": o} for o in options]})
    return {"shown": True, "note": "Вопрос показан. Закончите ответ коротко (что ждёте) — выбор человека придёт следующим сообщением."}


# ── подключённые API, свои агенты, окна Шара ────────────────────────────────

def integration_list(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents import integrations

    items = integrations.listing(access.me.user_id, access.me.is_admin)
    return {"integrations": [{k: v for k, v in i.items() if k != "fields" or access.me.is_admin} for i in items],
            "canManage": access.me.is_admin}


def integration_call(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents import integrations

    service = str(args.get("service") or "")
    if not integrations.open_to(service, access.me.user_id, access.me.is_admin):
        raise _err("Этот API вам не открыт — доступ выдаёт администратор (Админка → Ядро → Интеграции)")
    return integrations.call(service, method=str(args.get("method") or ""), path=str(args.get("path") or ""),
                             query=args.get("query") if isinstance(args.get("query"), dict) else None, body=args.get("body"),
                             max_chars=int(args.get("max_chars") or 30_000))


def _admin(access) -> None:
    if not access.me.is_admin:
        raise _err("Подключает и удаляет API компании администратор — попросите его")


def integration_save(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents import integrations

    _admin(access)
    service = str(args.get("service") or "").strip().lower()
    try:
        integrations.save(service, {k: v for k, v in args.items() if k != "service"}, access.ctx.key_name)
    except (integrations.IntegrationError, RuntimeError) as exc:
        raise _err(str(exc)) from exc
    return {"saved": service, "test": integrations.test(service)}


def integration_delete(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents import integrations

    _admin(access)
    if args.get("confirm") is not True:
        raise _err("Удаление API нужно подтвердить: confirm: true (сначала спросите человека)")
    integrations.delete(str(args.get("service") or ""))
    return {"deleted": args.get("service")}


def connect_gemini(access, args: dict[str, Any]) -> dict[str, Any]:
    """Человек прислал ключ Google в чат — подключаем его Gemini сами. Ключ проверяется у Google и хранится зашифрованным."""
    from app.modules.core_agents import accounts

    result = _call(accounts.put_gemini, accounts.GeminiBody(key=str(args.get("key") or "").strip()), access.me)
    card = next(a for a in result["accounts"] if a["provider"] == "gemini")
    return {"connected": True, "model": card["model"], "models": [m["id"] for m in card["models"]][:10],
            "note": "Ключ сохранён зашифрованным. Посоветуйте человеку удалить сообщение с ключом из чата."}


def image_generate(access, args: dict[str, Any]) -> dict[str, Any]:
    """Нарисовать картинку (или поправить присланную) — Gemini по ключу человека; картинка — в ответ агента и в «Файлы → Агенты»."""
    from app.modules.core_agents import images

    try:
        file = images.generate(access.me.user_id, str(args.get("prompt") or ""), aspect=str(args.get("aspect") or ""),
                               source_url=str(args.get("source_url") or ""), name=str(args.get("name") or ""))
    except images.ImageError as exc:
        raise _err(str(exc)) from exc
    images.attach_to_job(str(access.ctx.scope.get("job") or ""), file)
    return {"image": {"name": file["name"], "url": file["url"], "model": file["model"]},
            "note": "Картинка уже показана человеку в чате под вашим ответом — не вставляйте её ссылкой ещё раз."
                    + (f" Комментарий модели: {file['note']}" if file.get("note") else "")}


def _tours(fn, *args, **kwargs):
    from app.modules.core_agents import tours

    try:
        return fn(*args, **kwargs)
    except tours.ToursError as exc:
        raise _err(str(exc)) from exc


def tours_search(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents import tours

    own = args.get("own")
    return _tours(tours.search, query=str(args.get("query") or ""), direction=str(args.get("direction") or ""),
                  segment=str(args.get("segment") or ""), own=own if isinstance(own, bool) else None,
                  days_min=int(args.get("days_min") or 0), days_max=int(args.get("days_max") or 0),
                  date_from=str(args.get("date_from") or ""), date_to=str(args.get("date_to") or ""),
                  price_max=float(args.get("price_max") or 0), topic=str(args.get("topic") or ""), holiday=str(args.get("holiday") or ""),
                  free_only=bool(args.get("free_only")), limit=int(args.get("limit") or 20), offset=int(args.get("offset") or 0))


def tour_get(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents import tours

    try:
        tour_id = int(str(args.get("id") or "").strip())
    except ValueError as exc:
        raise _err("Номер тура — число (как в адресе vs-travel.ru/tour?id=…)") from exc
    return _tours(tours.tour, tour_id)


def tours_directions(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents import tours

    return _tours(tours.directions, str(args.get("segment") or ""), str(args.get("query") or ""))


def tours_overview(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents import tours

    return _tours(tours.overview)


def agent_disconnect(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents import accounts

    if args.get("confirm") is not True:
        raise _err("Отключение нужно подтвердить: confirm: true")
    provider = str(args.get("provider") or "")
    _call(accounts.disconnect, provider, access.me)
    return {"disconnected": provider}


# Переписки (чаты, почта, соцсети) агенту закрыты совсем: ни инструментов, ни открытия окна. Нужное человек пересылает сам.
_CLOSED_PATHS = ("/chats", "/chat", "/messages", "/m/", "/mail", "/social")


def open_in_shar(access, args: dict[str, Any]) -> dict[str, Any]:
    """Открыть у человека раздел или материал Шара: его интерфейс получает живое событие и переходит по адресу."""
    from urllib.parse import urlparse

    raw = str(args.get("url") or "").strip()
    parsed = urlparse(raw)
    path = parsed.path or "/"
    if parsed.scheme or parsed.netloc or not path.startswith("/") or path.startswith("/api/"):
        raise _err("Нужен внутренний адрес Шара: /office?kind=document&id=94, /tasks?task=…, /calendar, /files?folder=…")
    if path.startswith(_CLOSED_PATHS):
        raise _err("Переписки (чаты, почта, соцсети) агенту закрыты: открыть их нельзя")
    target = path + (f"?{parsed.query}" if parsed.query else "")
    from app.core.realtime import sse_manager

    sse_manager.push(access.me.user_id, {"type": "core_open", "url": target, "window": bool(args.get("new_window"))})
    return {"opened": target}


def mcp_list(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents import mcp_servers

    return {"servers": mcp_servers.listing(access.me.user_id),
            "note": "Подключённые MCP становятся доступны со следующего сообщения (в новом ходе)."}


def mcp_install(access, args: dict[str, Any]) -> dict[str, Any]:
    """Поставить человеку MCP-сервер: удалённый по адресу или npm-пакет (нода запустит через npx)."""
    from app.modules.core_agents import mcp_servers

    try:
        server = mcp_servers.save(access.me.user_id, str(args.get("name") or ""), {k: v for k, v in args.items() if k != "name"}, access.ctx.key_name)
    except (mcp_servers.McpError, RuntimeError) as exc:
        raise _err(str(exc)) from exc
    return {"installed": server, "note": "Готово. Инструменты этого MCP появятся у вас со следующего сообщения человека — скажите ему об этом."}


def mcp_remove(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents import mcp_servers

    if args.get("confirm") is not True:
        raise _err("Удаление MCP нужно подтвердить: confirm: true")
    if not mcp_servers.remove(access.me.user_id, str(args.get("name") or "")):
        raise _err("Такого MCP нет (mcp_list)")
    return {"removed": args.get("name")}


_TIME = {"type": "string", "description": "местное время: 2026-11-03T15:00 (или дата 2026-11-03)"}
_EVENT_PROPS = {
    "title": {"type": "string"}, "start": _TIME, "end": _TIME,
    "duration_minutes": {"type": "integer", "minimum": 5, "description": "если нет end (по умолчанию 60)"},
    "all_day": {"type": "boolean"}, "description": {"type": "string"}, "location": {"type": "string"},
    "participants": {"type": "array", "items": {"type": "string"}, "description": "id людей (people_search): событие появится у них в календаре"},
    "shared_with_all": {"type": "boolean", "description": "видно всем сотрудникам"},
    "reminder_minutes": {"type": ["integer", "null"], "description": "напомнить за N минут; null — без напоминания"},
    "recurrence_rule": {"type": ["string", "null"], "description": "RRULE: FREQ=WEEKLY;BYDAY=MO,WE — повторение; null — без"},
    "color": {"type": "string", "enum": ["blue", "green", "orange", "red", "purple", "cyan", "gray"]},
}
_TASK_PROPS = {
    "title": {"type": "string"}, "text": {"type": "string", "description": "описание задачи в Markdown (списки, [ ] чек-листы)"},
    "status": {"type": "string", "enum": list(STATUSES)}, "priority": {"type": "string", "enum": list(PRIORITIES)},
    "due_date": {"type": ["string", "null"], "description": "срок: 2026-11-03T18:00; null — без срока"},
    "assignee_ids": {"type": "array", "items": {"type": "string"}, "description": "исполнители — id из people_search (по умолчанию — сам человек)"},
    "done": {"type": "boolean"}, "list_id": {"type": ["string", "null"], "description": "список задач (из tasks_list → lists)"},
}

TOOLS: list[dict[str, Any]] = [
    {"name": "calendar_list", "app": "calendar", "handler": calendar_list, "level": "read",
     "description": "События календаря человека за период (свои, куда позвали, общие). По умолчанию — неделя с сегодня. "
                    "Повторяющееся событие приходит каждым повторением: id — серия, occurrenceId — это повторение.",
     "inputSchema": {"type": "object", "properties": {"from": {"type": "string", "description": "дата начала 2026-11-01"},
                                                     "to": {"type": "string", "description": "дата конца включительно"},
                                                     "query": {"type": "string", "description": "слова из названия, описания, места"}}}},
    {"name": "calendar_create", "app": "calendar", "handler": calendar_create, "level": "create",
     "description": "Создать событие в календаре человека. Участники получат приглашение в свой календарь.",
     "inputSchema": {"type": "object", "properties": _EVENT_PROPS, "required": ["title", "start"]}},
    {"name": "calendar_update", "app": "calendar", "handler": calendar_update, "level": "edit",
     "description": "Изменить событие (менять может только автор). Передавайте только меняемые поля. "
                    "Повторяющееся: scope=all — вся серия, this — одно повторение, following — это и дальше (нужен occurrence_id).",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, **_EVENT_PROPS,
                                                     "scope": {"type": "string", "enum": ["all", "this", "following"]},
                                                     "occurrence_id": {"type": "string"}}, "required": ["id"]}},
    {"name": "calendar_delete", "app": "calendar", "handler": calendar_delete, "level": "create",
     "description": "Удалить событие (только своё). scope=this — одно повторение серии (нужен occurrence_id). Нужен confirm: true.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "scope": {"type": "string", "enum": ["all", "this"]},
                                                     "occurrence_id": {"type": "string"}, "confirm": {"type": "boolean"}}, "required": ["id", "confirm"]}},
    {"name": "tasks_list", "app": "tasks", "handler": tasks_list, "level": "read",
     "description": "Задачи, которые видит человек (его, поставленные им, отдела), и списки задач. По умолчанию — незакрытые, новые сверху.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "mine": {"type": "boolean", "description": "только где он исполнитель"},
                                                     "status": {"type": "string", "enum": list(STATUSES)}, "list_id": {"type": "string"},
                                                     "include_done": {"type": "boolean"}, "limit": {"type": "integer", "minimum": 1, "maximum": 200}}}},
    {"name": "task_read", "app": "tasks", "handler": task_read, "level": "read",
     "description": "Задача целиком: описание (Markdown), статус, исполнители, срок.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "task_create", "app": "tasks", "handler": task_create, "level": "create",
     "description": "Поставить задачу. Исполнители получат уведомление. Без assignee_ids — задача самому человеку.",
     "inputSchema": {"type": "object", "properties": _TASK_PROPS, "required": ["title"]}},
    {"name": "task_update", "app": "tasks", "handler": task_update, "level": "edit",
     "description": "Изменить задачу: статус, срок, исполнителей, текст (text заменяет описание целиком — сначала task_read), закрыть (done: true).",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, **_TASK_PROPS}, "required": ["id"]}},
    {"name": "task_delete", "app": "tasks", "handler": task_delete, "level": "create",
     "description": "Удалить задачу (может автор или постановщик). Нужен confirm: true. Закрыть выполненную — task_update с done: true, а не удаление.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "confirm": {"type": "boolean"}}, "required": ["id", "confirm"]}},
    {"name": "people_search", "app": "people", "handler": people_search, "level": "read",
     "description": "Сотрудники: id, имя, должность, отдел. Нужен для исполнителей задач и участников событий.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "description": "имя, логин, должность или отдел"}}}},
    {"name": "profile_read", "app": "agent", "handler": profile_read, "level": "read",
     "description": "Профиль человека, который вы ведёте: кто он, как любит работать, что поправлял за вами.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "profile_note", "app": "agent", "handler": profile_note, "level": "read",
     "description": "Дописать в профиль устойчивое наблюдение о человеке — особенно когда он поправил вашу работу или сказал «всегда/никогда». "
                    "Одно наблюдение — один короткий пункт. Разделы: «Кто», «Стиль», «Правила», «Поправки».",
     "inputSchema": {"type": "object", "properties": {"section": {"type": "string"}, "text": {"type": "string"}}, "required": ["section", "text"]}},
    {"name": "profile_write", "app": "agent", "handler": profile_write, "level": "read",
     "description": "Переписать профиль целиком (Markdown) — когда он разросся: объединить похожие пункты, убрать устаревшее. Сначала profile_read.",
     "inputSchema": {"type": "object", "properties": {"markdown": {"type": "string"}}, "required": ["markdown"]}},
    {"name": "memory_add", "app": "agent", "handler": memory_add, "level": "read",
     "description": "Запомнить факт надолго: решение, договорённость, где что лежит, контакт. Коротко и самодостаточно, с метками. "
                    "shared: true — в общую память компании (увидят агенты всех сотрудников): только то, что полезно всем и не личное.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}},
                                                     "shared": {"type": "boolean"}}, "required": ["text"]}},
    {"name": "memory_search", "app": "agent", "handler": memory_search, "level": "read",
     "description": "Найти в памяти по словам или метке — в личной и общей памяти компании. Ищите перед ответом, если вопрос может опираться на прошлое.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "tag": {"type": "string"}, "limit": {"type": "integer"},
                                                     "scope": {"type": "string", "enum": ["all", "mine", "company"]}}}},
    {"name": "request_permission", "app": "agent", "handler": request_permission, "level": "read",
     "description": "Попросить у человека разрешение на действие, которое его режим без согласия не пускает (сервер ответил «Нужно разрешение»). "
                    "summary — что именно и с чем сделаете, одной фразой. После вызова закончите ответ: решение придёт следующим сообщением с approval_id.",
     "inputSchema": {"type": "object", "properties": {"tool": {"type": "string"}, "summary": {"type": "string"}}, "required": ["tool", "summary"]}},
    {"name": "ask_user", "app": "agent", "handler": ask_user, "level": "read",
     "description": "Спросить человека с кнопками под вашим ответом: confirm — да/нет, choice — один вариант, multi — несколько. "
                    "Для подтверждения удаления, выбора из вариантов, уточнения. После вызова закончите ответ — выбор придёт следующим сообщением.",
     "inputSchema": {"type": "object", "properties": {"question": {"type": "string"}, "kind": {"type": "string", "enum": ["confirm", "choice", "multi"]},
                                                     "options": {"type": "array", "items": {"type": "string"}}}, "required": ["options"]}},
    {"name": "integration_list", "app": "integrations", "handler": integration_list, "level": "read",
     "description": "Подключённые API компании, открытые этому человеку (Topvisor, Яндекс Метрика, Вебмастер, Wordstat и свои): что умеют, базовый адрес, подсказка по путям.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "integration_call", "app": "integrations", "handler": integration_call, "level": "read",
     "description": "Вызвать API из integration_list: ключ подставит Шар (вам он не нужен). path — относительный путь метода; query — параметры адреса; "
                    "body — JSON для POST/PUT. Ответ больше max_chars (30 000, до 60 000) обрезается — уточняйте запрос.",
     "inputSchema": {"type": "object", "properties": {"service": {"type": "string"}, "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]},
                                                     "path": {"type": "string"}, "query": {"type": "object"}, "body": {}, "max_chars": {"type": "integer"}},
                     "required": ["service", "path"]}},
    {"name": "integration_save", "app": "integrations", "handler": integration_save, "level": "create",
     "description": "Только администратор: подключить или поменять API компании, когда человек прислал ключи. Готовый сервис (topvisor, yandex_metrica, "
                    "yandex_webmaster, yandex_wordstat) — fields {ключ: значение}; своё API — service (латиница), label, base_url (https), auth_type "
                    "(bearer|oauth|header|basic|query), auth_name, secret, notes (что умеет, пути). access — кому открыть: id людей из people_search или ['*'] — всем. "
                    "После сохранения подключение проверяется. Ключ в ответе не возвращается.",
     "inputSchema": {"type": "object", "properties": {"service": {"type": "string"}, "fields": {"type": "object"}, "label": {"type": "string"},
                                                     "base_url": {"type": "string"}, "auth_type": {"type": "string"}, "auth_name": {"type": "string"},
                                                     "secret": {"type": "string"}, "notes": {"type": "string"}, "access": {"type": "array", "items": {"type": "string"}}},
                     "required": ["service"]}},
    {"name": "integration_delete", "app": "integrations", "handler": integration_delete, "level": "create",
     "description": "Только администратор: удалить API компании (своё) или стереть ключи готового сервиса. Нужен confirm: true.",
     "inputSchema": {"type": "object", "properties": {"service": {"type": "string"}, "confirm": {"type": "boolean"}}, "required": ["service", "confirm"]}},
    {"name": "connect_gemini", "app": "agent", "handler": connect_gemini, "level": "read",
     "description": "Человек прислал ключ Google (AI Studio / Google Cloud) — подключить его Gemini в «Ядре»: ключ проверяется у Google и хранится зашифрованным.",
     "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}},
    {"name": "agent_disconnect", "app": "agent", "handler": agent_disconnect, "level": "read",
     "description": "Отключить агента человека (gemini — стереть ключ; claude, codex — выйти из подписки на ноде). Нужен confirm: true.",
     "inputSchema": {"type": "object", "properties": {"provider": {"type": "string", "enum": ["gemini", "claude", "codex", "kimi"]}, "confirm": {"type": "boolean"}},
                     "required": ["provider", "confirm"]}},
    {"name": "open_in_shar", "app": "agent", "handler": open_in_shar, "level": "read",
     "description": "Открыть человеку раздел или материал Шара на его экране: документ, таблицу, задачу, календарь, папку файлов (url из ответов "
                    "инструментов). new_window — отдельным окном. Чаты открыть нельзя.",
     "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}, "new_window": {"type": "boolean"}}, "required": ["url"]}},
    {"name": "mcp_list", "app": "agent", "handler": mcp_list, "level": "read",
     "description": "Личные MCP-серверы человека, которые подключаются к вашим запускам (кроме MCP Шара).",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "mcp_install", "app": "agent", "handler": mcp_install, "level": "read",
     "description": "Поставить человеку MCP-сервер, когда он просит или прислал данные: kind=http — url (https) и headers (например {\"Authorization\": \"Bearer …\"}); "
                    "kind=npm — package (npm-пакет MCP, запустится через npx на ноде), args, env (ключи и токены). Секреты хранятся зашифрованными. "
                    "Инструменты нового MCP появятся со следующего сообщения. note — что умеет (для человека).",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "короткое имя латиницей: github, notion"},
                                                     "kind": {"type": "string", "enum": ["http", "npm"]}, "url": {"type": "string"}, "package": {"type": "string"},
                                                     "args": {"type": "array", "items": {"type": "string"}}, "headers": {"type": "object"}, "env": {"type": "object"},
                                                     "note": {"type": "string"}, "enabled": {"type": "boolean"}}, "required": ["name"]}},
    {"name": "mcp_remove", "app": "agent", "handler": mcp_remove, "level": "read",
     "description": "Удалить MCP-сервер человека. Нужен confirm: true.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "confirm": {"type": "boolean"}}, "required": ["name", "confirm"]}},
    {"name": "image_generate", "app": "files", "handler": image_generate, "level": "create",
     "description": "Нарисовать картинку по описанию или поправить готовую (source_url — вложение человека или адрес картинки). "
                    "Рисует Gemini по ключу человека — Claude и GPT тоже могут звать. Картинка сама появится в чате под ответом и "
                    "в «Файлах → Агенты». prompt — подробно: что, стиль, свет, текст на картинке; aspect — 1:1, 16:9, 9:16, 4:3, 3:4.",
     "inputSchema": {"type": "object", "properties": {"prompt": {"type": "string"}, "aspect": {"type": "string"},
                                                     "source_url": {"type": "string"}, "name": {"type": "string", "description": "имя файла"}},
                     "required": ["prompt"]}},
    {"name": "tours_overview", "app": "tours", "handler": tours_overview, "level": "read",
     "description": "Каталог туров «Вокруг света» с сайта: сколько туров, свои/партнёрские, по сегментам, тематики (коллекции) и праздники для фильтров. Начните с него, если не знаете ассортимент.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "tours_search", "app": "tours", "handler": tours_search, "level": "read",
     "description": "Поиск туров по каталогу сайта: текст (название, маршрут, места, гид, тематика) и фильтры — направление, сегмент, свой (own=true — «Сделано в «Вокруг света»», false — партнёрский), длительность в днях, даты выездов, цена, тематика, праздник, только со свободными местами. "
                    "Ответ — компактные строки с ближайшими выездами; полностью — tour_get. Цены и места — на момент снимка каталога.",
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string"}, "direction": {"type": "string", "description": "регион или место: «Карелия», «Суздаль», «Беларусь»"},
         "segment": {"type": "string", "enum": ["one_day", "multi_day", "abroad"], "description": "one_day — однодневные, multi_day — многодневные по России, abroad — ближнее зарубежье"}, "own": {"type": "boolean"}, "days_min": {"type": "integer"}, "days_max": {"type": "integer"},
         "date_from": {"type": "string", "description": "ГГГГ-ММ-ДД"}, "date_to": {"type": "string"}, "price_max": {"type": "number"},
         "topic": {"type": "string", "description": "тематика из tours_overview: «Гастрономические», «Старинные усадьбы»"},
         "holiday": {"type": "string", "description": "праздник из tours_overview: «майские», «новогодние»"},
         "free_only": {"type": "boolean"}, "limit": {"type": "integer", "maximum": 50}, "offset": {"type": "integer"}}}},
    {"name": "tour_get", "app": "tours", "handler": tour_get, "level": "read",
     "description": "Карточка тура по номеру (как в vs-travel.ru/tour?id=…): маршрут, места, тематики, гид, свой или партнёрский, все выезды с ценой и свободными местами, другие туры того же направления. Программа по дням — на странице тура (url).",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]}},
    {"name": "tours_directions", "app": "tours", "handler": tours_directions, "level": "read",
     "description": "Направления каталога: сколько туров (своих и партнёрских), выездов впереди, ближайший выезд. Фильтр — сегмент и часть названия.",
     "inputSchema": {"type": "object", "properties": {"segment": {"type": "string", "enum": ["one_day", "multi_day", "abroad"], "description": "one_day — однодневные, multi_day — многодневные по России, abroad — ближнее зарубежье"}, "query": {"type": "string"}}}},
    {"name": "skill_list", "app": "agent", "handler": skill_list, "level": "read",
     "description": "Навыки: ваши для этого человека и общие для компании — имя, когда применять, сколько раз применяли.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "skill_read", "app": "agent", "handler": skill_read, "level": "read",
     "description": "Прочитать навык перед тем, как делать задачу, под которую он подходит.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    {"name": "skill_write", "app": "agent", "handler": skill_write, "level": "read",
     "description": "Создать или обновить навык — когда задача повторяется или человек объяснил, как её делать. name — латиницей через дефис; "
                    "description — когда применять (по нему вы потом выбираете навык); body — Markdown: шаги, правила, примеры, частые ошибки.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "description": {"type": "string"}, "body": {"type": "string"},
                                                     "shared": {"type": "boolean", "description": "общий навык компании (полезен всем, не про одного человека)"}},
                     "required": ["name", "description", "body"]}},
]
