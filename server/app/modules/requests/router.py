"""Заявки: временный групповой чат с отделом, который решает вопрос.

Перенос из Next (frontend/src/app/api/requests, request-departments). Реестр заявок и
список отделов-обработчиков — в app_kv (раньше data/requests.json, который два
одновременных запроса перезаписывали друг у друга).

  * создатель — вошедший (раньше creatorId приходил из тела запроса);
  * закрыть/возобновить заявку может её создатель или админ;
  * список заявок — только свои (админ видит все)."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, List

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core import kv
from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.security import Identity, current_identity, require_admin
from app.modules.admin import audit
from app.modules.chats.access import participant_ids, require_member
from app.modules.chats.cache import _invalidate_chat_cache
from app.modules.chats.chats import create_chat
from app.modules.chats.messages import post_system_message
from app.modules.chats.schemas import ChatCreate

router = APIRouter()
log = logging.getLogger(__name__)

KEY = "requests"
DEFAULT: Dict[str, Any] = {"counter": 0, "requests": [], "requestDepartmentIds": []}


def _load() -> Dict[str, Any]:
    data = kv.get(KEY, DEFAULT) or {}
    return {
        "counter": int(data.get("counter") or 0),
        "requests": data.get("requests") if isinstance(data.get("requests"), list) else [],
        "requestDepartmentIds": [str(x) for x in (data.get("requestDepartmentIds") or [])],
    }


def _norm(s: Any) -> str:
    return str(s or "").strip().lower()


@router.get("/api/request-departments")
def get_request_departments(me: Identity = Depends(current_identity)):
    return {"departmentIds": _load()["requestDepartmentIds"]}


@router.put("/api/request-departments")
def set_request_departments(body: Dict[str, Any] = Body(...), me: Identity = Depends(require_admin)):
    ids = list(dict.fromkeys(str(x) for x in (body.get("departmentIds") or []) if x))

    def apply(state: Dict[str, Any]) -> Dict[str, Any]:
        state = {**DEFAULT, **(state or {})}
        state["requestDepartmentIds"] = ids
        return state

    kv.update(KEY, DEFAULT, apply)
    audit.record(me, "requests.departments_set", None, departmentIds=ids)
    return {"departmentIds": ids}


@router.get("/api/requests")
def list_requests(me: Identity = Depends(current_identity)):
    records = _load()["requests"]
    if not me.is_admin:
        records = [r for r in records if me.user_id in {str(p) for p in r.get("participantIds") or []} or str(r.get("creatorId")) == me.user_id]
    return {"requests": sorted(records, key=lambda r: r.get("number", 0), reverse=True)}


@router.get("/api/requests/{request_id}")
def get_request(request_id: str, me: Identity = Depends(current_identity)):
    require_member(request_id, me, allow_missing_own=False)
    record = next((r for r in _load()["requests"] if str(r.get("id")) == request_id), None)
    if not record:
        raise HTTPException(status_code=404, detail="Not found")
    return {"request": record}


def _department_members(department_id: str) -> tuple[str, List[str]]:
    departments = db.get_departments() or []
    dept = next((d for d in departments if str(d.get("id")) == department_id), None)
    if not dept:
        raise HTTPException(status_code=404, detail="Department not found")
    # Отдел вместе с подразделами: сотрудник подраздела — сотрудник отдела.
    target_ids = {department_id} | {str(d["id"]) for d in departments if d.get("parent_id") and str(d["parent_id"]) == department_id}
    target_names = {_norm(d.get("name")) for d in departments if str(d.get("id")) in target_ids}

    def belongs(u: dict) -> bool:
        ids = [str(x) for x in (u.get("department_ids") or [])]
        if any(i in target_ids for i in ids):
            return True
        legacy = str(u.get("department") or "")
        return legacy in target_ids or _norm(legacy) in target_names

    members = [str(u["id"]) for u in db.get_users() if belongs(u) and not u.get("is_disabled")]
    return str(dept.get("name") or ""), members


@router.post("/api/requests")
def create_request(body: Dict[str, Any] = Body(...), me: Identity = Depends(current_identity)):
    department_id = str(body.get("departmentId") or "").strip()
    if not department_id:
        raise HTTPException(status_code=400, detail="departmentId is required")
    allowed = _load()["requestDepartmentIds"]
    if allowed and department_id not in allowed:
        raise HTTPException(status_code=400, detail="Department is not configured for requests")

    dept_name, members = _department_members(department_id)
    participants = list(dict.fromkeys([me.user_id, *members]))

    now = datetime.now()
    holder: Dict[str, int] = {}

    def allocate(state: Dict[str, Any]) -> Dict[str, Any]:
        state = {**DEFAULT, **(state or {})}
        state["counter"] = int(state.get("counter") or 0) + 1
        holder["n"] = state["counter"]
        return state

    kv.update(KEY, DEFAULT, allocate)  # номер выдаётся атомарно — двух одинаковых не будет
    number = holder["n"]
    title = f"Заявка №{number} от {now:%d.%m.%Y}"

    chat = create_chat(ChatCreate(participantIds=participants, title=title, isGroup=True, isRequest=True), me)
    chat_id = str(chat.get("id") or "")
    if not chat_id:
        raise HTTPException(status_code=502, detail="Chat was not created")

    record = {
        "id": chat_id, "number": number, "departmentId": department_id, "departmentName": dept_name,
        "creatorId": me.user_id, "participantIds": participants, "createdAt": now.isoformat(), "resolved": False,
    }

    def add(state: Dict[str, Any]) -> Dict[str, Any]:
        state = {**DEFAULT, **(state or {})}
        state["requests"] = [record, *state["requests"]]
        return state

    kv.update(KEY, DEFAULT, add)
    try:
        post_system_message(chat_id, {"content": f"{title} создана. Открыл заявку: {me.display_name} ({dept_name}).", "systemEvent": "request_created"})
    except Exception:
        log.exception("request creation notice failed")
    return {"request": record, "chat": chat}


@router.put("/api/requests/{request_id}")
def resolve_request(request_id: str, body: Dict[str, Any] = Body(default={}), me: Identity = Depends(current_identity)):
    """resolved=true — закрыть (заявка уходит в архив у всех участников), false — вернуть."""
    resolved = body.get("resolved") is not False
    chat = require_member(request_id, me, allow_missing_own=False)
    if not str(chat.get("title") or "").startswith("Заявка №"):
        raise HTTPException(status_code=400, detail="Not a request chat")
    creator = str(chat.get("creator_id") or chat.get("creatorId") or "")
    if creator and creator != me.user_id and not me.is_admin:
        raise HTTPException(status_code=403, detail="Only the creator can change this request")

    participants = participant_ids(chat)
    archived = dict(chat.get("archived_by_user") or {})
    for pid in participants:
        archived[pid] = resolved
    db.update_chat(request_id, {"discussion_status": "request_resolved" if resolved else "", "archived_by_user": archived})
    _invalidate_chat_cache(request_id)

    def mark(state: Dict[str, Any]) -> Dict[str, Any]:
        state = {**DEFAULT, **(state or {})}
        for r in state["requests"]:
            if str(r.get("id")) == request_id:
                r.update({"resolved": resolved, "resolvedAt": datetime.now().isoformat() if resolved else None, "resolvedBy": me.user_id})
        return state

    kv.update(KEY, DEFAULT, mark)
    post_system_message(request_id, {"content": "Заявка закрыта и добавлена в архив." if resolved else "Заявка возобновлена.",
                                     "systemEvent": "request_closed" if resolved else "request_reopened"})
    return {"ok": True, "resolved": resolved, "chat": snake_to_camel(db.get_chat(request_id) or {})}
