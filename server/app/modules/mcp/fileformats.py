"""Правка файлов «Файлов» на месте, без потери формата: кодировка и переносы строк текстовых файлов, текст docx/pptx
внутри абзацев (оформление не трогаем), ячейки xlsx.

Всё работает на байтах: читаем → правим → отдаём новые байты. Запись, права и версии — в files.py.
"""

from __future__ import annotations

import codecs
import html
import io
import re
import zipfile
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from app.modules.mcp import textmatch

TEXT_EXT = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".html", ".htm", ".yml", ".yaml", ".log", ".ini", ".cfg", ".conf",
    ".toml", ".sql", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".scss", ".sh", ".bat", ".ps1", ".php", ".rb", ".go",
    ".java", ".kt", ".c", ".h", ".cpp", ".cs", ".rs", ".svg", ".srt", ".vtt", ".tex", ".rst", ".env", ".gitignore", ".eml", ".ics", ".vcf",
}
OFFICE_EXT = {".docx", ".xlsx", ".pptx"}
_DOC_PARTS = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$")
_SLIDE_PART = re.compile(r"^ppt/(slides/slide\d+|notesSlides/notesSlide\d+)\.xml$")
_PARAGRAPH = {"w": (re.compile(r"<w:p[ >].*?</w:p>", re.S), re.compile(r"(<w:t(?: [^>]*)?>)(.*?)(</w:t>)", re.S)),
              "a": (re.compile(r"<a:p[ >].*?</a:p>", re.S), re.compile(r"(<a:t(?: [^>]*)?>)(.*?)(</a:t>)", re.S))}


def _err(text: str, code: str = "tool_error") -> Exception:
    from app.modules.mcp.tools import ToolError

    return ToolError(text, code)


# ── текстовые файлы ───────────────────────────────────────────────────────────

def looks_textual(name: str, data: bytes) -> bool:
    """Известное расширение — текст; неизвестное — текст, если в начале нет нулевых байтов и это читается как UTF-8/cp1251."""
    ext = Path(name).suffix.lower()
    if ext in TEXT_EXT or not ext:
        return True
    if ext in OFFICE_EXT or ext in {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".rar", ".7z", ".mp3", ".mp4", ".mov"}:
        return False
    head = data[:8192]
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
        return True
    except UnicodeDecodeError as exc:
        return exc.start > len(head) - 4  # обрыв на границе среза — не ошибка


def decode(data: bytes) -> tuple[str, dict[str, str]]:
    """Текст с переносами «\\n» и приметы файла (кодировка, переносы), чтобы вернуть всё как было."""
    encoding = "utf-8"
    if data.startswith(codecs.BOM_UTF8):
        encoding = "utf-8-sig"
    elif data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encoding = "utf-16"
    try:
        text = data.decode(encoding)
    except UnicodeDecodeError:
        try:
            text, encoding = data.decode("cp1251"), "cp1251"
        except UnicodeDecodeError:
            text, encoding = data.decode("utf-8", "replace"), "utf-8-lossy"
    crlf = text.count("\r\n")
    newline = "\r\n" if crlf and crlf * 2 >= text.count("\n") else "\n"
    return text.replace("\r\n", "\n"), {"encoding": encoding, "newline": newline}


def encode(text: str, info: dict[str, str]) -> bytes:
    if info["encoding"] == "utf-8-lossy":
        raise _err("Файл не в UTF-8 и не в cp1251: точечно править его нельзя, замените целиком через file_write с base64")
    return text.replace("\n", info["newline"]).encode(info["encoding"])


def replace_text(text: str, edits: list[dict[str, Any]], default_all: bool = False) -> tuple[str, int]:
    """Серия замен в одном тексте: сначала точное совпадение, затем типографские двойники (textmatch)."""
    done = 0
    for edit in edits:
        old, new = str(edit["old_text"]).replace("\r\n", "\n"), str(edit["new_text"]).replace("\r\n", "\n")
        spans, _ = textmatch.spans(text, old)
        if not spans:
            raise _err(f"Такого текста в файле нет. {textmatch.explain_miss(text, old)}", "text_not_found")
        every = edit.get("replace_all", default_all)
        if len(spans) > 1 and not every:
            raise _err(f"Текст встречается {len(spans)} раз: возьмите кусок длиннее или включите replace_all", "text_not_unique")
        for start, end in reversed(spans if every else spans[:1]):
            text = text[:start] + new + text[end:]
        done += len(spans) if every else 1
    return text, done


def replace_lines(text: str, start: int, end: int, new: str) -> str:
    """Заменить строки start..end (с 1, включительно) на new; end = start - 1 вставляет перед строкой start."""
    lines = text.split("\n")
    if start < 1 or end < start - 1 or start > len(lines) + 1:
        raise _err(f"Строки {start}–{end} вне файла (в нём {len(lines)} строк)", "bad_range")
    inserted = new.replace("\r\n", "\n").split("\n") if new != "" else []
    return "\n".join(lines[:start - 1] + inserted + lines[end:])


# ── docx / pptx: текст внутри абзацев ─────────────────────────────────────────

