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
        out = _CONTROL.sub("", out)
        lines.append(f"{'#' * heading} {out}" if heading and out.strip() else out)
        begin = end + 1
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
