"""Инструменты MCP «Офиса»: что агент может делать с заметками, документами, таблицами, презентациями и папками.

Каждый вызов идёт в два слоя проверок:
  1. доступ ключа (keys.KeyContext.scope): уровень (read / edit / create), виды, папки, чужие материалы. Материал
     вне доступа для агента не существует — ответ тот же, что на несуществующий;
  2. права человека: инструменты зовут обработчики интерфейса (workspace/router.py, workspace/folders.py) от его
     имени — права, история версий и живые события коллегам те же.

Правки бережные: перед каждой — версия с пометкой «До правки агента «…»» (вернуть можно из истории), запись — с
проверкой, что материал не изменили, пока агент думал (иначе — «перечитайте»). Сверх событий коллегам сообщаем и
самому человеку: правка агента для него — чужая, открытая заметка должна её подтянуть.

Форматы для агента: заметка — Markdown (вкладки — строками `<!-- shar-tab: Название -->`), документ — Markdown или
чистый текст (docformat.py), таблица — листы со строками ячеек, презентация — только текст.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import re
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException

from app.core.db import db
from app.modules.mcp import docformat
from app.modules.mcp.keys import KeyContext
from app.modules.workspace import folders as ws_folders
from app.modules.workspace import router as ws
from app.modules.workspace import store

log = logging.getLogger("shar.mcp")

KIND_NAMES = {"note": "заметка", "document": "документ", "table": "таблица", "presentation": "презентация"}
LEVELS = {"read": 0, "edit": 1, "create": 2}
MAX_TABLE_ROWS = 500
MAX_TABLE_COLS = 50
MAX_CHARS = 60_000
HIDDEN = "Материал не найден или этому ключу он не открыт"
_CELL = re.compile(r"^[A-Z]{1,3}[1-9][0-9]{0,6}$")


class ToolError(Exception):
    """Ошибка, которую агент должен увидеть текстом (isError), а не сбоем протокола."""


def _call(fn: Callable[..., Any], *args: Any) -> Any:
    try:
        return fn(*args)
    except HTTPException as exc:
        raise ToolError(str(exc.detail)) from exc
    except store.WorkspaceError as exc:
        raise ToolError(exc.message) from exc


# ── доступ ключа ────────────────────────────────────────────────────────────

class Access:
    """Доступ ключа к «Офису» на время одного вызова: папки раскрыты во вложенные, видимое человеку посчитано."""

    def __init__(self, ctx: KeyContext):
        self.ctx = ctx
        self.me = ctx.me
        self.level = LEVELS[ctx.scope["access"]]
        self.kinds = set(ctx.scope["kinds"])
        self.shared = ctx.scope["shared"]
        self.folders = ws_folders._folders(self.me.user_id)
        by_parent: dict[str, list[str]] = {}
        for f in self.folders:
            by_parent.setdefault(f.get("parentId") or "", []).append(f["id"])
        self.allowed: set[str] | None = None
        if ctx.scope["folders"] is not None:
            self.allowed = set()
            todo = list(ctx.scope["folders"])
            while todo:
                fid = todo.pop()
                if fid not in self.allowed:
                    self.allowed.add(fid)
                    todo += by_parent.get(fid, [])
        names = {f["id"]: f for f in self.folders}

        def path(f: dict[str, Any], depth: int = 0) -> str:
            parent = names.get(f.get("parentId") or "")
            return f"{path(parent, depth + 1)} / {f['title']}" if parent and depth < 16 else f["title"]

        self.paths = {f["id"]: path(f) for f in self.folders}

    def need(self, level: str, what: str) -> None:
        if self.level < LEVELS[level]:
            raise ToolError(f"Этому ключу нельзя {what}: в настройках MCP ему дан доступ «{self.ctx.scope['access']}»")

    def folder_ok(self, folder_id: str | None) -> bool:
        return self.allowed is None or (folder_id is not None and str(folder_id) in self.allowed)

    def target_folder(self, folder_id: Any) -> str | None:
        """Куда класть новое: при доступе к выбранным папкам — только в них, и папку указывать обязательно."""
        folder = str(folder_id) if folder_id else None
        if self.allowed is not None and not self.folder_ok(folder):
            raise ToolError("Этому ключу открыты только выбранные папки: укажите folder_id одной из них (list_folders)")
        if folder and folder not in self.paths:
            raise ToolError("Папка не найдена")
        return folder

    def visible(self, kind: str, owner_id: str, folder_id: str | None) -> bool:
        return kind in self.kinds and (self.shared or str(owner_id) == self.me.user_id) and self.folder_ok(folder_id)

    def item_folder(self, item_id: str) -> str | None:
        """Папка материала для человека — по тем же правилам, что в списке: своя раскладка, иначе папка владельца,
        если она открыта человеку."""
        shared_ids = list(store.shared_folder_roles(self.me.user_id).keys())
        row = db.conn.fetch_one(
            "SELECT COALESCE(f.folder_id, CASE WHEN ofo.folder_id = ANY(%s) THEN ofo.folder_id END)::text AS folder_id "
            "FROM workspace_items i LEFT JOIN workspace_item_folder f ON f.item_id = i.id AND f.user_id = %s "
            "LEFT JOIN workspace_item_folder ofo ON ofo.item_id = i.id AND ofo.user_id = i.owner_id WHERE i.id = %s",
            (shared_ids, self.me.user_id, int(item_id)))
        return row["folder_id"] if row else None

    def load(self, item_id: Any, *, content: bool = True) -> dict[str, Any]:
        """Материал, если он открыт и человеку, и ключу. Иначе — как будто его нет. Отметку «просмотрено» не ставим:
        «Новые для вас» — для человека, а не для агента."""
        item_id = str(item_id or "")
        try:
            row = store.get_visible(item_id, self.me.user_id, content=content)
        except store.WorkspaceError:
            raise ToolError(HIDDEN) from None
        folder = self.item_folder(item_id)
        if not self.visible(row["kind"], row["owner_id"], folder):
            raise ToolError(HIDDEN)
        item = store.present(row, self.me.user_id, with_content=content)
        item["folderId"] = folder
        return item


def _brief(item: dict[str, Any], access: Access) -> dict[str, Any]:
    return {
        "id": item["id"], "kind": item["kind"], "title": item["title"] or "Без названия",
        "folderId": item.get("folderId"), "folder": access.paths.get(item.get("folderId") or "", ""),
        "updatedAt": item["updatedAt"], "owner": item.get("ownerName") or "", "mine": str(item.get("ownerId")) == access.me.user_id,
        "canEdit": bool(item.get("canEdit")) and access.level >= LEVELS["edit"], "snippet": item.get("snippet") or "",
    }


def _notify_self(access: Access, item_id: str, kind: str, *, content: bool) -> None:
    """Правка агента — и для самого человека событие: список перестроится, открытый материал подтянет правку."""
    try:
        from app.core.realtime import sse_manager

        live = store.get_row(item_id, full=False)
        if not live:
            return
        if content:
            sse_manager.push(access.me.user_id, {"type": "workspace_changed", "reason": "content", "itemId": item_id, "kind": kind,
                                                 "updatedAt": live["updated_at"], "by": f"Агент «{access.ctx.key_name}»", "byId": "mcp"})
        store.announce({access.me.user_id}, live, "changed")
    except Exception as exc:  # noqa: BLE001 — событие лишь удобство, не повод ломать ответ агенту
        log.warning("mcp: could not notify %s about %s: %s", access.me.user_id, item_id, exc)


def _write(access: Access, item: dict[str, Any], **fields: Any) -> None:
    """Записать правку агента: версия «до» с пометкой, запись с проверкой, что материал не изменили тем временем."""
    if not item.get("canEdit"):
        raise ToolError("Этот материал вам открыт только для просмотра")
    if "content" in fields:
        row = store.get_row(item["id"])
        if row:
            store.snapshot(row, access.me.user_id, force=True, label=f"До правки агента «{access.ctx.key_name}»", keep_object=True)
    patch = ws.ItemPatch(**fields, **({"baseUpdatedAt": item["updatedAt"]} if "content" in fields else {}))
    try:
        _call(ws.patch_item, item["id"], patch, access.me)
    except ToolError as exc:
        if "изменили" in str(exc):
            raise ToolError("Материал изменили, пока агент работал: перечитайте его (read_item) и повторите правку") from exc
        raise
    _notify_self(access, item["id"], item["kind"], content="content" in fields or "title" in fields)


def _create(access: Access, kind: str, title: str, content: str, folder_id: Any) -> dict[str, Any]:
    access.need("create", "создавать материалы")
    if kind not in access.kinds:
        raise ToolError(f"Этому ключу не открыты материалы вида «{KIND_NAMES[kind]}»")
    folder = access.target_folder(folder_id)
    item = _call(ws.create_item, ws.ItemCreate(kind=kind, title=title, content=content), access.me)["item"]
    if folder:
        _call(ws_folders.place_item, item["id"], ws_folders.PlaceBody(folderId=folder), access.me)
    _notify_self(access, item["id"], kind, content=False)
    return {"id": item["id"], "kind": kind, "title": item["title"], "folderId": folder}


def _page(text: str, args: dict[str, Any]) -> dict[str, Any]:
    offset = max(0, int(args.get("offset") or 0))
    limit = max(1000, min(int(args.get("max_chars") or MAX_CHARS), MAX_CHARS))
    part = text[offset:offset + limit]
    out: dict[str, Any] = {"content": part}
    if offset + limit < len(text):
        out.update(truncated=True, nextOffset=offset + limit, totalChars=len(text))
    return out


def _table_rows(content: str) -> list[dict[str, Any]]:
    from openpyxl import load_workbook

    book = load_workbook(io.BytesIO(base64.b64decode(content)), read_only=True, data_only=True)
    sheets = []
    for sheet in book.worksheets:
        rows: list[list[Any]] = []
        for row in sheet.iter_rows(max_row=MAX_TABLE_ROWS, max_col=MAX_TABLE_COLS, values_only=True):
            rows.append(["" if v is None else (v if isinstance(v, (int, float, bool)) else str(v)) for v in row])
        while rows and not any(str(v).strip() for v in rows[-1]):
            rows.pop()
        # Пустые столбцы справа не нужны агенту (read_only отдаёт строки до max_col).
        width = max((max((i + 1 for i, v in enumerate(r) if str(v).strip()), default=0) for r in rows), default=0)
        sheets.append({"name": sheet.title, "rows": [r[:width] for r in rows], "truncated": (sheet.max_row or 0) > MAX_TABLE_ROWS})
    return sheets


def _cell_value(value: Any) -> Any:
    return value if value is None or isinstance(value, (int, float, bool)) else str(value)


def _new_table(sheets: list[dict[str, Any]]) -> str:
    from openpyxl import Workbook

    book = Workbook()
    book.remove(book.active)
    for index, sheet in enumerate(sheets or [{"name": "Лист1", "rows": []}]):
        target = book.create_sheet(title=(str(sheet.get("name") or f"Лист{index + 1}"))[:31])
        for row in (sheet.get("rows") or [])[:MAX_TABLE_ROWS * 4]:
            target.append([_cell_value(cell) for cell in list(row)[:MAX_TABLE_COLS * 4]])
    out = io.BytesIO()
    book.save(out)
    return base64.b64encode(out.getvalue()).decode("ascii")


# ── инструменты ─────────────────────────────────────────────────────────────

def list_items(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    kind = args.get("kind") or None
    if kind and kind not in store.KINDS:
        raise ToolError("kind: note, document, table или presentation")
    if kind and kind not in access.kinds:
        return {"items": [], "total": 0}
    items = _call(ws.list_items, kind, str(args.get("query") or ""), False, 1000, access.me)["items"]
    items = [i for i in items if access.visible(i["kind"], i["ownerId"], i.get("folderId"))]
    if args.get("folder_id"):
        items = [i for i in items if (i.get("folderId") or "") == str(args["folder_id"])]
    offset = max(0, int(args.get("offset") or 0))
    limit = max(1, min(int(args.get("limit") or 50), 200))
    return {"items": [_brief(i, access) for i in items[offset:offset + limit]], "total": len(items)}


def list_folders(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    shown = [f for f in access.folders if access.folder_ok(f["id"])]
    ids = {f["id"] for f in shown}
    return {"folders": [{"id": f["id"], "title": f["title"], "parentId": f.get("parentId") if f.get("parentId") in ids else None,
                         "path": access.paths[f["id"]], "mine": f.get("role") == "owner",
                         "counts": {k: n for k, n in (f.get("counts") or {}).items() if k in access.kinds}} for f in shown],
            "restricted": access.allowed is not None}


def read_item(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    item = access.load(args.get("id"))
    content = item.get("content") or ""
    out: dict[str, Any] = {"id": item["id"], "kind": item["kind"], "title": item["title"], "updatedAt": item["updatedAt"],
                           "folder": access.paths.get(item.get("folderId") or "", ""),
                           "canEdit": bool(item.get("canEdit")) and access.level >= LEVELS["edit"]}
    if item["kind"] == "note":
        out.update(format="markdown", **_page(content, args))
    elif item["kind"] == "document":
        try:
            snapshot = json.loads(content)
        except ValueError:
            snapshot = docformat.empty_snapshot(item["title"])
        plain = args.get("format") == "text"
        text = docformat.snapshot_text(snapshot) if plain else docformat.snapshot_to_markdown(snapshot)
        out.update(format="text" if plain else "markdown", **_page(text, args))
    elif item["kind"] == "table":
        try:
            out.update(format="sheets", sheets=_table_rows(content))
        except Exception as exc:
            raise ToolError(f"Таблицу не удалось прочитать: {exc}") from exc
    else:
        out.update(format="text", **_page(store.text_of(item["kind"], content), args))
    return out


def create_note(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    return _create(access, "note", str(args.get("title") or ""), str(args.get("markdown") or ""), args.get("folder_id"))


def update_note(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    access.need("edit", "править материалы")
    item = access.load(args.get("id"))
    if item["kind"] != "note":
        raise ToolError(f"Это {KIND_NAMES[item['kind']]}, а не заметка")
    text = str(args.get("markdown") or "")
    if (args.get("mode") or "replace") == "append":
        base = item.get("content") or ""
        text = f"{base.rstrip()}\n\n{text}" if base.strip() else text
    _write(access, item, content=text, **({"title": str(args["title"])} if args.get("title") else {}))
    return {"id": item["id"], "ok": True}


def edit_note(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    access.need("edit", "править материалы")
    item = access.load(args.get("id"))
    if item["kind"] != "note":
        raise ToolError(f"Это {KIND_NAMES[item['kind']]}, а не заметка")
    old, new = str(args.get("old_text") or ""), str(args.get("new_text") or "")
    content = item.get("content") or ""
    count = content.count(old) if old else 0
    if not count:
        raise ToolError("Такого текста в заметке нет: перечитайте её (read_item) и возьмите точный кусок")
    if count > 1 and not args.get("replace_all"):
        raise ToolError(f"Текст встречается {count} раз: возьмите кусок длиннее или включите replace_all")
    _write(access, item, content=content.replace(old, new) if args.get("replace_all") else content.replace(old, new, 1))
    return {"id": item["id"], "replaced": count if args.get("replace_all") else 1}


def create_document(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    title = str(args.get("title") or "")
    snapshot = docformat.markdown_to_snapshot(title, str(args.get("markdown") or ""))
    return _create(access, "document", title, json.dumps(snapshot, ensure_ascii=False), args.get("folder_id"))


def _document(access: Access, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    access.need("edit", "править материалы")
    item = access.load(args.get("id"))
    if item["kind"] != "document":
        raise ToolError(f"Это {KIND_NAMES[item['kind']]}, а не документ")
    try:
        return item, json.loads(item.get("content") or "")
    except ValueError:
        return item, docformat.empty_snapshot(item["title"])


def update_document(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    item, snapshot = _document(access, args)
    markdown = str(args.get("markdown") or "")
    if (args.get("mode") or "append") == "append":
        snapshot = docformat.append_markdown(snapshot, markdown)
    else:
        snapshot = docformat.markdown_to_snapshot(item["title"], markdown)
    _write(access, item, content=json.dumps(snapshot, ensure_ascii=False))
    return {"id": item["id"], "ok": True}


def edit_document(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    item, snapshot = _document(access, args)
    try:
        count = docformat.replace_text(snapshot, str(args.get("old_text") or ""), str(args.get("new_text") or ""),
                                       replace_all=bool(args.get("replace_all")))
    except docformat.TextNotFound as exc:
        raise ToolError(str(exc)) from exc
    _write(access, item, content=json.dumps(snapshot, ensure_ascii=False))
    return {"id": item["id"], "replaced": count}


def create_table(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    sheets = args.get("sheets") or [{"name": "Лист1", "rows": args.get("rows") or []}]
    if not isinstance(sheets, list):
        raise ToolError("sheets — список листов {name, rows}")
    return _create(access, "table", str(args.get("title") or ""), _new_table(sheets), args.get("folder_id"))


def update_table(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    from openpyxl import load_workbook

    access.need("edit", "править материалы")
    item = access.load(args.get("id"))
    if item["kind"] != "table":
        raise ToolError(f"Это {KIND_NAMES[item['kind']]}, а не таблица")
    cells = args.get("cells") or []
    rows = args.get("append_rows") or []
    if not cells and not rows:
        raise ToolError("Нечего менять: передайте cells и/или append_rows")
    if len(cells) > 2000 or len(rows) > 2000:
        raise ToolError("За раз — не больше 2000 ячеек и 2000 строк")
    book = load_workbook(io.BytesIO(base64.b64decode(item.get("content") or "")))
    name = args.get("sheet")
    if name and name not in book.sheetnames:
        raise ToolError(f"Нет листа «{name}». Листы: {', '.join(book.sheetnames)}")
    sheet = book[name] if name else book.worksheets[0]
    for cell in cells:
        ref = str((cell or {}).get("ref") or "").upper()
        if not _CELL.match(ref):
            raise ToolError(f"Неверный адрес ячейки «{ref}»: нужен вид B2")
        sheet[ref] = _cell_value(cell.get("value"))
    for row in rows:
        sheet.append([_cell_value(v) for v in list(row)[:MAX_TABLE_COLS * 4]])
    out = io.BytesIO()
    book.save(out)
    _write(access, item, content=base64.b64encode(out.getvalue()).decode("ascii"))
    return {"id": item["id"], "sheet": sheet.title, "cells": len(cells), "appendedRows": len(rows)}


def rename_item(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    access.need("edit", "править материалы")
    item = access.load(args.get("id"), content=False)
    title = str(args.get("title") or "").strip()
    if not title:
        raise ToolError("Нужно название")
    _write(access, item, title=title)
    return {"id": item["id"], "title": title[:200]}


def move_item(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    access.need("create", "раскладывать материалы по папкам")
    item = access.load(args.get("id"), content=False)
    folder = access.target_folder(args.get("folder_id"))
    _call(ws_folders.place_item, item["id"], ws_folders.PlaceBody(folderId=folder), access.me)
    return {"id": item["id"], "folderId": folder}


def create_folder(access: Access, args: dict[str, Any]) -> dict[str, Any]:
    access.need("create", "создавать папки")
    parent = access.target_folder(args.get("parent_id"))
    body = ws_folders.FolderBody(title=str(args.get("title") or "").strip() or "Новая папка", parentId=parent)
    folder = _call(ws_folders.create_folder, body, access.me)["folder"]
    return {"id": folder["id"], "title": folder["title"], "parentId": folder.get("parentId")}


_ID = {"type": "string", "description": "id материала (из list_items)"}
_FOLDER = {"type": "string", "description": "id папки (из list_folders). Если ключу открыты только выбранные папки — обязателен"}
_PAGE = {"offset": {"type": "integer", "minimum": 0, "description": "с какого символа (для длинных материалов, см. nextOffset)"},
         "max_chars": {"type": "integer", "minimum": 1000, "maximum": MAX_CHARS}}

TOOLS: list[dict[str, Any]] = [
    {"name": "list_items", "handler": list_items, "level": "read",
     "description": "Материалы «Офиса», открытые этому ключу: заметки, документы, таблицы, презентации. Поиск по названию и тексту, фильтр по виду и папке.",
     "inputSchema": {"type": "object", "properties": {
         "kind": {"type": "string", "enum": list(store.KINDS)},
         "query": {"type": "string", "description": "слова из названия или текста"},
         "folder_id": {"type": "string", "description": "только материалы этой папки"},
         "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50}, "offset": {"type": "integer", "minimum": 0}}}},
    {"name": "list_folders", "handler": list_folders, "level": "read",
     "description": "Папки, открытые этому ключу, с путём и числом материалов каждого вида.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "read_item", "handler": read_item, "level": "read",
     "description": "Содержимое материала. Заметка — Markdown; документ — Markdown (format=text — чистый текст, по нему ищет edit_document); "
                    "таблица — листы со строками ячеек (до 500 строк); презентация — текст слайдов. Длинное — частями (offset, nextOffset).",
     "inputSchema": {"type": "object", "properties": {"id": _ID, "format": {"type": "string", "enum": ["markdown", "text"]}, **_PAGE}, "required": ["id"]}},
    {"name": "edit_note", "handler": edit_note, "level": "edit",
     "description": "Точечная правка заметки: заменить кусок old_text (точный текст из read_item) на new_text. Остальное не трогается.",
     "inputSchema": {"type": "object", "properties": {"id": _ID, "old_text": {"type": "string"}, "new_text": {"type": "string"},
                                                     "replace_all": {"type": "boolean", "default": False}}, "required": ["id", "old_text", "new_text"]}},
    {"name": "update_note", "handler": update_note, "level": "edit",
     "description": "Переписать заметку целиком (mode=replace; строки вкладок `<!-- shar-tab: … -->` сохраняйте) или дописать в конец (mode=append).",
     "inputSchema": {"type": "object", "properties": {"id": _ID, "markdown": {"type": "string"}, "mode": {"type": "string", "enum": ["replace", "append"], "default": "replace"},
                                                     "title": {"type": "string", "description": "новое название (необязательно)"}}, "required": ["id", "markdown"]}},
    {"name": "edit_document", "handler": edit_document, "level": "edit",
     "description": "Точечная правка документа с сохранением оформления: заменить old_text на new_text внутри абзаца. "
                    "Текст — точный, без разметки Markdown (read_item с format=text), без переносов строк.",
     "inputSchema": {"type": "object", "properties": {"id": _ID, "old_text": {"type": "string"}, "new_text": {"type": "string"},
                                                     "replace_all": {"type": "boolean", "default": False}}, "required": ["id", "old_text", "new_text"]}},
    {"name": "update_document", "handler": update_document, "level": "edit",
     "description": "Дописать Markdown в конец документа с сохранением оформления (mode=append, по умолчанию) или пересобрать документ из Markdown "
                    "(mode=replace: сложное оформление, таблицы и картинки пропадут).",
     "inputSchema": {"type": "object", "properties": {"id": _ID, "markdown": {"type": "string"}, "mode": {"type": "string", "enum": ["append", "replace"], "default": "append"}},
                     "required": ["id", "markdown"]}},
    {"name": "update_table", "handler": update_table, "level": "edit",
     "description": "Изменить таблицу: значения ячеек по адресам (cells: [{ref: \"B2\", value}], формула — строкой с «=») и/или строки в конец листа (append_rows). "
                    "Лист — sheet (по умолчанию первый).",
     "inputSchema": {"type": "object", "properties": {
         "id": _ID, "sheet": {"type": "string"},
         "cells": {"type": "array", "items": {"type": "object", "properties": {"ref": {"type": "string"}, "value": {}}, "required": ["ref"]}},
         "append_rows": {"type": "array", "items": {"type": "array", "items": {}}}}, "required": ["id"]}},
    {"name": "rename_item", "handler": rename_item, "level": "edit", "description": "Переименовать материал.",
     "inputSchema": {"type": "object", "properties": {"id": _ID, "title": {"type": "string"}}, "required": ["id", "title"]}},
    {"name": "create_note", "handler": create_note, "level": "create",
     "description": "Создать заметку из Markdown. Вкладки — строкой `<!-- shar-tab: Название -->` перед текстом вкладки.",
     "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}, "markdown": {"type": "string"}, "folder_id": _FOLDER},
                     "required": ["title", "markdown"]}},
    {"name": "create_document", "handler": create_document, "level": "create",
     "description": "Создать документ (листы A4) из Markdown: заголовки #–###, **жирный**, *курсив*, `код`, ссылки, списки.",
     "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}, "markdown": {"type": "string"}, "folder_id": _FOLDER},
                     "required": ["title", "markdown"]}},
    {"name": "create_table", "handler": create_table, "level": "create",
     "description": "Создать таблицу: rows — строки ячеек одного листа или sheets — несколько листов {name, rows}. Первая строка обычно — заголовки.",
     "inputSchema": {"type": "object", "properties": {
         "title": {"type": "string"}, "folder_id": _FOLDER,
         "rows": {"type": "array", "items": {"type": "array", "items": {}}},
         "sheets": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "rows": {"type": "array", "items": {"type": "array", "items": {}}}}}}},
         "required": ["title"]}},
    {"name": "move_item", "handler": move_item, "level": "create",
     "description": "Положить материал в папку или вынуть из папок (folder_id не указан — если ключу открыт весь «Офис»).",
     "inputSchema": {"type": "object", "properties": {"id": _ID, "folder_id": _FOLDER}, "required": ["id"]}},
    {"name": "create_folder", "handler": create_folder, "level": "create",
     "description": "Создать свою папку (parent_id — внутри другой папки; если ключу открыты только выбранные папки — обязателен).",
     "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}, "parent_id": {"type": "string"}}, "required": ["title"]}},
]

BY_NAME = {t["name"]: t for t in TOOLS}


def describe(ctx: KeyContext) -> list[dict[str, Any]]:
    """Список инструментов для tools/list — только те, что этому ключу можно: агент не тратит попытки на запретное."""
    level = LEVELS[ctx.scope["access"]]
    return [{"name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"],
             "annotations": {"readOnlyHint": t["level"] == "read", "destructiveHint": False, "idempotentHint": t["level"] == "read"}}
            for t in TOOLS if LEVELS[t["level"]] <= level]


def summary(ctx: KeyContext) -> str:
    """Что открыто ключу — словами, для агента (instructions при initialize)."""
    scope = ctx.scope
    access = {"read": "только чтение", "edit": "чтение и правка существующего", "create": "чтение, правка, создание и раскладка по папкам"}[scope["access"]]
    kinds = ", ".join(KIND_NAMES[k] for k in scope["kinds"]) or "ничего"
    where = "весь «Офис»" if scope["folders"] is None else "только выбранные папки и вложенные в них (list_folders)"
    whose = "свои материалы и те, которыми поделились" if scope["shared"] else "только свои материалы"
    return f"Доступ ключа «{ctx.key_name}»: {access}; виды: {kinds}; где: {where}; {whose}."


def run(ctx: KeyContext, tool: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    access = Access(ctx)
    if LEVELS[tool["level"]] > access.level:
        raise ToolError(f"Этому ключу инструмент {tool['name']} не открыт")
    return tool["handler"](access, args)
