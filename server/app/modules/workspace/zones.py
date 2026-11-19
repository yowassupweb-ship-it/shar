"""Зоны агентов в документе: агент «занимает» кусок текста, пока правит его, — люди видят подсвеченную зону с подписью
и не могут печатать внутри неё (это делает редактор: editors/docOverlay.ts), а снаружи работают как обычно.

Зона — цитата из документа (по ней редактор находит место, где бы текст ни сдвинулся) и срок. Срок короткий и продлевается
каждым вызовом агента: агент упал или забыл отпустить — зона исчезает сама. Хранится в Redis (как присутствие), без Redis —
в памяти процесса. Изменение сразу уходит тем, кто открыл документ (событие workspace_zones).

  claim(item_id, user_id, label, quote, ttl)  → зона {id, label, quote, until, userId}
  release(item_id, zone_id | None)            — отпустить одну или все зоны этого человека (его агентов)
  active(item_id)                              — живые зоны
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Optional

log = logging.getLogger("shar.workspace.zones")

DEFAULT_TTL = 90
MAX_TTL = 600
MAX_ZONES = 8
MAX_QUOTE = 600

_local: dict[str, dict[str, dict[str, Any]]] = {}


def _redis():
    from app.modules.workspace.store import presence

    return presence._redis  # noqa: SLF001 — тот же клиент, что у присутствия


def _key(item_id: str) -> str:
    return f"shar:wsz:{item_id}"


def _load(item_id: str) -> dict[str, dict[str, Any]]:
    r = _redis()
    if r is not None:
        try:
            return {zid: json.loads(raw) for zid, raw in (r.hgetall(_key(item_id)) or {}).items()}
        except Exception as exc:  # noqa: BLE001
            log.debug("zones: redis unavailable (%s)", exc)
    return dict(_local.get(item_id, {}))


def _save(item_id: str, zones: dict[str, dict[str, Any]]) -> None:
    r = _redis()
    if r is not None:
        try:
            pipe = r.pipeline()
            pipe.delete(_key(item_id))
            if zones:
                pipe.hset(_key(item_id), mapping={zid: json.dumps(z, ensure_ascii=False) for zid, z in zones.items()})
                pipe.expire(_key(item_id), MAX_TTL * 2)
            pipe.execute()
            return
        except Exception as exc:  # noqa: BLE001
            log.debug("zones: redis unavailable (%s)", exc)
    _local[item_id] = dict(zones)


def active(item_id: str) -> list[dict[str, Any]]:
    now = time.time()
    zones = _load(item_id)
    live = {zid: z for zid, z in zones.items() if float(z.get("until") or 0) > now}
    if len(live) != len(zones):
        _save(item_id, live)
    return sorted(live.values(), key=lambda z: z.get("at") or 0)


def _announce(item_id: str) -> None:
    from app.modules.workspace.store import push_to_viewers

    push_to_viewers(item_id, {"type": "workspace_zones", "itemId": item_id, "zones": public(active(item_id))})


def public(zones: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"id": z["id"], "label": z["label"], "quote": z["quote"], "until": z["until"]} for z in zones]


def claim(item_id: str, user_id: str, label: str, quote: str, *, ttl: int = DEFAULT_TTL, zone_id: Optional[str] = None) -> dict[str, Any]:
    """Занять (или продлить, если такая цитата у этого человека уже занята) зону."""
    quote = " ".join(str(quote or "").split())[:MAX_QUOTE]
    if not quote:
        raise ValueError("Пустая зона: нужна цитата из документа")
    now = time.time()
    zones = {zid: z for zid, z in _load(item_id).items() if float(z.get("until") or 0) > now}
    same = next((z for z in zones.values() if z["userId"] == user_id and (z["id"] == zone_id or z["quote"] == quote)), None)
    zone = same or {"id": uuid.uuid4().hex[:12], "userId": user_id, "at": now}
    zone.update(label=str(label or "Агент")[:60], quote=quote, until=now + max(5, min(int(ttl or DEFAULT_TTL), MAX_TTL)))
    zones[zone["id"]] = zone
    if len(zones) > MAX_ZONES:  # старые уступают место
        for z in sorted(zones.values(), key=lambda x: x.get("at") or 0)[: len(zones) - MAX_ZONES]:
            zones.pop(z["id"], None)
    _save(item_id, zones)
    _announce(item_id)
    return zone


def release(item_id: str, user_id: str, zone_id: Optional[str] = None) -> int:
    zones = _load(item_id)
    drop = [zid for zid, z in zones.items() if z.get("userId") == user_id and (zone_id is None or zid == zone_id)]
    for zid in drop:
        zones.pop(zid, None)
    if drop:
        _save(item_id, zones)
        _announce(item_id)
    return len(drop)
