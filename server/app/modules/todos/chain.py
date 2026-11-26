"""Цепочки задач: уведомления по ходу этапов.

Цепочка хранится в самих задачах — metadata.chain = {id, order, name, owner} (клиент: src/features/tasks/api.ts).
Этап ведёт ответственный — отдельная роль только для цепочек (owner), по умолчанию заказчик задачи; исполнитель
задачи — сам по себе. Здесь — кому
и что сказать, когда этап закрыли, вернули в работу или задачу включили в цепочку:

  этап закрыт        → ответственному следующего незакрытого этапа: «Ваша очередь»;
  закрыт последний   → заказчикам этапов: «Цепочка завершена»;
  этап вернули       → его ответственному: «Этап вернули в работу»;
  задачу включили    → ответственному этапа (если это не тот, кто включил): «Вы ответственный за этап».
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from app.core.db import db

log = logging.getLogger(__name__)

Send = Callable[[str, str, str, str], None]  # (кому, вид, задача, текст)


def chain_of(task: Optional[dict]) -> Optional[dict]:
    meta = (task or {}).get("metadata")
    chain = meta.get("chain") if isinstance(meta, dict) else None
    return chain if isinstance(chain, dict) and chain.get("id") else None


def _field(t: Optional[dict], *keys: str) -> Any:
    for k in keys:
        if t and t.get(k) not in (None, ""):
            return t.get(k)
    return None


def _truthy(v: Any) -> bool:
    return v is True or v == 1 or (isinstance(v, str) and v.lower() in ("1", "true", "yes"))


def is_done(t: Optional[dict]) -> bool:
    return bool(t) and (_truthy(_field(t, "is_completed", "isCompleted", "completed")) or str(_field(t, "status") or "") == "completed")


def customer_of(t: Optional[dict]) -> str:
    return str(_field(t, "assigned_by_id", "assignedById", "author_id", "authorId") or "")


def owner_of(t: Optional[dict]) -> str:
    """Ответственный за этап цепочки: назначенный (metadata.chain.owner), по умолчанию — заказчик задачи."""
    chain = chain_of(t) or {}
    return str(chain.get("owner") or "") or customer_of(t)


def owners_of(t: Optional[dict]) -> set[str]:
    owner = owner_of(t)
    return {owner} if owner else set()


def stages(chain_id: str) -> list[dict]:
    """Этапы цепочки по порядку (без архивных)."""
    try:
        rows = db.conn.fetch_all("SELECT * FROM tasks WHERE metadata->'chain'->>'id' = %s", (chain_id,)) or []
    except Exception as exc:
        log.debug("chain stages failed: %s", exc)
        return []
    out = [dict(r) for r in rows if not _truthy(r.get("archived"))]
    out.sort(key=lambda t: (float((chain_of(t) or {}).get("order") or 0), str(t.get("created_at") or "")))
    return out


def _title(t: Optional[dict]) -> str:
    return str(_field(t, "title") or "Задача").strip() or "Задача"


def notify(before: Optional[dict], after: Optional[dict], actor: str, actor_name: str, send: Send) -> None:
    """Уведомления цепочки по правке задачи (before → after). Тому, кто правил, — ничего."""
    chain = chain_of(after)
    if not after or not chain:
        return
    task_id = str(_field(after, "id") or "")
    name = str(chain.get("name") or "").strip()
    named = f" цепочки «{name}»" if name else " цепочки"
    was_done, now_done = is_done(before), is_done(after)
    if before is not None and not was_done and now_done:
        all_stages = stages(str(chain["id"]))
        order = float(chain.get("order") or 0)
        rest = [t for t in all_stages if not is_done(t) and str(t.get("id")) != task_id]
        upcoming = [t for t in rest if float((chain_of(t) or {}).get("order") or 0) > order] or rest
        if upcoming:
            nxt = upcoming[0]
            step = next((i + 1 for i, t in enumerate(all_stages) if str(t.get("id")) == str(nxt.get("id"))), 0)
            text = (f"🔗 Ваша очередь: «{_title(nxt)}» — этап {step} из {len(all_stages)}{named}.\n"
                    f"{actor_name} закрыл(а) этап «{_title(after)}».")
            for uid in owners_of(nxt) - {actor, ""}:
                send(uid, "task_chain_turn", str(nxt.get("id")), text)
        else:
            text = f"✅ {('Цепочка «' + name + '»') if name else 'Цепочка задач'} завершена: {actor_name} закрыл(а) последний этап «{_title(after)}»."
            for uid in {customer_of(t) for t in all_stages} - {actor, ""}:
                send(uid, "task_chain_done", task_id, text)
        return
    if before is not None and was_done and not now_done:
        text = f"↩️ {actor_name} вернул(а) в работу этап «{_title(after)}»{named}."
        for uid in owners_of(after) - {actor, ""}:
            send(uid, "task_chain_reopened", task_id, text)
        return
    # Задачу включили в цепочку или сменили ответственного за этап — новому ответственному.
    joined = chain_of(before) is None or str((chain_of(before) or {}).get("id")) != str(chain["id"])
    if joined or owner_of(before) != owner_of(after):
        fresh = owners_of(after) - {actor, ""}
        if fresh:
            all_stages = stages(str(chain["id"]))
            step = next((i + 1 for i, t in enumerate(all_stages) if str(t.get("id")) == task_id), 0)
            where = f" — этап {step} из {len(all_stages)}" if step else ""
            text = f"🔗 {actor_name}: вы ответственный за «{_title(after)}»{where}{named}."
            for uid in fresh:
                send(uid, "task_chain_owner", task_id, text)
