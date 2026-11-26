"""Правка таблицы агентом «на глазах» — через совместную правку, а не перезаписью файла.

Когда таблицу кто-то держит открытой, правка агента (update_table) превращается в те же мутации, что шлёт редактор
(`sheet.mutation.set-range-values`), и уходит в журнал совместной правки небольшими порциями с паузами. Открывшие
видят, как ячейки заполняются одна за другой, а рамка с именем агента идёт по таблице (курсор, как у коллеги).
Их собственные правки при этом не теряются и не сбрасываются: агент — ещё один участник, а не новая версия файла.
Содержимое в базе, как и при обычной совместной правке, сохраняют открытые редакторы.

Если таблицу никто не открыл — агент пишет файл как раньше (mcp/tools.update_table).
"""

from __future__ import annotations

import io
import json
import re
import time
import uuid
import zipfile
from typing import Any

from app.modules.workspace import live, store

VALUES = "sheet.mutation.set-range-values"
# Весь поток — не дольше этого: длинная правка идёт порциями побольше, короткая — по ячейке.
STREAM_BUDGET_S = 2.4
MIN_PAUSE_S = 0.015
MAX_PAUSE_S = 0.12
# Сколько ждём, пока открытый редактор сохранит правку в базу (чтобы следующий read_item видел её).
SAVE_WAIT_S = 4.0

_REF = re.compile(r"^([A-Z]{1,3})(\d{1,7})$")


def col_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def parse_ref(ref: str) -> tuple[int, int]:
    """«B12» → (11, 1): строка и столбец с нуля, как в снимке книги редактора."""
    m = _REF.match(ref.upper())
    if not m:
        raise ValueError(ref)
    return int(m.group(2)) - 1, col_index(m.group(1))


def live_head(item_id: str) -> dict[str, Any] | None:
    """Таблица открыта (кто-то подписан на совместную правку) — версия журнала; иначе None."""
    head = live._head(str(item_id))
    if not head:
        return None
    try:
        if not live._subscribers(str(item_id)):
            return None
    except Exception:
        return None
    return head


def sheet_ids(content_b64: str, names: list[str]) -> dict[str, str]:
    """Имя листа → его номер в редакторе: из свойств файла (SharSheetIds), иначе sheet-1, sheet-2… по порядку —
    ровно как назначает редактор (lib/workbook.ts)."""
    stored: dict[str, str] = {}
    try:
        import base64

        with zipfile.ZipFile(io.BytesIO(base64.b64decode(content_b64))) as z:
            if "docProps/custom.xml" in z.namelist():
                xml = z.read("docProps/custom.xml").decode("utf-8", "replace")
                m = re.search(r'name="SharSheetIds"[^>]*>\s*<vt:lpwstr>(.*?)</vt:lpwstr>', xml, re.DOTALL)
                if m:
                    raw = m.group(1).replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
                    stored = {str(k): str(v) for k, v in json.loads(raw).items() if v}
    except Exception:
        stored = {}
    out: dict[str, str] = {}
    used: set[str] = set()
    for index, name in enumerate(names):
        sid = stored.get(name) or f"sheet-{index + 1}"
        if sid in used:
            sid = f"sheet-{index + 1}-{len(used)}"
        used.add(sid)
        out[name] = sid
    return out


def cell_payload(value: Any, link: str = "") -> dict[str, Any] | None:
    """Значение из вызова агента → ячейка снимка редактора (как пишет сам редактор: число, текст, формула, ссылка).
    None — очистить ячейку."""
    if value is None or value == "":
        if not link:
            return None
        value = link
    if isinstance(value, bool):
        return {"v": 1 if value else 0, "t": 3, "f": None, "p": None}
    if isinstance(value, (int, float)):
        return {"v": value, "t": 2, "f": None, "p": None}
    text = str(value)
    if text.startswith("=") and len(text) > 1 and not link:
        return {"v": None, "t": None, "f": text, "p": None}
    cell: dict[str, Any] = {"v": text, "t": 1, "f": None, "p": None}
    if link:
        # Ссылка — как ставит её редактор (setLink): текст с диапазоном-ссылкой внутри.
        cell["p"] = {"id": f"ln{uuid.uuid4().hex[:10]}", "documentStyle": {}, "body": {
            "dataStream": f"{text}\r\n",
            "customRanges": [{"startIndex": 0, "endIndex": max(0, len(text) - 1), "rangeId": f"r{uuid.uuid4().hex[:8]}",
                              "rangeType": 0, "properties": {"url": link}}]}}
    return cell


