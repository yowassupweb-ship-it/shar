"""Заявки с сайтов (corp.vs-travel.ru и school.vs-travel.ru): приложение «Заявки с сайта».

Сайт сохраняет заявку у себя, отправляет письмо менеджерам и передаёт её сюда служебным ключом
интеграций (POST /api/integrations/leads, заголовок X-Shar-Api-Key). Заявка ложится в site_leads
и карточкой — в чат, выбранный для этого сайта в настройках приложения. Повторная доставка той же
заявки (сайт повторяет отправку после сбоя) ничего не дублирует: id заявки — id строки, а id
карточки выводится из него.

Доступ к приложению — как у остальных выдаваемых инструментов: админ или тот, кому выдан
`site-leads` (users.enabled_tools). Взять заявку или закрыть её из карточки может и участник чата,
куда она пришла, — для этого доступ к приложению не нужен."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from app.core import kv, schema
from app.core.db import db
from app.core.security import Identity, current_identity, require_admin
from app.modules.chats.access import participant_ids
from app.modules.chats.cache import _get_chat_cached
from app.modules.integrations.cards import post_card, update_card
from app.modules.integrations.router import _require_integration_key

router = APIRouter()
log = logging.getLogger("shar.leads")

TOOL = "site-leads"
SOURCE = "leads"
AUTHOR = "Заявки с сайта"
SETTINGS_KEY = "site_leads_settings"
SITES = {"corp": "Корпоративный сайт", "school": "Школьный сайт"}
SITE_URLS = {"corp": "https://corp.vs-travel.ru", "school": "https://school.vs-travel.ru"}
KINDS = {"callback": "Заявка", "question": "Вопрос", "custom": "Подбор маршрута", "review": "Отзыв"}
STATUSES = ("new", "work", "done")

schema.register("site_leads", """
CREATE TABLE IF NOT EXISTS site_leads (
    id TEXT PRIMARY KEY,
    site TEXT NOT NULL,
    kind TEXT NOT NULL,
    data JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    assignee_id TEXT,
    chat_id TEXT,
    message_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_leads_created ON site_leads (created_at DESC);
""")

# Поля формы → подпись в карточке, в порядке показа (как в письме менеджерам).
FIELDS = [
    ("name", "Имя"), ("phone", "Телефон"), ("email", "E-mail"), ("where", "Куда"), ("date", "Желаемая дата"),
    ("count", "Размер группы"), ("question", "Вопрос"), ("contact", "Как связаться"), ("organization", "Организация"),
    ("tour", "Тур (из отзыва)"), ("text", "Отзыв"), ("comment", "Комментарий"),
]
LIMITS = {"name": 120, "phone": 40, "email": 160, "comment": 2000, "date": 40, "count": 40, "where": 160,
          "question": 3000, "contact": 160, "organization": 160, "tour": 300, "text": 5000}


# ─── Доступ ──────────────────────────────────────────────────────────────────

def _has_tool(me: Identity) -> bool:
    if me.is_admin:
        return True
    user = db.get_user(me.user_id) or {}
    tools = user.get("enabled_tools") or user.get("enabledTools") or []
    return TOOL in tools


def require_tool(me: Identity = Depends(current_identity)) -> Identity:
    if not _has_tool(me):
        raise HTTPException(status_code=403, detail="Нет доступа к заявкам с сайта")
    return me


# ─── Настройки: куда какой сайт ─────────────────────────────────────────────

def _settings() -> Dict[str, Any]:
    data = kv.get(SETTINGS_KEY, {}) or {}
    routes = data.get("routes") if isinstance(data.get("routes"), dict) else {}
    return {"routes": {site: (str(routes.get(site)) if routes.get(site) else None) for site in SITES}}


@router.get("/api/leads/settings")
def get_settings(me: Identity = Depends(require_tool)):
    s = _settings()
    chats = {}
    for site, chat_id in s["routes"].items():
        chat = _get_chat_cached(chat_id) if chat_id else None
        chats[site] = {"id": chat_id, "title": (chat or {}).get("title") or (chat or {}).get("name")} if chat_id else None
    return {"routes": s["routes"], "chats": chats, "sites": SITES}


@router.put("/api/leads/settings")
def put_settings(body: Dict[str, Any] = Body(...), me: Identity = Depends(require_admin)):
    """Админ выбирает чат для каждого сайта. Чат должен существовать; пусто — заявки этого сайта
    в чат не идут (только в приложение)."""
    routes_in = body.get("routes") if isinstance(body.get("routes"), dict) else {}
    routes: Dict[str, Optional[str]] = {}
    for site in SITES:
        chat_id = str(routes_in.get(site) or "").strip() or None
        if chat_id and not _get_chat_cached(chat_id):
            raise HTTPException(status_code=400, detail=f"Чат для «{SITES[site]}» не найден")
        routes[site] = chat_id
    kv.update(SETTINGS_KEY, {}, lambda state: {**(state or {}), "routes": routes})
    return get_settings(me)


# ─── Приём с сайта ───────────────────────────────────────────────────────────

def _clean(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Сайт уже всё проверил, но служебный ключ — не повод доверять размерам и типам."""
    s = lambda v, n: v.strip()[:n] if isinstance(v, str) else ""  # noqa: E731
    lead_id = s(payload.get("id"), 40)
    if not lead_id:
        raise HTTPException(status_code=400, detail="id is required")
    kind = s(payload.get("kind"), 20)
    site = s(payload.get("site"), 20) or "corp"
    if kind not in KINDS or site not in SITES:
        raise HTTPException(status_code=400, detail="unknown kind or site")
    raw = payload.get("fields") if isinstance(payload.get("fields"), dict) else {}
    fields = {k: s(raw.get(k), n) for k, n in LIMITS.items() if s(raw.get(k), n)}
    tour_raw = payload.get("tour") if isinstance(payload.get("tour"), dict) else None
    tour = {"id": s(tour_raw.get("id"), 20), "title": s(tour_raw.get("title"), 300)} if tour_raw and s(tour_raw.get("id"), 20) else None
    return {
        "id": lead_id, "kind": kind, "site": site, "fields": fields, "tour": tour,
        "tours": s(payload.get("tours"), 3000) or None, "page": s(payload.get("page"), 300),
        "pageName": s(payload.get("pageName"), 200) or None, "source": s(payload.get("source"), 60),
        "createdAt": s(payload.get("createdAt"), 40) or datetime.now(timezone.utc).isoformat(),
        "consentAt": s(payload.get("consentAt"), 40) or None,
    }


def _card_id(lead_id: str) -> str:
    # Свой id карточки из id заявки: повторная доставка вставляет ту же строку — и ничего не делает.
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"shar:site-lead:{lead_id}"))


