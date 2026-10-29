"""Инструменты MCP для раздела «Файлы» (облако Шара, S3): найти, прочитать, положить, разложить, удалить.

Как в MBOX (storage_*): агент видит то же, что человек, — свои файлы и открытые ему; меняет только своё. Обработчики —
те же, что у интерфейса (cloud/router.py): живое обновление у всех, кто смотрит папку, приходит само.

Чтение отдаёт текст для форматов, где он есть (txt, md, csv, json, html, docx, xlsx, pdf), и прямую ссылку на файл —
бинарное (картинки, архивы) нода может скачать сама. Запись — текст или base64 до 10 МБ: файл ложится туда же, куда
и загруженный человеком (S3, без S3 — диск сервера).
"""

from __future__ import annotations

import base64
import io
import json
import re
import zipfile
from pathlib import Path
from typing import Any

from app.core.db import db
from app.core.storage import UPLOAD_DIR, new_upload_name, s3_storage
from app.modules.cloud import router as cloud

MAX_WRITE = 10 * 1024 * 1024
MAX_READ = 25 * 1024 * 1024
MAX_CHARS = 60_000
TEXT_EXT = {".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".yml", ".yaml", ".log", ".ini", ".sql", ".py", ".js", ".ts", ".css"}
MIME = {".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".html": "text/html",
        ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic"}


def _err(text: str) -> Exception:
    from app.modules.mcp.tools import ToolError

    return ToolError(text)


def _call(fn, *args, **kwargs):
    from app.modules.mcp.tools import _call as call

    return call(lambda: fn(*args, **kwargs))


def absolute(url: str) -> str:
    """Ссылка /api/uploads/… для ноды — с доменом Шара (SHAR_PUBLIC_URL), иначе ей не скачать."""
    import os

    origin = os.getenv("SHAR_PUBLIC_URL", "").strip().rstrip("/")
    return f"{origin}{url}" if url.startswith("/") and origin else url


def _file_view(f: dict[str, Any], me: str) -> dict[str, Any]:
    return {"id": str(f.get("id")), "name": f.get("name") or "", "folderId": f.get("folderId") or None, "size": f.get("size") or 0,
            "type": f.get("mimeType") or f.get("fileType") or "", "updatedAt": f.get("updatedAt") or f.get("createdAt"),
            "mine": str(f.get("ownerId") or "") == me, "url": absolute(f.get("url") or ""), "open": f"/files?file={f.get('id')}"}


def _folder_view(f: dict[str, Any], me: str) -> dict[str, Any]:
    return {"id": str(f.get("id")), "name": f.get("name") or "", "parentId": f.get("parentId") or None,
            "mine": str(f.get("ownerId") or "") == me, "open": f"/files?folder={f.get('id')}"}


def files_list(access, args: dict[str, Any]) -> dict[str, Any]:
    me = access.me
    folder = str(args.get("folder_id") or "") or None
    query = str(args.get("query") or "").lower().strip()
    if query:  # поиск — по всем видимым файлам, без папок
        files = _call(cloud.get_cloud_files, folderId=None, allFiles=True, me=me)
        hits = [f for f in files if all(w in str(f.get("name") or "").lower() for w in query.split())]
        return {"files": [_file_view(f, me.user_id) for f in hits[:100]], "total": len(hits)}
    folders = _call(cloud.get_cloud_folders, parentId=folder, me=me)
    files = _call(cloud.get_cloud_files, folderId=folder, allFiles=False, me=me)
    return {"folderId": folder, "folders": [_folder_view(f, me.user_id) for f in folders],
            "files": [_file_view(f, me.user_id) for f in files[:300]], "total": len(files)}


def _visible_file(access, file_id: str) -> dict[str, Any]:
    row = db.get_cloud_file_by_id(str(file_id or ""))
    if not row or not cloud._can_view_cloud(row, access.me):
        raise _err("Файл не найден или вам не открыт")
    return row


def _bytes(row: dict[str, Any]) -> bytes:
    key = row.get("s3_key") or ""
    name = Path(str(row.get("url") or "")).name
    if not key and name:
        key = f"uploads/{name}"
    if not key:
        raise _err("У файла нет содержимого в хранилище")
    if (row.get("size") or 0) > MAX_READ:
        raise _err("Файл больше 25 МБ: читайте по ссылке url")
    if s3_storage.enabled:
        obj = s3_storage.get_object(key)
        if obj is None:
            raise _err("Файл пропал из хранилища")
        return obj["Body"].read(MAX_READ + 1)
    path = UPLOAD_DIR / key
    if not path.exists():
        raise _err("Файл пропал из хранилища")
    return path.read_bytes()


def _xml_text(xml: str) -> str:
    xml = re.sub(r"</w:p>", "\n", xml)
    return re.sub(r"<[^>]+>", "", xml)


def extract_text(name: str, data: bytes) -> str:
    ext = Path(name).suffix.lower()
    if ext in TEXT_EXT or not ext:
        for enc in ("utf-8-sig", "cp1251"):
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue
        return data.decode("utf-8", "replace")
    if ext == ".docx":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            return _xml_text(z.read("word/document.xml").decode("utf-8", "replace"))
    if ext == ".xlsx":
        import openpyxl

        book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        out = []
        for sheet in book.worksheets:
            out.append(f"## {sheet.title}")
            for index, row in enumerate(sheet.iter_rows(values_only=True)):
                if index >= 1000:
                    out.append("…")
                    break
                out.append("\t".join("" if v is None else str(v) for v in row))
        return "\n".join(out)
    if ext == ".pdf":
        try:
            from pypdf import PdfReader  # необязательная зависимость
        except ImportError as exc:
            raise _err("Текст из PDF сервер пока не достаёт: скачайте файл по url") from exc
        return "\n\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(data)).pages[:200])
    raise _err(f"У файлов «{ext}» нет текста: скачайте по url")


def file_read(access, args: dict[str, Any]) -> dict[str, Any]:
    row = _visible_file(access, args.get("id"))
    view = _file_view({**row, "folderId": row.get("folder_id"), "ownerId": row.get("owner_id"), "mimeType": row.get("mime_type")}, access.me.user_id)
    if Path(row.get("name") or "").suffix.lower() in IMAGE_EXT:
        return {**view, "text": None, "note": "Картинка: откройте по url"}
    text = extract_text(row.get("name") or "", _bytes(row))
    offset = max(0, int(args.get("offset") or 0))
    chunk = text[offset:offset + MAX_CHARS]
    return {**view, "text": chunk, "chars": len(text), "nextOffset": offset + len(chunk) if offset + len(chunk) < len(text) else None}


def _store(name: str, content: bytes) -> tuple[str, str]:
    """Положить байты как обычную загрузку Шара: ключ uploads/<уникальное имя>, ссылка /api/uploads/<имя>."""
    unique = new_upload_name(name)
    key = f"uploads/{unique}"
    ext = Path(name).suffix.lower()
    if s3_storage.enabled:
        s3_storage.upload_fileobj(io.BytesIO(content), key, MIME.get(ext, "application/octet-stream"))
    else:
        path = UPLOAD_DIR / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return key, f"/api/uploads/{unique}"


def file_write(access, args: dict[str, Any]) -> dict[str, Any]:
    name = Path(str(args.get("name") or "").strip()).name
    if not name:
        raise _err("Нужно имя файла с расширением (name)")
    if args.get("base64"):
        try:
            content = base64.b64decode(str(args["base64"]), validate=True)
        except ValueError as exc:
            raise _err("base64 не читается") from exc
    elif "text" in args:
        content = str(args.get("text") or "").encode("utf-8")
    elif "json" in args:
        content = json.dumps(args["json"], ensure_ascii=False, indent=2).encode("utf-8")
    else:
        raise _err("Нужно содержимое: text, json или base64")
    if len(content) > MAX_WRITE:
        raise _err("Не больше 10 МБ за раз")
    key, url = _store(name, content)
    ext = Path(name).suffix.lower()
    meta = cloud.CloudFileMeta(name=name, url=url, s3Key=key, size=len(content), mimeType=MIME.get(ext),
                               fileType="image" if ext in IMAGE_EXT else "file", folderId=str(args.get("folder_id") or "") or None)
    created = _call(cloud.create_cloud_file, meta, access.me)
    return {"created": _file_view(created, access.me.user_id)}


def file_update(access, args: dict[str, Any]) -> dict[str, Any]:
    row = _visible_file(access, args.get("id"))
    if str(row.get("owner_id") or "") != access.me.user_id:
        raise _err("Переименовать и переложить можно только свой файл")
    result = None
    if args.get("name"):
        result = _call(cloud.update_cloud_file, str(row["id"]), cloud.CloudFileUpdate(name=Path(str(args["name"])).name), access.me)
    if "folder_id" in args:
        target = str(args.get("folder_id") or "") or None
        body = cloud.CloudFileUpdate(folderId=target) if target else cloud.CloudFileUpdate(moveToRoot=True)
        result = _call(cloud.update_cloud_file, str(row["id"]), body, access.me)
    if result is None:
        raise _err("Нечего менять: name или folder_id")
    return {"updated": _file_view(result, access.me.user_id)}


def file_delete(access, args: dict[str, Any]) -> dict[str, Any]:
    if args.get("confirm") is not True:
        raise _err("Удаление файла нужно подтвердить: confirm: true (файл стирается насовсем — сначала спросите человека)")
    row = _visible_file(access, args.get("id"))
    if str(row.get("owner_id") or "") != access.me.user_id:
        raise _err("Удалить можно только свой файл")
    _call(cloud.delete_cloud_file, str(row["id"]), access.me)
    return {"id": str(row["id"]), "deleted": True}


def folder_create(access, args: dict[str, Any]) -> dict[str, Any]:
    name = str(args.get("name") or "").strip()
    if not name:
        raise _err("Нужно название папки")
    folder = _call(cloud.create_cloud_folder, cloud.CloudFolderCreate(name=name[:200], parentId=str(args.get("parent_id") or "") or None), access.me)
    return {"created": _folder_view(folder, access.me.user_id)}


_FOLDER = {"type": "string", "description": "id папки из files_list (нет — корень)"}

TOOLS: list[dict[str, Any]] = [
    {"name": "files_list", "app": "files", "handler": files_list, "level": "read",
     "description": "Раздел «Файлы» (облако Шара): папки и файлы в папке (без folder_id — корень) или поиск по имени по всем видимым файлам (query).",
     "inputSchema": {"type": "object", "properties": {"folder_id": _FOLDER, "query": {"type": "string"}}}},
    {"name": "file_read", "app": "files", "handler": file_read, "level": "read",
     "description": "Текст файла (txt, md, csv, json, html, docx, xlsx, pdf) частями по 60 000 символов (offset/nextOffset) и прямая ссылка url — "
                    "для картинок и прочего бинарного скачайте файл по ней.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "offset": {"type": "integer", "minimum": 0}}, "required": ["id"]}},
    {"name": "file_write", "app": "files", "handler": file_write, "level": "create",
     "description": "Положить новый файл в «Файлы»: text (txt, md, csv, html…), json или base64 (любой формат), до 10 МБ. "
                    "Отчёт, выгрузку, таблицу для Excel — сюда; документ для совместной правки — лучше create_document в «Офисе».",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "имя с расширением: отчёт.csv"},
                                                     "text": {"type": "string"}, "json": {}, "base64": {"type": "string"}, "folder_id": _FOLDER},
                     "required": ["name"]}},
    {"name": "file_update", "app": "files", "handler": file_update, "level": "edit",
     "description": "Переименовать свой файл (name) и/или переложить в другую папку (folder_id; пустой — в корень).",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "name": {"type": "string"}, "folder_id": {"type": ["string", "null"]}},
                     "required": ["id"]}},
    {"name": "file_delete", "app": "files", "handler": file_delete, "level": "create",
     "description": "Удалить свой файл насовсем (корзины у «Файлов» нет). Нужен confirm: true.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "confirm": {"type": "boolean"}}, "required": ["id", "confirm"]}},
    {"name": "folder_create", "app": "files", "handler": folder_create, "level": "create",
     "description": "Создать папку в «Файлах» (parent_id — внутри другой).",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "parent_id": _FOLDER}, "required": ["name"]}},
]