def plan(writes: list[tuple[int, int, dict[str, Any] | None]]) -> tuple[list[list[tuple[int, int, dict[str, Any] | None]]], float]:
    """Порции потока и пауза между ними. Немного ячеек — по одной (видно, как агент «печатает»), много — по строке,
    а очень много — по нескольку строк, чтобы весь поток уложился в STREAM_BUDGET_S."""
    if not writes:
        return [], 0.0
    ordered = sorted(writes, key=lambda w: (w[0], w[1]))
    if len(ordered) <= 40:
        chunks = [[w] for w in ordered]
    else:
        by_row: dict[int, list[tuple[int, int, dict[str, Any] | None]]] = {}
        for w in ordered:
            by_row.setdefault(w[0], []).append(w)
        rows = list(by_row.values())
        per = max(1, -(-len(rows) // 80))  # не больше ~80 порций
        chunks = [[w for row in rows[i:i + per] for w in row] for i in range(0, len(rows), per)]
    pause = min(MAX_PAUSE_S, max(MIN_PAUSE_S, STREAM_BUDGET_S / max(1, len(chunks))))
    return chunks, pause


def _ops(sheet_id: str, chunk: list[tuple[int, int, dict[str, Any] | None]]) -> list[dict[str, Any]]:
    matrix: dict[str, dict[str, Any]] = {}
    for r, c, cell in chunk:
        matrix.setdefault(str(r), {})[str(c)] = cell
    return [{"id": VALUES, "params": {"subUnitId": sheet_id, "cellValue": matrix}}]


class _Agent:
    """Агент как участник совместной правки: свой номер клиента (cid) и растущий номер пачки (bid)."""

    def __init__(self, user_id: str, label: str) -> None:
        self.user_id = user_id
        self.label = label
        self.cid = f"agent-{uuid.uuid4().hex[:12]}"
        self.bid = 0
        self.cursor_id = f"agent:{self.cid}"


def submit(item_id: str, agent: _Agent, ops: list[dict[str, Any]]) -> tuple[str, int] | None:
    """Положить пачку правок в журнал от текущей версии и раздать открывшим. Кто-то успел раньше — берём новую
    версию и повторяем (правки агента — значения по адресам, их не нужно переносить). None — журнала нет."""
    agent.bid += 1
    rest = json.dumps({"cid": agent.cid, "bid": agent.bid, "userId": agent.user_id, "ops": ops}, ensure_ascii=False, separators=(",", ":"))
    tail = "," + rest[1:]
    for _ in range(30):
        head = live._head(item_id)
        if not head:
            return None
        status, value = live._submit(item_id, head["epoch"], head["rev"], agent.cid, agent.bid, tail)
        if status == "ok":
            rev = int(value)
            live._push(item_id, {"type": "workspace_ops", "itemId": item_id, "epoch": head["epoch"], "rev": rev, "cid": agent.cid,
                                 "bid": agent.bid, "userId": agent.user_id, "ops": ops}, extra=())
            return head["epoch"], rev
        if status == "dup":
            return head["epoch"], int(value)
        if status != "behind":
            return None
        time.sleep(0.01)
    return None


def cursor(item_id: str, agent: _Agent, sheet_id: str | None, r1: int = 0, c1: int = 0, r2: int = 0, c2: int = 0) -> None:
    """Рамка агента в таблице — как курсор коллеги, с его именем; sheet_id=None — убрать."""
    pos = {"sh": sheet_id, "r1": r1, "c1": c1, "r2": r2, "c2": c2} if sheet_id else None
    live._push(item_id, {"type": "workspace_cursor", "itemId": item_id, "userId": agent.cursor_id, "name": agent.label,
                         "agent": True, "cursor": pos}, extra=())


def stream(item_id: str, user_id: str, label: str, batches: list[tuple[str, list[tuple[int, int, dict[str, Any] | None]]]]) -> tuple[str, int] | None:
    """Провести правки агента потоком. batches — (номер листа, [(строка, столбец, ячейка)]). Вернёт последнюю версию
    журнала или None, если совместной правки уже нет (тогда вызывающий пишет файл)."""
    agent = _Agent(user_id, label)
    last: tuple[str, int] | None = None
    try:
        for sheet_id, writes in batches:
            chunks, pause = plan(writes)
            for chunk in chunks:
                rows = [w[0] for w in chunk]; cols = [w[1] for w in chunk]
                cursor(item_id, agent, sheet_id, min(rows), min(cols), max(rows), max(cols))
                got = submit(item_id, agent, _ops(sheet_id, chunk))
                if got is None:
                    return last
                last = got
                time.sleep(pause)
    finally:
        try:
            cursor(item_id, agent, None)
        except Exception:
            pass
    return last


def wait_saved(item_id: str, epoch: str, rev: int, timeout: float = SAVE_WAIT_S) -> dict[str, Any] | None:
    """Дождаться, пока открытый редактор сохранит версию rev в базу (meta.live), — чтобы следующее чтение агента
    видело его правку. Не дождались — вернём что есть (редактор сохранит чуть позже)."""
    deadline = time.monotonic() + timeout
    row = None
    while time.monotonic() < deadline:
        row = store.get_row(item_id, full=False)
        mark = ((row or {}).get("meta") or {}).get("live") or {}
        if mark.get("epoch") == epoch and int(mark.get("rev") or -1) >= rev:
            return row
        time.sleep(0.15)
    return row
