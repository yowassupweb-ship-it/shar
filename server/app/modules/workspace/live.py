"""Совместная правка документов, таблиц и заметок в реальном времени, как в Google Docs.

Каждая правка редактора (мутация Univer) уходит по сокету кадром `ops`. Сервер правок не разбирает — он только
выстраивает их в один общий порядок. У материала есть номер версии `rev`: кадр, присланный от текущей версии,
получает следующий номер, ложится в журнал и сразу раздаётся всем, кто открыл материал (автору — как
подтверждение). Кадр от устаревшей версии отклоняется вместе с недостающими правками: клиент сам переносит свои
правки поверх чужих (операционные преобразования, src/features/workspace/live) и присылает снова. Так десяток
человек печатает в разных местах одновременно, и у всех получается одно и то же — без вопроса «чью версию оставить».

Журнал живёт в Redis (последние LOG_MAX правок). Содержимое в базе сохраняют сами клиенты вместе с номером
версии (meta.live = {epoch, rev}); открывающий получает содержимое из базы и правки журнала после его версии.
`epoch` — поколение журнала: запись мимо живой правки (версия из истории, ссылка без входа, агент по MCP)
начинает новое поколение, и открытые редакторы перечитывают материал.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from typing import Any, Optional

from app.modules.workspace import store

log = logging.getLogger(__name__)

LIVE_KINDS = ("document", "table", "note")
LOG_MAX = 5000
TTL = 3 * 24 * 3600
FRAME_MAX_BYTES = 2_000_000
# Редактор, открытый в окне без внимания (свёрнут, в трее, на втором мониторе), из присутствия выпадает, а правки
# получать должен: он отмечается отдельно раз в 20 с.
SUBSCRIBER_TTL = 60
_ACCESS_TTL = 30.0

# Принять правку, если она от текущей версии: номер +1, запись в журнал. Иначе — текущий номер (клиент отстал),
# признак повтора (эту пачку редактора — cid/bid — уже приняли: ответ на неё потерялся, а клиент прислал снова)
# или признак сброса (журнала нет / другое поколение).
_SUBMIT = """
local epoch = redis.call('HGET', KEYS[1], 'epoch')
if not epoch then return {'reset', ''} end
if epoch ~= ARGV[1] then return {'reset', epoch} end
local rev = tonumber(redis.call('HGET', KEYS[1], 'rev'))
local last = tonumber(redis.call('HGET', KEYS[1], 'b:' .. ARGV[6]) or '0')
if tonumber(ARGV[7]) <= last then return {'dup', tostring(rev)} end
if tonumber(ARGV[2]) ~= rev then return {'behind', tostring(rev)} end
rev = rev + 1
redis.call('HSET', KEYS[1], 'rev', rev, 'b:' .. ARGV[6], ARGV[7])
redis.call('RPUSH', KEYS[2], '{"rev":' .. rev .. ARGV[3])
redis.call('LTRIM', KEYS[2], -tonumber(ARGV[4]), -1)
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return {'ok', tostring(rev)}
"""

# Начать поколение, если его нет (два открывающих одновременно не должны начать два разных).
_INIT = """
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[1], 'epoch', ARGV[1], 'rev', 0, 'base', ARGV[2])
  redis.call('DEL', KEYS[2])
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return redis.call('HMGET', KEYS[1], 'epoch', 'rev', 'base')
"""


def _keys(item_id: str) -> tuple[str, str]:
    return f"shar:wslive:{item_id}", f"shar:wslive:{item_id}:log"


class _Memory:
    """Журнал в памяти процесса — когда Redis недоступен (локальная разработка). Один процесс — один порядок."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.heads: dict[str, dict[str, Any]] = {}
        self.logs: dict[str, list[str]] = {}
        self.subs: dict[str, dict[str, float]] = {}


_mem = _Memory()


def _redis():
    return store.presence._redis