def _who(lead: Dict[str, Any]) -> str:
    f = lead["fields"]
    return f.get("name") or f.get("contact") or f.get("phone") or f.get("email") or ""


def _summary(lead: Dict[str, Any]) -> str:
    """Текст карточки для превью в списке чатов, поиска и пуша («с сайта» — уже в имени автора)."""
    head = KINDS[lead["kind"]]
    who = _who(lead)
    bits = [b for b in (who, lead["fields"].get("phone") if who != lead["fields"].get("phone") else None, lead["tour"]["title"] if lead.get("tour") else None) if b]
    return f"{head}: {', '.join(bits)}" if bits else head


def _card(lead: Dict[str, Any], status: str = "new", assignee: Optional[dict] = None) -> Dict[str, Any]:
    base = SITE_URLS[lead["site"]]
    f = lead["fields"]
    title = _who(lead) or KINDS[lead["kind"]]
    # Телефон и почта — отдельной строкой ссылок; поле, ставшее заголовком, не повторяем.
    rows = [[label, f[key]] for key, label in FIELDS if f.get(key) and key not in ("phone", "email") and f[key] != title]
    if lead.get("tours"):
        rows.append(["Туры из избранного", lead["tours"]])
    links = []
    if lead.get("tour"):
        links.append({"label": f"{lead['tour']['title']} (№ {lead['tour']['id']})", "url": f"{base}/tour/{lead['tour']['id']}"})
    if lead.get("page") and lead["page"].startswith("/"):
        links.append({"label": lead.get("pageName") or "Страница заявки", "url": base + lead["page"]})
    return {
        "kind": "lead", "leadId": lead["id"], "type": KINDS[lead["kind"]], "site": SITES[lead["site"]],
        "title": title, "phone": f.get("phone"), "email": f.get("email"),
        "rows": rows, "links": links, "status": status,
        "assigneeId": (assignee or {}).get("id"), "assigneeName": (assignee or {}).get("name"),
    }


