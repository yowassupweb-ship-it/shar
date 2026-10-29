"""Текст ячеек «с оформлением», потерянный при сохранении таблицы.

Univer хранит текст ячейки с оформлением внутри (шрифт, цвет части текста — так бывает при вставке и при наборе в
оформленную ячейку) как rich text: поле `p` без простого значения `v`. Клиент при сборке xlsx писал только `v` —
такая ячейка сохранялась пустой: человек видел свой текст, пока таблица открыта, а после переоткрытия его не было.
Старые версии Шар OS (интерфейс в установщике) так и будут сохранять, поэтому чиним на сервере: при сохранении
таблицы из совместной правки берём из журнала (live.py) последний текст таких ячеек и вписываем его в файл —
только в ячейки, которые в файле пустые. Сдвиги строк и столбцов из журнала учитываем; после перестановок
(сортировка, перенос диапазона) ячейку не трогаем — лучше не вписать, чем вписать не туда.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import logging
import re
import zipfile
from typing import Any, Optional
from xml.sax.saxutils import escape

log = logging.getLogger(__name__)

VALUES = "sheet.mutation.set-range-values"
SHIFTS = {
    "sheet.mutation.insert-row": ("row", 1),
    "sheet.mutation.remove-rows": ("row", -1),
    "sheet.mutation.insert-col": ("col", 1),
    "sheet.mutation.remove-col": ("col", -1),
}
# Переставляют ячейки так, что их новое место не вычислить по номерам строк: такие листы не чиним.
SHUFFLES = {"sheet.mutation.reorder-range", "sheet.mutation.move-rows", "sheet.mutation.move-columns", "sheet.mutation.move-range"}
REMOVE_SHEET = "sheet.mutation.remove-sheet"
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

Key = tuple[str, int, int]


def rich_text(cell: Any) -> Optional[str]:
    """Текст ячейки, если она — rich text без простого значения и без формулы. Иначе None."""
    if not isinstance(cell, dict) or cell.get("v") not in (None, "") or cell.get("f") or cell.get("si"):
        return None
    body = (cell.get("p") or {}).get("body") if isinstance(cell.get("p"), dict) else None
    stream = (body or {}).get("dataStream") if isinstance(body, dict) else None
    if not isinstance(stream, str):
        return None
    text = stream[:-2] if stream.endswith("\r\n") else stream.rstrip("\r\n")
    text = _CONTROL.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))
    return text if text.strip() else None


def lost_cells(entries: list[dict[str, Any]]) -> dict[Key, str]:
    """По журналу (в порядке номеров): ячейки, последняя запись которых — rich text, в их нынешних координатах."""
    marks: dict[Key, str] = {}
    shuffled: set[str] = set()
    for entry in entries:
        for op in entry.get("ops") or []:
            op_id, params = op.get("id"), op.get("params") or {}
            sheet = str(params.get("subUnitId") or "")
            if op_id == VALUES:
                for r, cols in (params.get("cellValue") or {}).items():
                    for c, cell in (cols or {}).items():
                        try:
                            key = (sheet, int(r), int(c))
                        except (TypeError, ValueError):
                            continue
                        if cell is None:
                            marks.pop(key, None)
                            continue
                        if not isinstance(cell, dict) or not ({"v", "p", "f", "si"} & cell.keys()):
                            continue  # только оформление — значение прежнее
                        text = rich_text(cell)
                        if text is None:
                            marks.pop(key, None)
                        else:
                            marks[key] = text
            elif op_id in SHIFTS:
                axis, sign = SHIFTS[op_id]
                rng = params.get("range") or {}
                start = int(rng.get("startRow" if axis == "row" else "startColumn") or 0)
                end = int(rng.get("endRow" if axis == "row" else "endColumn") or start)
                count = end - start + 1
                moved: dict[Key, str] = {}
                for (s, r, c), text in marks.items():
                    if s != sheet:
                        moved[(s, r, c)] = text
                        continue
                    p = r if axis == "row" else c
                    if sign > 0:
                        p = p + count if p >= start else p
                    elif start <= p <= end:
                        continue  # строка (столбец) удалена вместе с текстом
                    elif p > end:
                        p -= count
                    moved[(s, p, c) if axis == "row" else (s, r, p)] = text
                marks = moved
            elif op_id in SHUFFLES:
                shuffled.add(sheet)
            elif op_id == REMOVE_SHEET:
                marks = {k: v for k, v in marks.items() if k[0] != sheet}
    return {k: v for k, v in marks.items() if k[0] not in shuffled}


def _col_name(index: int) -> str:
    n, out = index + 1, ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        out = chr(65 + rem) + out
    return out


def _col_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n - 1


def _sheet_paths(files: dict[str, bytes]) -> dict[str, str]:
    """Имя листа → путь XML в архиве."""
    rels = files.get("xl/_rels/workbook.xml.rels", b"").decode("utf-8", "replace")
    targets = {}
    for rel in re.findall(r"<Relationship\b[^>]*>", rels):
        rid = re.search(r'\bId="([^"]+)"', rel)
        target = re.search(r'\bTarget="([^"]+)"', rel)
        if rid and target:
            t = target.group(1)
            targets[rid.group(1)] = t[1:] if t.startswith("/") else f"xl/{t}"
    out = {}
    for sheet in re.findall(r"<sheet\b[^>]*>", files.get("xl/workbook.xml", b"").decode("utf-8", "replace")):
        name = re.search(r'\bname="([^"]*)"', sheet)
        rid = re.search(r'\br:id="([^"]+)"', sheet)
        if name and rid and rid.group(1) in targets:
            out[_unescape(name.group(1))] = targets[rid.group(1)]
    return out


def _unescape(s: str) -> str:
    return s.replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&apos;", "'").replace("&amp;", "&")


def _sheet_ids(files: dict[str, bytes]) -> dict[str, str]:
    """Id листа Univer → имя листа (свойство SharSheetIds, его пишет клиент)."""
    custom = files.get("docProps/custom.xml", b"").decode("utf-8", "replace")
    m = re.search(r'name="SharSheetIds"[^>]*>\s*<vt:lpwstr>(.*?)</vt:lpwstr>', custom, re.S)
    try:
        by_name = json.loads(_unescape(m.group(1))) if m else {}
    except ValueError:
        by_name = {}
    return {str(sid): name for name, sid in by_name.items() if isinstance(sid, str)}


_CELL = r'<c r="{ref}"(?=[\s/>])[^>]*?(?:/>|>.*?</c>)'


def _inline(ref: str, attrs: str, text: str) -> str:
    attrs = re.sub(r'\s+t="[^"]*"', "", attrs)
    return f'<c r="{ref}"{attrs} t="inlineStr"><is><t xml:space="preserve">{escape(text)}</t></is></c>'


def _fill(xml: str, row: int, col: int, text: str) -> tuple[str, bool]:
    """Вписать текст в пустую ячейку листа. Ячейку со значением не трогаем."""
    ref = f"{_col_name(col)}{row + 1}"
    found = re.search(_CELL.format(ref=ref), xml, re.S)
    if found:
        element = found.group(0)
        if "<v>" in element or "<v " in element or "<is>" in element or "<f>" in element or "<f " in element:
            return xml, False
        attrs = re.match(r'<c r="[^"]+"([^>]*?)/?>', element).group(1)
        return xml[: found.start()] + _inline(ref, attrs, text) + xml[found.end():], True
    cell = _inline(ref, "", text)
    row_re = re.compile(r'<row r="%d"(?=[\s/>])[^>]*?(?:/>|>(.*?)</row>)' % (row + 1), re.S)
    found_row = row_re.search(xml)
    if found_row:
        element = found_row.group(0)
        if element.endswith("/>"):
            return xml[: found_row.start()] + element[:-2] + ">" + cell + "</row>" + xml[found_row.end():], True
        inner_start = found_row.start() + element.index(">") + 1
        inner = found_row.group(1) or ""
        # Ячейки строки — по порядку столбцов.
        at = len(inner)
        for m in re.finditer(r'<c r="([A-Z]+)\d+"', inner):
            if _col_index(m.group(1)) > col:
                at = m.start()
                break
        pos = inner_start + at
        return xml[:pos] + cell + xml[pos:], True
    data = re.search(r"<sheetData\s*/>|<sheetData>(.*?)</sheetData>", xml, re.S)
    if not data:
        return xml, False
    new_row = f'<row r="{row + 1}">{cell}</row>'
    if data.group(0).endswith("/>"):
        return xml[: data.start()] + "<sheetData>" + new_row + "</sheetData>" + xml[data.end():], True
    inner_start = data.start() + len("<sheetData>")
    inner = data.group(1) or ""
    at = len(inner)
    for m in re.finditer(r'<row r="(\d+)"', inner):
        if int(m.group(1)) > row + 1:
            at = m.start()
            break
    pos = inner_start + at
    return xml[:pos] + new_row + xml[pos:], True


def repair_xlsx(content_b64: str, marks: dict[Key, str]) -> tuple[str, int]:
    """Вписать потерянный текст в xlsx (base64). Возвращает новое содержимое и сколько ячеек вписано."""
    if not marks or not content_b64.strip():
        return content_b64, 0
    try:
        raw = base64.b64decode(content_b64, validate=False)
        src = zipfile.ZipFile(io.BytesIO(raw))
    except (binascii.Error, zipfile.BadZipFile, ValueError):
        return content_b64, 0
    infos = src.infolist()
    files = {info.filename: src.read(info.filename) for info in infos}
    names = _sheet_ids(files)
    paths = _sheet_paths(files)
    fixed = 0
    by_path: dict[str, str] = {}
    for (sheet, row, col), text in sorted(marks.items()):
        path = paths.get(names.get(sheet, ""))
        if not path or path not in files:
            continue
        xml = by_path.get(path) or files[path].decode("utf-8")
        xml, done = _fill(xml, row, col, text)
        by_path[path] = xml
        fixed += int(done)
    if not fixed:
        return content_b64, 0
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in infos:
            data = by_path[info.filename].encode("utf-8") if info.filename in by_path else files[info.filename]
            dst.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
    return base64.b64encode(out.getvalue()).decode("ascii"), fixed


def repair_saved_table(item_id: str, content: str, epoch: str, rev: int) -> str:
    """Сохранение таблицы из совместной правки: вписать потерянный rich text по журналу до версии rev."""
    from app.modules.workspace import live

    try:
        entries = live.journal_until(item_id, epoch, rev)
        if not entries:
            return content
        repaired, fixed = repair_xlsx(content, lost_cells(entries))
        if fixed:
            log.info("workspace table %s: restored %s rich-text cells (rev %s)", item_id, fixed, rev)
        return repaired
    except Exception:  # noqa: BLE001 — починка не должна мешать сохранению
        log.exception("workspace table %s: rich-text repair failed", item_id)
        return content