def _head(item_id: str) -> Optional[dict[str, Any]]:
    r = _redis()
    if r is not None:
        try:
            epoch, rev, base = r.hmget(_keys(item_id)[0], "epoch", "rev", "base")
            return {"epoch": epoch, "rev": int(rev), "base": base or ""} if epoch else None
        except Exception as exc:
            log.debug("workspace live: redis unavailable (%s)", exc)
    with _mem.lock:
        head = _mem.heads.get(item_id)
        return dict(head) if head else None


def _init(item_id: str, base: str) -> dict[str, Any]:
    epoch = uuid.uuid4().hex[:16]
    r = _redis()
    if r is not None:
        try:
            got, rev, have_base = r.eval(_INIT, 2, *_keys(item_id), epoch, base, TTL)
            return {"epoch": got, "rev": int(rev), "base": have_base or ""}
        except Exception as exc:
            log.debug("workspace live: redis unavailable (%s)", exc)
    with _mem.lock:
        head = _mem.heads.setdefault(item_id, {"epoch": epoch, "rev": 0, "base": base})
        _mem.logs.setdefault(item_id, [])
        return dict(head)


def _entries(item_id: str, rev: int, since: int) -> Optional[list[dict[str, Any]]]:
    """Правки журнала с номерами since+1..rev. None — часть уже вытеснена из журнала."""
    if since >= rev:
        return []
    count = rev - since
    if count > LOG_MAX:
        return None
    raw: list[str] = []
    r = _redis()
    if r is not None:
        try:
            raw = r.lrange(_keys(item_id)[1], -count, -1)
        except Exception as exc:
            log.debug("workspace live: redis unavailable (%s)", exc)
            raw = []
    else:
        with _mem.lock:
            raw = list(_mem.logs.get(item_id, [])[-count:])
    entries = [json.loads(x) for x in raw]
    entries = [e for e in entries if since < int(e.get("rev", 0)) <= rev]
    if len(entries) != count:
        return None
    return entries


def _base_of(row: dict[str, Any]) -> str:
    return str(row.get("updated_at") or "")


