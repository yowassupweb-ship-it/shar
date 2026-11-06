"""Документ «Офиса» (снимок Univer Docs) ↔ Markdown — на сервере, для агентов по MCP.

Перенос клиентского src/features/workspace/lib/docSnapshot.ts (markdownToSnapshot, snapshotToMarkdown) с теми же
правилами: абзацы разделены «\\r», в конце потока «\\r\\n»; textRuns размечают участки стилем ts (bl — жирный,
it — курсив, fs — кегль, ff — шрифт); заголовки — жирным с кеглем 28/22/18. Так документ, созданный агентом,
выглядит как импортированный из Markdown в самом «Офисе».

Картинки агенту не даём вставлять: строка ![подпись](адрес) становится ссылкой.
"""

from __future__ import annotations

import re
import secrets
import time
from itertools import pairwise
from typing import Any

from app.modules.mcp import textmatch

PAGE = {"width": 794, "height": 1124, "margin": 72}
HEADING_SIZE = {1: 28, 2: 22, 3: 18}
HYPERLINK = 0  # CustomRangeType.HYPERLINK

_INLINE = re.compile(
    r"\\([\\`*_\[\]|#>+\-.)!])"
    r"|\[((?:\\.|[^\]\n\\])+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)"
    r"|\*\*((?:\\.|[^*\\])+)\*\*"
    r"|__((?:\\.|[^_\\])+)__"
    r"|\*((?:\\.|[^*\n\\])+)\*"
    r"|_((?:\\.|[^_\n\\])+)_"
    r"|`([^`\n]+)`"
)
_CONTROL = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f]")


def _rid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}{int(time.time() * 1000):x}"


def empty_snapshot(title: str = "") -> dict[str, Any]:
    return {
        "id": _rid("doc"), "locale": "ruRU", "title": title,
        "tableSource": {}, "drawings": {}, "drawingsOrder": [], "headers": {}, "footers": {}, "notes": {}, "noteSettings": {},
        "body": {
            "dataStream": "\r\n", "textRuns": [], "customBlocks": [], "tables": [], "columnGroups": [], "blockRanges": [],
            "customRanges": [], "customDecorations": [],
            "paragraphs": [{"startIndex": 0, "paragraphId": _rid("para"), "paragraphStyle": {"lineSpacing": 1.15}}],
            "sectionBreaks": [{"sectionId": _rid("section"), "startIndex": 1}],
        },
        "documentStyle": {
            "pageSize": {"width": PAGE["width"], "height": PAGE["height"]}, "documentFlavor": 1,
            "marginTop": PAGE["margin"], "marginBottom": PAGE["margin"], "marginRight": PAGE["margin"], "marginLeft": PAGE["margin"],
            "autoHyphenation": 1, "doNotHyphenateCaps": 0, "consecutiveHyphenLimit": 2,
            "defaultHeaderId": "", "defaultFooterId": "", "evenPageHeaderId": "", "evenPageFooterId": "",
            "firstPageHeaderId": "", "firstPageFooterId": "", "evenAndOddHeaders": 0, "useFirstPageHeaderFooter": 0,
            "marginHeader": 30, "marginFooter": 30,
        },
        "settings": {},
    }


def _inline(source: str) -> tuple[str, list[dict[str, Any]]]:
    """**жирный**, *курсив*, `код`, [ссылка](адрес) → чистый текст и участки со стилем."""
    text = ""
    runs: list[dict[str, Any]] = []
    last = 0
    for m in _INLINE.finditer(source):
        text += source[last:m.start()]
        last = m.end()
        if m.group(1) is not None:
            text += m.group(1)
            continue
        if m.group(2) is not None:
            inner, inner_runs = _inline(m.group(2))
            start = len(text)
            text += inner
            runs += [{**r, "start": r["start"] + start, "end": r["end"] + start} for r in inner_runs]
            runs.append({"start": start, "end": len(text), "link": m.group(3)})
            continue
        if m.group(8) is not None:
            start = len(text)
            text += m.group(8)
            runs.append({"start": start, "end": len(text), "code": True})
            continue
        bold = m.group(4) if m.group(4) is not None else m.group(5)
        inner, inner_runs = _inline(bold if bold is not None else (m.group(6) if m.group(6) is not None else m.group(7)))
        start = len(text)
        text += inner
        runs += [{**r, "start": r["start"] + start, "end": r["end"] + start} for r in inner_runs]
        runs.append({"start": start, "end": len(text), "bold": bold is not None, "italic": bold is None})
    return text + source[last:], runs