@router.post("/api/integrations/leads")
def receive_lead(request: Request, payload: Dict[str, Any] = Body(...)):
    """Заявка с сайта. Ответ 200 и при повторе — сайт по нему понимает, что заявка дошла."""
    _require_integration_key(request)
    lead = _clean(payload)
    created = db.conn.fetch_one(
        "INSERT INTO site_leads (id, site, kind, data, created_at) VALUES (%s, %s, %s, %s::jsonb, %s) "
        "ON CONFLICT (id) DO NOTHING RETURNING id",
        (lead["id"], lead["site"], lead["kind"], json.dumps(lead, ensure_ascii=False), lead["createdAt"]),
    )
    row = db.conn.fetch_one("SELECT chat_id, message_id FROM site_leads WHERE id = %s", (lead["id"],)) or {}
    if not created and row.get("message_id"):
        return {"ok": True, "id": lead["id"], "duplicate": True}
    chat_id = _settings()["routes"].get(lead["site"])
    message_id = None
    if chat_id and _get_chat_cached(chat_id):
        try:
            msg = post_card(chat_id, source=SOURCE, author_name=AUTHOR, content=_summary(lead), card=_card(lead), message_id=_card_id(lead["id"]))
            message_id = msg["id"]
        except HTTPException as e:
            log.warning("lead %s: card not posted: %s", lead["id"], e.detail)
        db.conn.execute_query("UPDATE site_leads SET chat_id = %s, message_id = %s WHERE id = %s", (chat_id, message_id, lead["id"]))
    elif chat_id:
        log.warning("lead %s: chat %s for site %s is gone", lead["id"], chat_id, lead["site"])
    return {"ok": True, "id": lead["id"], "duplicate": not created, "chat": bool(message_id)}


# ─── Приложение ──────────────────────────────────────────────────────────────

def _view(row: dict, users: Dict[str, dict]) -> dict:
    data = row.get("data") or {}
    assignee = users.get(str(row.get("assignee_id") or ""))
    return {
        **data,
        "status": row.get("status") or "new",
        "assigneeId": row.get("assignee_id"), "assigneeName": (assignee or {}).get("name") if assignee else None,
        "chatId": row.get("chat_id"), "messageId": row.get("message_id"),
        "createdAt": (row["created_at"].isoformat() if hasattr(row.get("created_at"), "isoformat") else data.get("createdAt")),
        "updatedAt": row["updated_at"].isoformat() if hasattr(row.get("updated_at"), "isoformat") else None,
        "siteLabel": SITES.get(row.get("site"), row.get("site")), "kindLabel": KINDS.get(row.get("kind"), row.get("kind")),
    }


def _users_by_id() -> Dict[str, dict]:
    return {str(u["id"]): u for u in (db.get_users(include_disabled=True) or []) if u.get("id")}


@router.get("/api/leads")
def list_leads(status: str = "", site: str = "", q: str = "", limit: int = 300, me: Identity = Depends(require_tool)):
    where, params = [], []
    if status in STATUSES:
        where.append("status = %s")
        params.append(status)
    if site in SITES:
        where.append("site = %s")
        params.append(site)
    if q.strip():
        where.append("data::text ILIKE %s")
        params.append(f"%{q.strip()[:100]}%")
    sql = "SELECT * FROM site_leads" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY created_at DESC LIMIT %s"
    params.append(max(1, min(limit, 1000)))
    rows = db.conn.fetch_all(sql, tuple(params)) or []
    counts = {r["status"]: int(r["n"]) for r in (db.conn.fetch_all("SELECT status, count(*) AS n FROM site_leads GROUP BY status") or [])}
    users = _users_by_id()
    return {"leads": [_view(dict(r), users) for r in rows], "counts": {s: counts.get(s, 0) for s in STATUSES}}


@router.patch("/api/leads/{lead_id}")
def change_lead(lead_id: str, body: Dict[str, Any] = Body(...), me: Identity = Depends(current_identity)):
    """Статус и ответственный. `take: true` — «Беру» (ответственный — я, статус «в работе»)."""
    row = db.conn.fetch_one("SELECT * FROM site_leads WHERE id = %s", (lead_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Lead not found")
    row = dict(row)
    in_chat = False
    if row.get("chat_id"):
        chat = _get_chat_cached(str(row["chat_id"]))
        in_chat = bool(chat) and me.user_id in participant_ids(chat)
    if not in_chat and not _has_tool(me):
        raise HTTPException(status_code=403, detail="Нет доступа к заявке")

    status = row.get("status") or "new"
    assignee_id = row.get("assignee_id")
    if body.get("take"):
        assignee_id, status = me.user_id, "work"
    if "assigneeId" in body:
        assignee_id = str(body.get("assigneeId") or "") or None
    if body.get("status") in STATUSES:
        status = body["status"]
        if status == "new":
            assignee_id = None
    db.conn.execute_query(
        "UPDATE site_leads SET status = %s, assignee_id = %s, updated_at = now(), updated_by = %s WHERE id = %s",
        (status, assignee_id, me.user_id, lead_id),
    )
    assignee = db.get_user(assignee_id) if assignee_id else None
    if row.get("message_id"):
        update_card(str(row["message_id"]), {
            "status": status, "assigneeId": assignee_id,
            "assigneeName": (assignee or {}).get("name") or (assignee or {}).get("username") if assignee else None,
        })
    fresh = db.conn.fetch_one("SELECT * FROM site_leads WHERE id = %s", (lead_id,))
    return {"lead": _view(dict(fresh), _users_by_id())}