def join(row: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Для открывающего материал: с какой версии его содержимое и какие правки после неё уже сделаны.

    Содержимое в руках — то, что в строке row: сохранённое в этом поколении (meta.live) или исходное поколения
    (его отметка времени совпадает с base). Иначе материал записали мимо живой правки — начинаем новое поколение."""
    if row.get("kind") not in LIVE_KINDS:
        return None
    item_id = str(row["id"])
    head = _head(item_id) or _init(item_id, _base_of(row))
    saved = (row.get("meta") or {}).get("live") or {}
    if saved.get("epoch") == head["epoch"]:
        since = int(saved.get("rev") or 0)
    elif head["base"] == _base_of(row):
        since = 0
    else:
        reset(item_id, notify=True)
        head = _init(item_id, _base_of(row))
        since = 0
    since = min(since, head["rev"])
    ops = _entries(item_id, head["rev"], since)
    if ops is None:
        return {"epoch": head["epoch"], "rev": since, "stale": True, "ops": []}
    return {"epoch": head["epoch"], "rev": since, "ops": ops}


def journal_until(item_id: str, epoch: str, rev: int) -> list[dict[str, Any]]:
    """Все правки журнала этого поколения с номерами до rev включительно (что ещё не вытеснено), по порядку.
    Для починки сохранённой таблицы (table_repair.py)."""
    head = _head(str(item_id))
    if not head or head["epoch"] != epoch or rev <= 0:
        return []
    raw: list[str] = []
    r = _redis()
    if r is not None:
        try:
            raw = r.lrange(_keys(str(item_id))[1], 0, -1)
        except Exception as exc:
            log.debug("workspace live: redis unavailable (%s)", exc)
    else:
        with _mem.lock:
            raw = list(_mem.logs.get(str(item_id), []))
    entries = [json.loads(x) for x in raw]
    return sorted((e for e in entries if 0 < int(e.get("rev", 0)) <= rev), key=lambda e: int(e["rev"]))


def catch_up(item_id: str, epoch: str, since: int) -> dict[str, Any]:
    """Правки после since — для отставшего клиента (переподключился, окно было свёрнуто, потерялся кадр)."""
    head = _head(item_id)
    if not head or head["epoch"] != epoch:
        return {"reset": True}
    ops = _entries(item_id, head["rev"], max(0, since))
    if ops is None:
        return {"reset": True}
    return {"epoch": epoch, "rev": head["rev"], "ops": ops}


def reset(item_id: str, *, notify: bool = True) -> None:
    """Материал записан мимо живой правки: журнал больше не описывает его содержимое. Открытые редакторы перечитают."""
    item_id = str(item_id)
    r = _redis()
    if r is not None:
        try:
            r.delete(*_keys(item_id))
        except Exception as exc:
            log.debug("workspace live: redis unavailable (%s)", exc)
    with _mem.lock:
        _mem.heads.pop(item_id, None)
        _mem.logs.pop(item_id, None)
    if notify:
        _push(item_id, {"type": "workspace_live_reset", "itemId": item_id}, extra=())


def subscribe(item_id: str, user_id: str) -> None:
    """Редактор открыт: правки получать, даже когда окно без внимания."""
    now = time.time()
    r = _redis()
    if r is not None:
        try:
            key = f"shar:wslsub:{item_id}"
            pipe = r.pipeline()
            pipe.zadd(key, {user_id: now})
            pipe.expire(key, SUBSCRIBER_TTL * 2)
            pipe.execute()
            return
        except Exception as exc:
            log.debug("workspace live: redis unavailable (%s)", exc)
    with _mem.lock:
        _mem.subs.setdefault(item_id, {})[user_id] = now


def unsubscribe(item_id: str, user_id: str) -> None:
    r = _redis()
    if r is not None:
        try:
            r.zrem(f"shar:wslsub:{item_id}", user_id)
        except Exception:
            pass
    with _mem.lock:
        _mem.subs.get(item_id, {}).pop(user_id, None)


def _subscribers(item_id: str) -> set[str]:
    now = time.time()
    r = _redis()
    if r is not None:
        try:
            key = f"shar:wslsub:{item_id}"
            r.zremrangebyscore(key, 0, now - SUBSCRIBER_TTL)
            return set(r.zrange(key, 0, -1))
        except Exception as exc:
            log.debug("workspace live: redis unavailable (%s)", exc)
    with _mem.lock:
        live = {u: t for u, t in _mem.subs.get(item_id, {}).items() if t >= now - SUBSCRIBER_TTL}
        _mem.subs[item_id] = live
        return set(live)


def _push(item_id: str, payload: dict[str, Any], *, extra: tuple[str, ...]) -> None:
    try:
        from app.core.realtime import sse_manager

        users = _subscribers(item_id) | {uid for uid, _ in store.presence.viewers(item_id)} | set(extra)
        for uid in users:
            sse_manager.push(uid, payload)
    except Exception as exc:
        log.warning("workspace live: push failed: %s", exc)


# Право на правку проверяется на каждый кадр, но не запросом в базу на каждую букву: ответ помним 30 с.
_access: dict[tuple[str, str], tuple[float, bool]] = {}


def _can_edit(user_id: str, item_id: str) -> bool:
    key = (user_id, item_id)
    hit = _access.get(key)
    if hit and time.monotonic() - hit[0] < _ACCESS_TTL:
        return hit[1]
    try:
        row = store.get_visible(item_id, user_id, content=False)
        ok = row["kind"] in LIVE_KINDS and bool(store.permissions(row, user_id)["canEdit"])
    except store.WorkspaceError:
        ok = False
    if len(_access) > 5000:
        _access.clear()
    _access[key] = (time.monotonic(), ok)
    return ok


def forget_access(item_id: str) -> None:
    """Доступ к материалу поменяли — перепроверить при следующем кадре."""
    for key in [k for k in _access if k[1] == str(item_id)]:
        _access.pop(key, None)


def handle_frame(user_id: str, frame: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Кадр из сокета: `ops` (правки) или `live` (редактор открыт / закрыт). Ответ — только этому сокету."""
    item_id = str(frame.get("itemId") or "")
    if not item_id.isdigit():
        return None
    if frame.get("type") == "live":
        if frame.get("state") == "leave":
            unsubscribe(item_id, user_id)
        elif _can_view(user_id, item_id):
            subscribe(item_id, user_id)
        return None
    cid = str(frame.get("cid") or "")[:64]
    bid = frame.get("bid")
    ops = frame.get("ops")
    epoch = str(frame.get("epoch") or "")
    base = frame.get("base")
    if not cid or not isinstance(bid, int) or bid < 1 or not isinstance(base, int) or not isinstance(ops, list) or not ops:
        return None
    if not _can_edit(user_id, item_id):
        return {"type": "workspace_ops_denied", "itemId": item_id, "cid": cid, "bid": bid}
    rest = json.dumps({"cid": cid, "bid": bid, "userId": user_id, "ops": ops}, ensure_ascii=False, separators=(",", ":"))
    if len(rest) > FRAME_MAX_BYTES:
        return {"type": "workspace_ops_denied", "itemId": item_id, "cid": cid, "bid": bid, "reason": "too_large"}
    tail = "," + rest[1:]
    status, value = _submit(item_id, epoch, base, cid, bid, tail)
    if status == "ok":
        rev = int(value)
        subscribe(item_id, user_id)
        _push(item_id, {"type": "workspace_ops", "itemId": item_id, "epoch": epoch, "rev": rev, "cid": cid, "bid": bid,
                        "userId": user_id, "ops": ops}, extra=(user_id,))
        return None
    if status in ("behind", "dup"):
        rev = int(value)
        missing = _entries(item_id, rev, base) if base <= rev else None
        if missing is None:
            return {"type": "workspace_live_reset", "itemId": item_id}
        return {"type": "workspace_ops_behind", "itemId": item_id, "epoch": epoch, "cid": cid, "bid": bid, "rev": rev, "ops": missing}
    return {"type": "workspace_live_reset", "itemId": item_id}


def _can_view(user_id: str, item_id: str) -> bool:
    try:
        store.get_visible(item_id, user_id, content=False)
        return True
    except store.WorkspaceError:
        return False


def _submit(item_id: str, epoch: str, base: int, cid: str, bid: int, tail: str) -> tuple[str, str]:
    r = _redis()
    if r is not None:
        try:
            status, value = r.eval(_SUBMIT, 2, *_keys(item_id), epoch, base, tail, LOG_MAX, TTL, cid, bid)
            return str(status), str(value)
        except Exception as exc:
            log.warning("workspace live: redis submit failed (%s)", exc)
    with _mem.lock:
        head = _mem.heads.get(item_id)
        if not head or head["epoch"] != epoch:
            return "reset", head["epoch"] if head else ""
        if bid <= head.get("b:" + cid, 0):
            return "dup", str(head["rev"])
        if head["rev"] != base:
            return "behind", str(head["rev"])
        head["rev"] += 1
        head["b:" + cid] = bid
        entries = _mem.logs.setdefault(item_id, [])
        entries.append('{"rev":' + str(head["rev"]) + tail)
        del entries[:-LOG_MAX]
        return "ok", str(head["rev"])


def check_save(item_id: str, epoch: str, rev: int) -> None:
    """Сохранение содержимого от живого редактора: поколение то же, номер не из будущего. Иначе 409 — перечитать."""
    head = _head(str(item_id))
    if not head or head["epoch"] != epoch or rev < 0 or rev > head["rev"]:
        raise store.WorkspaceError(409, "Материал перечитан: изменили мимо совместной правки")


def save_condition() -> str:
    """Записать, только если в базе не лежит уже та же или более новая версия этого поколения."""
    return ("(meta->'live'->>'epoch' IS DISTINCT FROM %s OR COALESCE((meta->'live'->>'rev')::bigint, -1) < %s)")


def announce_saved(item_id: str, epoch: str, rev: int) -> None:
    """Версия сохранена в базе: остальным не нужно сохранять то же самое ещё раз."""
    _push(str(item_id), {"type": "workspace_live_saved", "itemId": str(item_id), "epoch": epoch, "rev": rev}, extra=())