def _shift(runs: list[dict[str, Any]], by: int) -> list[dict[str, Any]]:
    return [{**r, "start": r["start"] + by, "end": r["end"] + by} for r in runs]


def parse_markdown(markdown: str) -> list[dict[str, Any]]:
    """Строки Markdown → абзацы. Таблицы Markdown — строками через « | »."""
    paragraphs: list[dict[str, Any]] = []
    for raw in str(markdown or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.rstrip()
        if not line.strip():
            paragraphs.append({"text": "", "runs": [], "blank": True})
            continue
        if re.match(r"^\s*\|?[\s:-]+\|[\s|:-]*$", line):
            continue
        image = re.match(r"^!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)$", line.strip())
        if image:
            label = image.group(1) or "Картинка"
            paragraphs.append({"text": label, "runs": [{"start": 0, "end": len(label), "link": image.group(2).split("#")[0]}]})
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            text, runs = _inline(heading.group(2))
            paragraphs.append({"text": text, "runs": runs, "heading": min(3, len(heading.group(1)))})
            continue
        bullet = re.match(r"^(\s*)[-*+]\s+(.*)$", line)
        if bullet:
            text, runs = _inline(bullet.group(2))
            paragraphs.append({"text": f"• {text}", "runs": _shift(runs, 2)})
            continue
        numbered = re.match(r"^(\s*)(\d+)[.)]\s+(.*)$", line)
        if numbered:
            text, runs = _inline(numbered.group(3))
            label = f"{numbered.group(2)}. "
            paragraphs.append({"text": label + text, "runs": _shift(runs, len(label))})
            continue
        if re.match(r"^\s*\|.*\|\s*$", line):
            cells = [c.strip() for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
            text, runs = _inline("  |  ".join(cells))
            paragraphs.append({"text": text, "runs": runs})
            continue
        text, runs = _inline(line.strip())
        paragraphs.append({"text": text, "runs": runs})
    # Подряд идущие пустые строки схлопываем: между абзацами достаточно одного интервала.
    return [p for i, p in enumerate(paragraphs) if not (p.get("blank") and (i == 0 or paragraphs[i - 1].get("blank")))]


def _build(markdown: str, base: int = 0) -> dict[str, Any]:
    """Поток, абзацы, стили и ссылки для Markdown; base — смещение, с которого куски встанут в документ."""
    paragraphs = parse_markdown(markdown)
    if not paragraphs or all(p.get("blank") for p in paragraphs):
        paragraphs = [{"text": "", "runs": []}]
    stream = ""
    para_list: list[dict[str, Any]] = []
    text_runs: list[dict[str, Any]] = []
    ranges: list[dict[str, Any]] = []
    for item in paragraphs:
        offset = base + len(stream)
        stream += item["text"]
        if item.get("heading"):
            text_runs.append({"st": offset, "ed": offset + len(item["text"]), "ts": {"bl": 1, "fs": HEADING_SIZE[item["heading"]]}})
        for run in item["runs"]:
            if run["end"] <= run["start"]:
                continue
            if run.get("link"):
                ranges.append({"startIndex": offset + run["start"], "endIndex": offset + run["end"] - 1, "rangeId": _rid("link"),
                               "rangeType": HYPERLINK, "properties": {"url": run["link"]}})
                continue
            ts: dict[str, Any] = {}
            if run.get("bold"):
                ts["bl"] = 1
            if run.get("italic"):
                ts["it"] = 1
            if run.get("code"):
                ts["ff"] = "Courier New"
            if ts:
                text_runs.append({"st": offset + run["start"], "ed": offset + run["end"], "ts": ts})
        style: dict[str, Any] = {"lineSpacing": 1.15}
        if item.get("heading"):
            style["spaceAbove"] = {"v": 18 if item["heading"] == 1 else 12}
        para_list.append({"startIndex": base + len(stream), "paragraphId": _rid("para"), "paragraphStyle": style})
        stream += "\r"
    return {"stream": stream, "paragraphs": para_list, "textRuns": text_runs, "customRanges": ranges}


def markdown_to_snapshot(title: str, markdown: str) -> dict[str, Any]:
    snapshot = empty_snapshot(title)
    built = _build(markdown)
    body = snapshot["body"]
    body["dataStream"] = built["stream"] + "\n"
    body["paragraphs"] = built["paragraphs"]
    body["textRuns"] = built["textRuns"]
    body["customRanges"] = built["customRanges"]
    body["sectionBreaks"] = [{"sectionId": _rid("section"), "startIndex": len(built["stream"])}]
    return snapshot


def append_markdown(snapshot: dict[str, Any], markdown: str) -> dict[str, Any]:
    """Дописать абзацы в конец документа, не трогая то, что в нём уже есть (стили, таблицы, картинки).

    Новый текст встаёт перед завершающим «\\n» (разрыв раздела): сдвигаются только разрывы раздела в конце."""
    body = snapshot.setdefault("body", {})
    stream = str(body.get("dataStream") or "\r\n")
    if not stream.endswith("\n"):
        stream += "\n"
    at = len(stream) - 1
    built = _build(markdown, base=at)
    added = len(built["stream"])
    body["dataStream"] = stream[:at] + built["stream"] + "\n"
    body["paragraphs"] = list(body.get("paragraphs") or []) + built["paragraphs"]
    body["textRuns"] = list(body.get("textRuns") or []) + built["textRuns"]
    if built["customRanges"]:
        body["customRanges"] = list(body.get("customRanges") or []) + built["customRanges"]
    breaks = body.get("sectionBreaks") or [{"sectionId": _rid("section"), "startIndex": at}]
    body["sectionBreaks"] = [{**b, "startIndex": b["startIndex"] + added if b.get("startIndex", 0) >= at else b["startIndex"]} for b in breaks]
    return snapshot


def insert_markdown(snapshot: dict[str, Any], markdown: str, after_text: str) -> dict[str, Any]:
    """Вставить абзацы после абзаца с точным фрагментом, сохранив разметку остального документа."""
    if not after_text or any(ch in after_text for ch in "\r\n"):
        raise TextNotFound("Для вставки укажите after_text — точный фрагмент одного абзаца")
    body = snapshot.setdefault("body", {})
    stream = str(body.get("dataStream") or "")
    count = stream.count(after_text)
    if not count:
        raise TextNotFound("Абзац с таким after_text не найден: возьмите точный фрагмент из read_item format=text")
    if count > 1:
        raise TextNotFound(f"after_text встречается {count} раз: уточните фрагмент")
    anchor = stream.find(after_text) + len(after_text)
    paragraph_end = stream.find("\r", anchor)
    at = paragraph_end + 1 if paragraph_end >= 0 else len(stream)
    return insert_at(snapshot, at, markdown)


def insert_at(snapshot: dict[str, Any], at: int, markdown: str) -> dict[str, Any]:
    """Вставить абзацы Markdown в поток с позиции at (начало абзаца): всё, что стоит после, сдвигается."""
    body = snapshot.setdefault("body", {})
    stream = str(body.get("dataStream") or "")
    built = _build(markdown, base=at)
    added = len(built["stream"])
    body["dataStream"] = stream[:at] + built["stream"] + stream[at:]
    for key in ("paragraphs", "sectionBreaks", "customBlocks"):
        for item in body.get(key) or []:
            if int(item.get("startIndex", 0)) >= at:
                item["startIndex"] = int(item.get("startIndex", 0)) + added
    for run in body.get("textRuns") or []:
        for key in ("st", "ed"):
            if int(run.get(key, 0)) >= at:
                run[key] = int(run.get(key, 0)) + added
    for key in ("customRanges", "customDecorations", "tables"):
        for item in body.get(key) or []:
            for field in ("startIndex", "endIndex"):
                if int(item.get(field, 0)) >= at:
                    item[field] = int(item.get(field, 0)) + added
    body["paragraphs"] = list(body.get("paragraphs") or []) + built["paragraphs"]
    body["textRuns"] = list(body.get("textRuns") or []) + built["textRuns"]
    if built["customRanges"]:
        body["customRanges"] = list(body.get("customRanges") or []) + built["customRanges"]
    return snapshot


def snapshot_text(snapshot: dict[str, Any]) -> str:
    """Чистый текст документа — тот, в котором ищет replace_text (абзацы — строками, без разметки)."""
    stream = str((snapshot.get("body") or {}).get("dataStream") or "")
    return _CONTROL.sub("", stream.replace("\r\n", "").replace("\r", "\n")).strip()


class TextNotFound(ValueError):
    pass


def _boundary(i: int, pos: int, end: int, size: int) -> int:
    """Граница между символами (начало или конец участка) после замены [pos, end) на текст длины size: позади
    замены — сдвиг на разницу длин, внутри — прижать к новому тексту, впереди — как было."""
    if i >= end:
        return i + size - (end - pos)
    return pos + min(i - pos, size) if i > pos else i


def _last_char(i: int, pos: int, end: int, size: int) -> int:
    """То же для индекса последнего символа (endIndex у ссылок и таблиц включительный)."""
    if i >= end:
        return i + size - (end - pos)
    return pos + max(0, min(i - pos, size - 1)) if i >= pos else i


def replace_text(snapshot: dict[str, Any], old: str, new: str, *, replace_all: bool = False) -> int:
    """Заменить кусок текста внутри абзаца, сохранив оформление: всё, что стоит после, сдвигается на разницу длин
    (абзацы, стили, ссылки, таблицы, картинки, разрывы). Возвращает число замен.

    Перенос строки в old/new не допускается: менять структуру абзацев так нельзя — для этого update_document."""
    if not old:
        raise TextNotFound("Пустой искомый текст")
    if any(ch in old + new for ch in "\r\n") or _CONTROL.search(old + new):
        raise TextNotFound("Замена работает внутри абзаца: без переносов строк в тексте")
    body = snapshot.setdefault("body", {})
    stream = str(body.get("dataStream") or "")
    matches, _ = textmatch.spans(stream, old)
    found = [start for start, _ in matches]
    if not found:
        raise TextNotFound(f"Такого текста в документе нет (ищется точный текст без разметки Markdown). {textmatch.explain_miss(stream, old)}")
    if len(found) > 1 and not replace_all:
        raise TextNotFound(f"Текст встречается {len(found)} раз: уточните его или включите replace_all")

    size = len(new)
    for pos in reversed(found):
        cut = (pos, pos + len(old), size)
        stream = stream[:pos] + new + stream[pos + len(old):]
        for key in ("paragraphs", "sectionBreaks", "customBlocks"):
            for item in body.get(key) or []:
                item["startIndex"] = _boundary(int(item.get("startIndex", 0)), *cut)
        for run in body.get("textRuns") or []:
            run["st"] = _boundary(int(run.get("st", 0)), *cut)
            run["ed"] = _boundary(int(run.get("ed", 0)), *cut)
        for key in ("customRanges", "customDecorations", "tables"):
            for item in body.get(key) or []:
                item["startIndex"] = _boundary(int(item.get("startIndex", 0)), *cut)
                item["endIndex"] = max(item["startIndex"], _last_char(int(item.get("endIndex", 0)), *cut))
    body["dataStream"] = stream
    return len(found)


def snapshot_to_markdown(snapshot: dict[str, Any]) -> str:
    """Markdown со структурой, которую понимает редактор: заголовки по кеглю, жирный, курсив, ссылки."""
    body = snapshot.get("body") or {}
    stream = str(body.get("dataStream") or "")
    runs = body.get("textRuns") or []
    links = [r for r in (body.get("customRanges") or []) if r.get("rangeType") == HYPERLINK and (r.get("properties") or {}).get("url")]
    starts = sorted(int(p.get("startIndex", 0)) for p in (body.get("paragraphs") or []))
    lines: list[str] = []
    begin = 0
    for end in starts:
        part = stream[begin:end]
        inside = [r for r in runs if r.get("ed", 0) > begin and r.get("st", 0) < end]
        size = max([float((r.get("ts") or {}).get("fs") or 0) for r in inside] or [0])
        heading = 1 if size >= HEADING_SIZE[1] else 2 if size >= HEADING_SIZE[2] else 3 if size >= HEADING_SIZE[3] else 0
        cuts = sorted({begin, end, *[max(r["st"], begin) for r in inside], *[min(r["ed"], end) for r in inside],
                       *[max(int(l["startIndex"]), begin) for l in links if begin <= l["startIndex"] < end],
                       *[min(int(l["endIndex"]) + 1, end) for l in links if begin <= l["startIndex"] < end]})
        out = ""
        for a, b in pairwise(cuts):
            piece = part[a - begin:b - begin]
            if not piece:
                continue
            covering = [r for r in inside if r["st"] <= a and r["ed"] >= b]
            if not heading and piece.strip():
                if any((r.get("ts") or {}).get("bl") for r in covering):
                    piece = f"**{piece}**"
                if any((r.get("ts") or {}).get("it") for r in covering):
                    piece = f"*{piece}*"
            link = next((l for l in links if l["startIndex"] <= a and int(l["endIndex"]) + 1 >= b), None)
            if link and piece.strip():
                piece = f"[{piece}]({link['properties']['url']})"
            out += piece
        out = _KEEP_TABLE.sub("", out)
        lines.append(f"{'#' * heading} {out}" if heading and out.strip() else out)
        begin = end + 1
    return re.sub(r"\n{3,}", "\n\n", _tables_to_markdown("\n".join(lines))).strip()


# Служебные знаки таблицы в потоке Univer: начало/конец таблицы, строки и ячейки.
_T_START, _T_END, _R_START, _R_END, _C_START, _C_END = "\x1a", "\x0f", "\x1b", "\x0e", "\x1c", "\x1d"
_KEEP_TABLE = re.compile(r"[\u0000-\u0008\u000b\u000c\u0010-\u0019\u001e\u001f]")  # всё служебное, кроме знаков таблицы
_TABLE = re.compile(_T_START + r"(.*?)" + _T_END, re.S)


def _tables_to_markdown(text: str) -> str:
    """Таблицы документа — таблицами Markdown (строка шапки, ячейки через « | »), а не россыпью строк: агент видит строки и столбцы."""
    def one(match: re.Match[str]) -> str:
        rows = []
        for row in re.findall(_R_START + r"(.*?)" + _R_END, match.group(1), re.S):
            cells = [" ".join(c.replace(_C_START, "").strip().split()).replace("|", "\\|") for c in re.findall(_C_START + r"(.*?)" + _C_END, row, re.S)]
            rows.append(cells)
        if not rows:
            return ""
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        lines = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"] + ["| " + " | ".join(r) + " |" for r in rows[1:]]
        return "\n" + "\n".join(lines) + "\n"

    return _CONTROL.sub("", _TABLE.sub(one, text))


# ── разделы: правка по заголовку, без точного текста ────────────────────────────────────────────────────────────────

def _paragraph_spans(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """Абзацы потока: начало, индекс «\\r» в конце, текст и уровень заголовка (по кеглю — как в snapshot_to_markdown)."""
    body = snapshot.get("body") or {}
    stream = str(body.get("dataStream") or "")
    runs = body.get("textRuns") or []
    out: list[dict[str, Any]] = []
    begin = 0
    for end in sorted(int(p.get("startIndex", 0)) for p in (body.get("paragraphs") or [])):
        inside = [r for r in runs if r.get("ed", 0) > begin and r.get("st", 0) < end]
        size = max([float((r.get("ts") or {}).get("fs") or 0) for r in inside] or [0])
        heading = 1 if size >= HEADING_SIZE[1] else 2 if size >= HEADING_SIZE[2] else 3 if size >= HEADING_SIZE[3] else 0
        text = _CONTROL.sub("", stream[begin:end]).strip()
        out.append({"start": begin, "end": end, "text": text, "heading": heading if text else 0})
        begin = end + 1
    return out


def _find_section(snapshot: dict[str, Any], title: str) -> dict[str, int]:
    """Раздел по заголовку: heading_start — начало заголовка, body_start — после него, end — до следующего заголовка того же или
    более высокого уровня (или до конца документа)."""
    spans = _paragraph_spans(snapshot)
    heads = [(i, p) for i, p in enumerate(spans) if p["heading"]]
    wanted = " ".join(str(title or "").split()).casefold().lstrip("# ").strip()
    if not wanted:
        raise TextNotFound("Укажите heading — заголовок раздела (названия — в outline у read_item)")
    exact = [h for h in heads if h[1]["text"].casefold() == wanted]
    found = exact or [h for h in heads if wanted in h[1]["text"].casefold()]
    if not found:
        raise TextNotFound(f"Раздел «{title}» не найден. Заголовки: {', '.join(p['text'] for _, p in heads[:30]) or 'в документе их нет'}")
    if len(found) > 1:
        raise TextNotFound(f"Заголовку «{title}» отвечает {len(found)} разделов: {', '.join(p['text'] for _, p in found[:8])}. Уточните название")
    index, head = found[0]
    stream = str((snapshot.get("body") or {}).get("dataStream") or "")
    end = next((p["start"] for p in spans[index + 1:] if p["heading"] and p["heading"] <= head["heading"]), len(stream) - 1 if stream.endswith("\n") else len(stream))
    return {"heading_start": head["start"], "body_start": head["end"] + 1, "end": end}


def delete_range(snapshot: dict[str, Any], a: int, b: int) -> None:
    """Убрать из потока участок [a, b) (границы абзацев): абзацы, стили и ссылки внутри пропадают, всё после сдвигается назад.
    Участок с таблицей или картинкой не трогаем — их правят точечно, иначе легко порвать структуру."""
    body = snapshot.setdefault("body", {})
    stream = str(body.get("dataStream") or "")
    if a >= b:
        return
    if re.search(r"[\x08\x1a\x1b\x1c\x1d\x0e\x0f]", stream[a:b]) or any(a <= int(t.get("startIndex", 0)) < b for t in body.get("tables") or []):
        raise TextNotFound("В этом разделе таблица или картинка: раздел целиком так не заменить. Правьте текст точечно (edit_document), "
                           "а новое добавляйте после заголовка (insert_after_heading)")
    size = b - a
    for key in ("paragraphs", "sectionBreaks", "customBlocks"):
        kept = []
        for item in body.get(key) or []:
            at = int(item.get("startIndex", 0))
            if a <= at < b:
                continue
            if at >= b:
                item["startIndex"] = at - size
            kept.append(item)
        body[key] = kept
    runs = []
    for run in body.get("textRuns") or []:
        st, ed = int(run.get("st", 0)), int(run.get("ed", 0))
        if ed <= a:
            runs.append(run)
            continue
        if st >= b:
            run["st"], run["ed"] = st - size, ed - size
            runs.append(run)
            continue
        st2 = st if st < a else a
        ed2 = a if ed <= b else ed - size
        if ed2 > st2:
            run["st"], run["ed"] = st2, ed2
            runs.append(run)
    body["textRuns"] = runs
    for key in ("customRanges", "customDecorations"):
        kept = []
        for item in body.get(key) or []:
            st, ed = int(item.get("startIndex", 0)), int(item.get("endIndex", 0))
            if ed < a:
                kept.append(item)
            elif st >= b:
                item["startIndex"], item["endIndex"] = st - size, ed - size
                kept.append(item)
            elif st >= a and ed < b:
                continue  # целиком внутри — уходит вместе с текстом
            # пересекает границу участка — ссылка порвана, убираем (текст остаётся без ссылки)
        body[key] = kept
    stream = stream[:a] + stream[b:]
    if "\r" not in stream:  # удалили всё: документ не бывает без абзаца
        stream = "\r\n"
        body["paragraphs"] = [{"startIndex": 0, "paragraphId": _rid("para"), "paragraphStyle": {"lineSpacing": 1.15}}]
        body["sectionBreaks"] = [{"sectionId": _rid("section"), "startIndex": 1}]
    body["dataStream"] = stream


def edit_section(snapshot: dict[str, Any], mode: str, heading: str, markdown: str = "") -> dict[str, Any]:
    """Правка по заголовку, без точного текста:
      replace_section — заменить содержимое раздела (сам заголовок остаётся; если Markdown начинается с «#», заменяется и он);
      delete_section — убрать раздел вместе с заголовком;
      append_to_section — дописать в конец раздела;
      insert_after_heading — вставить сразу под заголовком;
      insert_before_heading — вставить перед заголовком."""
    if mode != "delete_section" and not str(markdown or "").strip():
        raise TextNotFound("Передайте markdown — новый текст")
    sec = _find_section(snapshot, heading)
    if mode == "delete_section":
        delete_range(snapshot, sec["heading_start"], sec["end"])
    elif mode == "replace_section":
        if re.match(r"^\s*#{1,6}\s", str(markdown)):
            delete_range(snapshot, sec["heading_start"], sec["end"])
            insert_at(snapshot, sec["heading_start"], markdown)
        else:
            delete_range(snapshot, sec["body_start"], sec["end"])
            insert_at(snapshot, sec["body_start"], markdown)
    elif mode == "append_to_section":
        insert_at(snapshot, sec["end"], markdown)
    elif mode == "insert_after_heading":
        insert_at(snapshot, sec["body_start"], markdown)
    elif mode == "insert_before_heading":
        insert_at(snapshot, sec["heading_start"], markdown)
    else:
        raise TextNotFound(f"Неизвестный режим {mode}")
    return snapshot
