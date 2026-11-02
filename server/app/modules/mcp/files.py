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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.db import db
from app.core.storage import UPLOAD_DIR, is_upload_name, new_upload_name, s3_storage
from app.modules.cloud import router as cloud
from app.modules.mcp import fileformats

MAX_WRITE = 10 * 1024 * 1024
MAX_READ = 25 * 1024 * 1024
MAX_CHARS = 60_000
DEFAULT_CHARS = 15_000
KEEP_VERSIONS = 10  # сколько прежних версий файла хранить для отката
MIME = {".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".html": "text/html",
        ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic"}


def _err(text: str, code: str = "tool_error") -> Exception:
    from app.modules.mcp.tools import ToolError

    return ToolError(text, code)


def _call(fn, *args, **kwargs):
    from app.modules.mcp.tools import _call as call

    return call(lambda: fn(*args, **kwargs))


def absolute(url: str) -> str:
    """Ссылка /api/uploads/… для ноды — с доменом Шара (SHAR_PUBLIC_URL), иначе ей не скачать."""
    import os

    origin = os.getenv("SHAR_PUBLIC_URL", "").strip().rstrip("/")
    return f"{origin}{url}" if url.startswith("/") and origin else url


def _file_view(f: dict[str, Any], me: str) -> dict[str, Any]:
    stamp = f.get("updatedAt") or f.get("updated_at") or f.get("createdAt") or f.get("created_at")
    return {"id": str(f.get("id")), "name": f.get("name") or "", "folderId": f.get("folderId") or f.get("folder_id") or None, "size": f.get("size") or 0,
            "type": f.get("mimeType") or f.get("mime_type") or f.get("fileType") or "",
            "updatedAt": stamp.isoformat() if hasattr(stamp, "isoformat") else stamp,
            "mine": str(f.get("ownerId") or f.get("owner_id") or "") == me, "url": absolute(f.get("url") or ""), "open": f"/files?file={f.get('id')}"}


def _folder_view(f: dict[str, Any], me: str) -> dict[str, Any]:
    return {"id": str(f.get("id")), "name": f.get("name") or "", "parentId": f.get("parentId") or None,
            "mine": str(f.get("ownerId") or "") == me, "open": f"/files?folder={f.get('id')}"}


def _hidden(access, file_id: Any = None, folder_id: Any = None, cache: dict | None = None) -> bool:
    """«Скрыть от агента»: сам файл или любая папка над ним (core_agents/hidden.py)."""
    from app.modules.core_agents.hidden import cloud_hidden, hidden_ids

    hidden = cache if cache is not None else hidden_ids(access.me.user_id)
    if file_id is not None and str(file_id) in hidden["file"]:
        return True
    return cloud_hidden(access.me.user_id, str(folder_id) if folder_id else None, hidden)


def files_list(access, args: dict[str, Any]) -> dict[str, Any]:
    from app.modules.core_agents.hidden import hidden_ids

    me = access.me
    hidden = hidden_ids(me.user_id)
    folder = str(args.get("folder_id") or "") or None
    if folder and _hidden(access, folder_id=folder, cache=hidden):
        raise _err("Папка не найдена")
    query = str(args.get("query") or "").lower().strip()
    if query:  # поиск — по всем видимым файлам, без папок
        files = _call(cloud.get_cloud_files, folderId=None, allFiles=True, me=me)
        hits = [f for f in files if all(w in str(f.get("name") or "").lower() for w in query.split())
                and not _hidden(access, f.get("id"), f.get("folderId"), hidden)]
        return {"files": [_file_view(f, me.user_id) for f in hits[:100]], "total": len(hits)}
    folders = [f for f in _call(cloud.get_cloud_folders, parentId=folder, me=me) if str(f.get("id")) not in hidden["cloud_folder"]]
    files = [f for f in _call(cloud.get_cloud_files, folderId=folder, allFiles=False, me=me) if str(f.get("id")) not in hidden["file"]]
    return {"folderId": folder, "folders": [_folder_view(f, me.user_id) for f in folders],
            "files": [_file_view(f, me.user_id) for f in files[:300]], "total": len(files)}


def _folder_chain(folder_id: Any) -> list[dict[str, Any]]:
    """Папка файла и все папки над ней: доступ к папке распространяется на всё внутри."""
    chain, seen = [], set()
    while folder_id and folder_id not in seen and len(chain) < 16:
        seen.add(folder_id)
        folder = db.get_cloud_folder_by_id(str(folder_id))
        if not folder:
            break
        chain.append(folder)
        folder_id = folder.get("parent_id")
    return chain


def rights(access, row: dict[str, Any]) -> str | None:
    """owner — владелец; edit — в списке редакторов файла или папки над ним; view — открыт на просмотр (человеку, отделу или
    папкой выше) либо смотрит админ; None — не виден. Те же правила, что в интерфейсе «Файлов» (CloudView.canEdit)."""
    me = access.me
    if str(row.get("owner_id") or "") == me.user_id:
        return "owner"
    dept = (db.get_user_by_id(me.user_id) or {}).get("department")
    best = None
    for node in [row, *_folder_chain(row.get("folder_id"))]:
        if me.user_id in {str(x) for x in (node.get("edit_access") or [])}:
            return "edit"
        shared = {str(x) for x in (node.get("shared_with") or [])}
        if me.user_id in shared or (dept and f"dept:{dept}" in shared):
            best = "view"
    return best or ("view" if me.is_admin else None)


def _visible_file(access, file_id: str, edit: bool = False) -> dict[str, Any]:
    row = db.get_cloud_file_by_id(str(file_id or ""))
    level = rights(access, row) if row else None
    if not level or _hidden(access, row.get("id"), row.get("folder_id")):
        raise _err("Файл не найден или вам не открыт", "not_found")
    if edit and level not in ("owner", "edit"):
        raise _err("Этот файл открыт вам только на просмотр: править его может владелец или тот, кому дали право редактирования. "
                   "Попросите владельца открыть доступ на редактирование или сохраните свою копию (file_write без id).", "permission_denied")
    return {**row, "rights": level}


def _read_key(key: str) -> bytes:
    if s3_storage.enabled:
        obj = s3_storage.get_object(key)
        if obj is None:
            raise _err("Файл пропал из хранилища")
        return obj["Body"].read(MAX_READ + 1)
    path = UPLOAD_DIR / key
    if not path.exists():
        raise _err("Файл пропал из хранилища")
    return path.read_bytes()


def _key_of(row: dict[str, Any]) -> str:
    return row.get("s3_key") or (f"uploads/{Path(str(row.get('url') or '')).name}" if row.get("url") else "")


def _bytes(row: dict[str, Any]) -> bytes:
    key = _key_of(row)
    if not key:
        raise _err("У файла нет содержимого в хранилище")
    if (row.get("size") or 0) > MAX_READ:
        raise _err("Файл больше 25 МБ: читайте по ссылке url")
    return _read_key(key)


def extract_text(name: str, data: bytes) -> str:
    ext = Path(name).suffix.lower()
    if ext in (".docx", ".pptx"):
        return fileformats.office_text(data, ext)
    if ext == ".xlsx":
        import openpyxl

        book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        out = []
        for sheet in book.worksheets:
            out.append(f"## {sheet.title}")
            # строка файла = строка листа, столбец = позиция после табуляций: по этому можно назвать ячейку для file_edit
            for index, row in enumerate(sheet.iter_rows(min_row=1, min_col=1, values_only=True)):
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
    if fileformats.looks_textual(name, data):
        return fileformats.decode(data)[0]
    raise _err(f"У файлов «{ext}» нет текста: скачайте по url")


def _edit_way(name: str, data: bytes | None = None) -> dict[str, Any]:
    """Чем файл правится на месте — чтобы агент не гадал по расширению."""
    ext = Path(name).suffix.lower()
    if ext == ".docx":
        return {"editable": True, "editWith": "file_edit: replace (внутри абзаца, оформление сохраняется) или append (новые абзацы)"}
    if ext == ".pptx":
        return {"editable": True, "editWith": "file_edit: replace (текст внутри блока слайда, оформление сохраняется)"}
    if ext == ".xlsx":
        return {"editable": True, "editWith": "file_edit: mode=cells (cells: sheet, ref, value) и append_rows; диаграммы и картинки книги не сохраняются"}
    if ext == ".pdf" or ext in IMAGE_EXT or ext in {".zip", ".rar", ".7z", ".mp3", ".mp4", ".mov"}:
        return {"editable": False, "editWith": "правке на месте не поддаётся: соберите новый файл и положите file_write с id + base64"}
    if data is not None and not fileformats.looks_textual(name, data):
        return {"editable": False, "editWith": "двоичный файл: file_write с id + base64"}
    return {"editable": True, "editWith": "file_edit: replace, lines (по номерам строк) или append"}


def file_read(access, args: dict[str, Any]) -> dict[str, Any]:
    row = _visible_file(access, args.get("id"))
    view = _file_view({**row, "folderId": row.get("folder_id"), "ownerId": row.get("owner_id"), "mimeType": row.get("mime_type")}, access.me.user_id)
    can_edit = row["rights"] in ("owner", "edit")
    view.update(rights=row["rights"], canEdit=can_edit, versions=len((row.get("metadata") or {}).get("versions") or []))
    if Path(row.get("name") or "").suffix.lower() in IMAGE_EXT:
        return {**view, "text": None, "editable": False, "note": "Картинка: откройте по url"}
    data = _bytes(row)
    text = extract_text(row.get("name") or "", data)
    way = _edit_way(row.get("name") or "", data)
    view.update(editable=way["editable"] and can_edit, editWith=way["editWith"] if can_edit else "только просмотр: править может владелец или редактор")
    if fileformats.looks_textual(row.get("name") or "", data):
        info = fileformats.decode(data)[1]
        view.update(encoding=info["encoding"], newline="CRLF" if info["newline"] == "\r\n" else "LF")
    if args.get("from_line") is not None:  # построчно, с номерами: удобно для кода и для file_edit mode=lines
        lines = text.split("\n")
        first = max(1, int(args["from_line"]))
        last = min(len(lines), int(args.get("to_line") or first + 199), first + 999)
        return {**view, "text": "\n".join(f"{n}\t{lines[n - 1]}" for n in range(first, last + 1)), "totalLines": len(lines),
                "fromLine": first, "toLine": last, "nextLine": last + 1 if last < len(lines) else None}
    offset = max(0, int(args.get("offset") or 0))
    limit = max(1000, min(int(args.get("max_chars") or DEFAULT_CHARS), MAX_CHARS))
    chunk = text[offset:offset + limit]
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


def _content(args: dict[str, Any]) -> bytes:
    if "base64" in args:
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
    return content


def _discard(key: str) -> None:
    """Удалять только созданные нами загрузки; сбой уборки не должен отменять успешную запись в БД."""
    prefix, _, name = str(key or "").partition("/")
    if prefix != "uploads" or not is_upload_name(name):
        return
    try:
        if s3_storage.enabled:
            s3_storage.delete_object(key)
        else:
            (UPLOAD_DIR / key).unlink(missing_ok=True)
    except Exception:
        pass


def discard_versions(row: dict[str, Any]) -> None:
    """Файл удалён: стереть версии, созданные правками агентов. Исходную загрузку не трогаем — она может быть вложением чата."""
    for version in (row.get("metadata") or {}).get("versions") or []:
        if version.get("own"):
            _discard(version.get("s3Key") or "")


def _stamp(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value or "")


def _replace_bytes(access, row: dict[str, Any], content: bytes, base_updated_at: str) -> dict[str, Any]:
    """Заменить байты существующего файла (владелец или редактор). Прежние байты остаются версией для отката."""
    name = row["name"]
    key, url = _store(name, content)
    meta = dict(row.get("metadata") or {})
    old_key = _key_of(row)
    versions = list(meta.get("versions") or [])
    if old_key:
        user = db.get_user_by_id(access.me.user_id) or {}
        versions.insert(0, {"id": Path(old_key).name, "url": row.get("url") or "", "s3Key": old_key, "size": row.get("size") or 0,
                            "mimeType": row.get("mime_type") or "", "at": _stamp(row.get("updated_at")),
                            "replacedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "by": access.me.user_id,
                            "byName": user.get("name") or "", "own": meta.get("ownKey") == old_key})
    updated = db.replace_cloud_file_content(str(row["id"]), str(base_updated_at), url, key, len(content),
                                            MIME.get(Path(name).suffix.lower(), "application/octet-stream"),
                                            {"versions": versions[:KEEP_VERSIONS], "ownKey": key})
    if not updated:
        _discard(key)
        raise _err("Файл изменился после чтения: прочитайте его заново и повторите правку", "stale_version")
    for dropped in versions[KEEP_VERSIONS:]:  # вытесненные из памяти отката — после успешной записи
        if dropped.get("own"):
            _discard(dropped.get("s3Key") or "")
    # Старый upload может быть вложением чата по тому же URL: не удаляем его при замене файла.
    cloud._cloud_changed(updated.get("folder_id"), updated)
    return updated


def file_write(access, args: dict[str, Any]) -> dict[str, Any]:
    existing = _visible_file(access, args["id"], edit=True) if args.get("id") else None
    name = Path(str(args.get("name") or (existing or {}).get("name") or "").strip()).name
    if not name:
        raise _err("Нужно имя файла с расширением (name)")
    if existing and name != existing["name"]:
        raise _err("Для переименования используйте file_update; file_write с id меняет только содержимое")
    content = _content(args)
    if existing and not args.get("base_updated_at"):
        raise _err("Для замены файла нужен base_updated_at (updatedAt из file_read) — это защищает от потери чужих правок", "stale_version")
    if existing:
        return {"updated": _file_view(_replace_bytes(access, existing, content, args["base_updated_at"]), access.me.user_id), "canUndo": True}
    key, url = _store(name, content)
    ext = Path(name).suffix.lower()
    meta = cloud.CloudFileMeta(name=name, url=url, s3Key=key, size=len(content), mimeType=MIME.get(ext),
                               fileType="image" if ext in IMAGE_EXT else "file", folderId=str(args.get("folder_id") or "") or None)
    try:
        created = _call(cloud.create_cloud_file, meta, access.me)
    except Exception:
        _discard(key)
        raise
    return {"created": _file_view(created, access.me.user_id)}


def _diff(before: str, after: str) -> str:
    import difflib

    return "\n".join(difflib.unified_diff(before.splitlines(), after.splitlines(), fromfile="До", tofile="После", lineterm=""))[:MAX_CHARS]


def _edits(args: dict[str, Any]) -> list[dict[str, Any]]:
    from app.modules.mcp.tools import _replacements

    return _replacements(args)


def _edited(row: dict[str, Any], data: bytes, args: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    """Новые байты файла по команде агента и заметка о сделанном. Формат берётся по расширению."""
    name, ext = row.get("name") or "", Path(row.get("name") or "").suffix.lower()
    mode = str(args.get("mode") or ("cells" if ext == ".xlsx" else "replace"))
    default_all = bool(args.get("replace_all"))
    if ext == ".xlsx":
        if mode != "cells":
            raise _err("В xlsx правятся ячейки: mode=cells, cells=[{sheet, ref, value}] и/или append_rows=[{sheet, rows}]")
        out, count = fileformats.xlsx_edit(data, list(args.get("cells") or []), list(args.get("append_rows") or []))
        return out, {"changed": count}
    if ext in (".docx", ".pptx"):
        if mode == "append" and ext == ".docx":
            return fileformats.docx_append(data, str(args.get("text") or "")), {"appended": True}
        if mode != "replace":
            raise _err("В docx правка — replace (внутри абзаца) или append; в pptx — replace")
        out, count = fileformats.office_replace(data, ext, _edits(args), default_all)
        return out, {"replaced": count}
    if ext == ".pdf" or not fileformats.looks_textual(name, data):
        raise _err("Точечная правка недоступна для этого формата: соберите новый файл и положите file_write с id + base64")
    text, info = fileformats.decode(data)
    note: dict[str, Any] = {}
    if mode == "append":
        text = text + ("" if not text or text.endswith("\n") else "\n") + str(args.get("text") or "")
    elif mode == "lines":
        start = int(args.get("start_line") or 0)
        end = int(args["end_line"]) if args.get("end_line") is not None else start
        text = fileformats.replace_lines(text, start, end, str(args.get("text") or ""))
    elif mode == "replace":
        text, count = fileformats.replace_text(text, _edits(args), default_all)
        note["replaced"] = count
    else:
        raise _err("mode — replace, lines или append")
    return fileformats.encode(text, info), note


def file_edit(access, args: dict[str, Any]) -> dict[str, Any]:
    row = _visible_file(access, args.get("id"), edit=True)
    if not args.get("base_updated_at") and not args.get("dry_run"):
        raise _err("Нужен base_updated_at (updatedAt из file_read) — это защищает от потери чужих правок. Для пробы без записи есть dry_run", "stale_version")
    data = _bytes(row)
    out, note = _edited(row, data, args)
    if args.get("dry_run"):
        before, after = extract_text(row["name"], data), extract_text(row["name"], out)
        return {"id": str(row["id"]), "preview": True, "diff": _diff(before, after), "changed": before != after, "baseUpdatedAt": _stamp(row.get("updated_at")), **note}
    if len(out) > MAX_WRITE:
        raise _err("Результат больше 10 МБ")
    updated = _replace_bytes(access, row, out, args["base_updated_at"])
    return {"updated": _file_view(updated, access.me.user_id), "canUndo": True, **note}


def file_versions(access, args: dict[str, Any]) -> dict[str, Any]:
    row = _visible_file(access, args.get("id"))
    versions = [{"id": v.get("id"), "at": v.get("at"), "replacedAt": v.get("replacedAt"), "by": v.get("byName") or v.get("by"), "size": v.get("size")}
                for v in (row.get("metadata") or {}).get("versions") or []]
    return {"id": str(row["id"]), "name": row["name"], "updatedAt": _stamp(row.get("updated_at")), "versions": versions,
            "canRestore": row["rights"] in ("owner", "edit"), "hint": "Вернуть: file_restore_version(id, version_id, base_updated_at); dry_run покажет разницу"}


def file_restore_version(access, args: dict[str, Any]) -> dict[str, Any]:
    row = _visible_file(access, args.get("id"), edit=True)
    version = next((v for v in (row.get("metadata") or {}).get("versions") or [] if v.get("id") == str(args.get("version_id") or "")), None)
    if not version:
        raise _err("Такой версии нет: список даёт file_versions", "not_found")
    old = _read_key(version.get("s3Key") or "")
    if args.get("dry_run"):
        before = extract_text(row["name"], _bytes(row))
        try:
            after = extract_text(row["name"], old)
        except Exception:  # noqa: BLE001 — для двоичных форматов diff недоступен, остаётся размер
            return {"id": str(row["id"]), "preview": True, "diff": "", "versionId": version["id"], "size": version.get("size"), "baseUpdatedAt": _stamp(row.get("updated_at"))}
        return {"id": str(row["id"]), "preview": True, "diff": _diff(before, after), "versionId": version["id"], "baseUpdatedAt": _stamp(row.get("updated_at"))}
    if not args.get("base_updated_at"):
        raise _err("Нужен base_updated_at (updatedAt из file_read или file_versions)", "stale_version")
    updated = _replace_bytes(access, row, old, args["base_updated_at"])
    return {"updated": _file_view(updated, access.me.user_id), "restored": version["id"]}


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
    discard_versions(row)
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
     "description": "Прочитать файл «Файлов»: текст (txt, md, csv, json, код, html, docx, pptx, xlsx, pdf; неизвестное расширение — если это текст) частями по 15 000 символов "
                    "(max_chars до 60 000; offset/nextOffset) или построчно с номерами (from_line/to_line). В ответе: updatedAt (нужен для записи), rights (owner/edit/view), "
                    "canEdit, editable и editWith — чем файл править на месте, encoding и newline. Картинки и прочее двоичное — по ссылке url. "
                    "xlsx: строка файла = строка листа, столбцы разделены табуляцией, начиная с A.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "offset": {"type": "integer", "minimum": 0}, "max_chars": {"type": "integer", "minimum": 1000, "maximum": 60000},
                                                     "from_line": {"type": "integer", "minimum": 1}, "to_line": {"type": "integer", "minimum": 1}}, "required": ["id"]}},
    {"name": "file_write", "app": "files", "handler": file_write, "level": "create",
     "description": "Создать файл (name) или заменить содержимое существующего целиком (id + base_updated_at из file_read): id, папка и доступы сохраняются, "
                    "прежняя версия остаётся для отката (file_versions). Заменять можно свой файл и тот, где вам дано право редактирования. "
                    "Передайте text, json или base64 до 10 МБ. Для точечной правки — file_edit.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "имя с расширением: отчёт.csv"},
                                                     "id": {"type": "string", "description": "id существующего файла (свой или с правом редактирования); без id создаётся новый"},
                                                     "base_updated_at": {"type": "string", "description": "updatedAt из file_read; обязателен при замене"},
                                                     "text": {"type": "string"}, "json": {}, "base64": {"type": "string"}, "folder_id": _FOLDER}}},
    {"name": "file_edit", "app": "files", "handler": file_edit, "level": "edit",
     "description": "Править файл на месте, не трогая остальное. Текст и код: mode=replace (old_text/new_text или до 50 replacements; допускает переносы строк, "
                    "кодировка и CRLF сохраняются, пробелы/тире/кавычки-двойники учитываются), mode=lines (start_line, end_line, text; end_line=start_line-1 вставляет перед строкой), "
                    "mode=append (text). docx и pptx: replace внутри абзаца с сохранением оформления; docx ещё append (абзацы). xlsx: cells=[{sheet, ref, value}] и append_rows=[{sheet, rows}]. "
                    "Нужен base_updated_at из file_read; dry_run покажет diff без записи. Права: владелец или редактор файла/папки. Откат — file_versions.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "base_updated_at": {"type": "string"},
                                                     "mode": {"type": "string", "enum": ["replace", "lines", "append", "cells"]}, "text": {"type": "string"},
                                                     "old_text": {"type": "string"}, "new_text": {"type": "string"}, "replace_all": {"type": "boolean"},
                                                     "replacements": {"type": "array", "maxItems": 50, "items": {"type": "object", "properties": {"old_text": {"type": "string"}, "new_text": {"type": "string"}, "replace_all": {"type": "boolean"}}, "required": ["old_text", "new_text"]}},
                                                     "start_line": {"type": "integer", "minimum": 1}, "end_line": {"type": "integer", "minimum": 0},
                                                     "cells": {"type": "array", "maxItems": 500, "items": {"type": "object", "properties": {"sheet": {"type": "string"}, "ref": {"type": "string"}, "value": {}}, "required": ["ref"]}},
                                                     "append_rows": {"type": "array", "items": {"type": "object", "properties": {"sheet": {"type": "string"}, "rows": {"type": "array", "items": {"type": "array"}}}, "required": ["rows"]}},
                                                     "dry_run": {"type": "boolean"}}, "required": ["id"]}},
    {"name": "file_versions", "app": "files", "handler": file_versions, "level": "read",
     "description": "Прошлые версии файла, оставшиеся после замен (последние 10): кто и когда заменил. Для отката — file_restore_version.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "file_restore_version", "app": "files", "handler": file_restore_version, "level": "edit",
     "description": "Вернуть прежнюю версию файла (version_id из file_versions). Текущая тоже сохранится версией. dry_run покажет разницу; запись — с base_updated_at.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "version_id": {"type": "string"}, "base_updated_at": {"type": "string"}, "dry_run": {"type": "boolean"}},
                     "required": ["id", "version_id"]}},
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