def _parts(names: list[str], ext: str) -> list[str]:
    pattern = _DOC_PARTS if ext == ".docx" else _SLIDE_PART
    found = [n for n in names if pattern.match(n)]
    return sorted(found, key=lambda n: [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", n)])


def _paragraphs(xml: str, prefix: str):
    para_re, text_re = _PARAGRAPH[prefix]
    for par in para_re.finditer(xml):
        segs = list(text_re.finditer(par.group(0)))
        if segs:
            yield par, segs


def office_text(data: bytes, ext: str) -> str:
    prefix = "w" if ext == ".docx" else "a"
    out: list[str] = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in _parts(z.namelist(), ext):
            xml = z.read(name).decode("utf-8", "replace")
            if ext == ".pptx":
                out.append(f"## {Path(name).stem}")
            out.extend("".join(html.unescape(m.group(2)) for m in segs) for _, segs in _paragraphs(xml, prefix))
    return "\n".join(out)


def _edit_xml(xml: str, prefix: str, old: str, new: str, budget: list[int]) -> tuple[str, int]:
    """Заменить old на new внутри абзацев. budget[0] — сколько замен ещё можно сделать (1 — только первую)."""
    result, last, count = [], 0, 0
    for par, segs in _paragraphs(xml, prefix):
        texts = [html.unescape(m.group(2)) for m in segs]
        joined = "".join(texts)
        spans, _ = textmatch.spans(joined, old)
        spans = spans[:max(0, budget[0])]
        if not spans:
            continue
        starts = [sum(len(t) for t in texts[:i]) for i in range(len(texts))]
        for s, e in reversed(spans):
            i = max(k for k in range(len(texts)) if starts[k] <= s)
            j = max(k for k in range(len(texts)) if starts[k] < e) if e > s else i
            tail = texts[j][e - starts[j]:]
            texts[i] = texts[i][:s - starts[i]] + new + (tail if i == j else "")
            for k in range(i + 1, j):
                texts[k] = ""
            if j > i:
                texts[j] = tail
        budget[0] -= len(spans)
        count += len(spans)
        rebuilt, pos, body = [], 0, par.group(0)
        for m, text in zip(segs, texts):
            opening = m.group(1)
            if prefix == "w" and "xml:space" not in opening and text != text.strip():
                opening = opening[:-1] + ' xml:space="preserve">'
            rebuilt.append(body[pos:m.start()] + opening + escape(text) + m.group(3))
            pos = m.end()
        rebuilt.append(body[pos:])
        result.append(xml[last:par.start()] + "".join(rebuilt))
        last = par.end()
    result.append(xml[last:])
    return "".join(result), count


def _rewrite(data: bytes, changed: dict[str, bytes]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            dst.writestr(info, changed.get(info.filename, src.read(info.filename)))
    return out.getvalue()


def office_replace(data: bytes, ext: str, edits: list[dict[str, Any]], default_all: bool = False) -> tuple[bytes, int]:
    """Замены текста в docx/pptx внутри абзаца (между абзацами и слайдами не ходят). Оформление и картинки остаются."""
    prefix = "w" if ext == ".docx" else "a"
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = _parts(z.namelist(), ext)
        xmls = {n: z.read(n).decode("utf-8") for n in names}
    total = 0
    for edit in edits:
        old, new = str(edit["old_text"]), str(edit["new_text"])
        if "\n" in old or "\n" in new:
            raise _err("В docx и pptx замена работает внутри абзаца: без переносов строк (новые абзацы — mode=append)")
        every = bool(edit.get("replace_all", default_all))
        found = sum(_edit_xml(x, prefix, old, new, [10**9])[1] for x in xmls.values())
        if not found:
            joined = "\n".join(office_text(data, ext).split("\n"))
            raise _err(f"Такого текста в файле нет. {textmatch.explain_miss(joined, old)}", "text_not_found")
        if found > 1 and not every:
            raise _err(f"Текст встречается {found} раз: возьмите кусок длиннее или включите replace_all", "text_not_unique")
        budget = [10**9 if every else 1]
        for name in names:
            if budget[0] > 0:
                xmls[name], _ = _edit_xml(xmls[name], prefix, old, new, budget)
        total += found if every else 1
    return _rewrite(data, {n: x.encode("utf-8") for n, x in xmls.items()}), total


def docx_append(data: bytes, text: str) -> bytes:
    """Дописать абзацы в конец документа Word (каждая строка — абзац)."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    paragraphs = "".join(f'<w:p><w:r><w:t xml:space="preserve">{escape(line)}</w:t></w:r></w:p>' for line in text.replace("\r\n", "\n").split("\n"))
    cut = xml.rfind("<w:sectPr")
    cut = cut if cut >= 0 and xml.find("</w:body>", cut) >= 0 else xml.rfind("</w:body>")
    if cut < 0:
        raise _err("В docx нет тела документа")
    return _rewrite(data, {"word/document.xml": (xml[:cut] + paragraphs + xml[cut:]).encode("utf-8")})


# ── xlsx ──────────────────────────────────────────────────────────────────────

def xlsx_edit(data: bytes, cells: list[dict[str, Any]], append_rows: list[dict[str, Any]]) -> tuple[bytes, int]:
    """Записать значения в ячейки и/или дописать строки. Формулы — строкой с «=». Диаграммы и картинки книги openpyxl не сохраняет."""
    import openpyxl
    from openpyxl.utils.cell import coordinate_from_string

    book = openpyxl.load_workbook(io.BytesIO(data))

    def sheet_of(name: Any):
        if not name:
            return book.worksheets[0]
        if str(name) not in book.sheetnames:
            raise _err(f"Листа «{name}» нет. Есть: {', '.join(book.sheetnames)}", "not_found")
        return book[str(name)]

    changed = 0
    for cell in cells:
        ref = str(cell.get("ref") or "").upper()
        try:
            coordinate_from_string(ref)
        except Exception as exc:  # noqa: BLE001 — openpyxl бросает разные исключения на кривой адрес
            raise _err(f"Адрес ячейки «{ref}» не читается: нужен вид B2") from exc
        sheet_of(cell.get("sheet"))[ref] = cell.get("value")
        changed += 1
    for chunk in append_rows:
        sheet = sheet_of(chunk.get("sheet"))
        for row in chunk.get("rows") or []:
            sheet.append(list(row))
            changed += 1
    out = io.BytesIO()
    book.save(out)
    return out.getvalue(), changed
