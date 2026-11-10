from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel

from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.db.connection import Json, slugify_department
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity
from app.core.storage import is_upload_name, s3_storage
from app.modules.chats.chat_notifications import get_or_create_notifications_chat
from app.modules.chats.inline import _externalize_inline

router = APIRouter()

logger = logging.getLogger(__name__)


class CloudFolderCreate(BaseModel):
    name: str
    parentId: Optional[str] = None


class CloudFolderUpdate(BaseModel):
    name: Optional[str] = None
    parentId: Optional[str] = None
    color: Optional[str] = None


class CloudFileMeta(BaseModel):
    name: str
    url: str
    s3Key: Optional[str] = None
    size: Optional[int] = 0
    mimeType: Optional[str] = None
    fileType: Optional[str] = 'file'
    folderId: Optional[str] = None


class CloudFileUpdate(BaseModel):
    name: Optional[str] = None
    folderId: Optional[str] = None
    moveToRoot: bool = False  # True = explicitly move to root (folderId=null)


class CloudFileReplace(BaseModel):
    """Новое содержимое файла: байты уже загружены обычной загрузкой (/api/upload), здесь — их адрес."""
    url: str
    s3Key: str
    size: Optional[int] = 0
    mimeType: Optional[str] = None
    fileType: Optional[str] = None


class CloudFileRestore(BaseModel):
    versionId: str


class CloudAccessUpdate(BaseModel):
    sharedWith: List[str] = []
    editAccess: List[str] = []  # subset of sharedWith who can edit


def _can_view_cloud(item: dict, me: Identity) -> bool:
    """Папку/файл видят владелец, те, с кем поделились (в т.ч. целым отделом), и админ."""
    if me.is_admin or str(item.get('owner_id') or '') == me.user_id:
        return True
    shared = {str(x) for x in (item.get('shared_with') or [])}
    if me.user_id in shared:
        return True
    dept = (db.get_user_by_id(me.user_id) or {}).get('department')
    if dept and f"dept:{dept}" in shared:
        return True
    # Доступ к папке распространяется на всё внутри: смотрим папки над этим файлом или папкой.
    folder_id = item.get('folder_id') if 'folder_id' in item else item.get('parent_id')
    seen: set = set()
    for _ in range(16):
        if not folder_id or folder_id in seen:
            break
        seen.add(folder_id)
        parent = db.get_cloud_folder_by_id(str(folder_id))
        if not parent:
            break
        up = {str(x) for x in (parent.get('shared_with') or [])}
        if me.user_id in up or (dept and f"dept:{dept}" in up):
            return True
        folder_id = parent.get('parent_id')
    return False


# ── живое обновление: «в облаке что-то поменялось» ─────────────────────────────
# Без этого человек, которому открыли папку, видел изменения только после ручного обновления страницы.
# Событие крошечное (без имён и содержимого): клиент по нему сам перечитывает ту папку, что открыта.

def _cloud_audience(folder_id: Optional[str], *items: Optional[dict]) -> set:
    """Кто видит эту папку и эти файлы: владельцы и те, с кем поделились, — по самой папке и по всем её родителям."""
    rows: list = [i for i in items if i]
    seen: set = set()
    fid = folder_id
    for _ in range(16):
        if not fid or fid in seen:
            break
        seen.add(fid)
        folder = db.get_cloud_folder_by_id(fid)
        if not folder:
            break
        rows.append(folder)
        fid = folder.get('parent_id')
    users: set = set()
    for row in rows:
        if row.get('owner_id'):
            users.add(str(row['owner_id']))
        for entry in (row.get('shared_with') or []):
            entry = str(entry)
            if entry.startswith('dept:'):
                members = db.conn.fetch_all("SELECT id FROM users WHERE department = %s", (entry[5:],)) or []
                users.update(str(m['id']) for m in members)
            else:
                users.add(entry)
    return users


def _cloud_changed(folder_id: Optional[str], *items: Optional[dict], extra_folders: tuple = ()) -> None:
    """Сообщить заинтересованным, что содержимое папки изменилось. Никогда не ломает запрос."""
    try:
        audience = _cloud_audience(folder_id, *items)
        for other in extra_folders:  # перенос: и откуда, и куда
            audience |= _cloud_audience(other)
        for uid in audience:
            sse_manager.push(uid, {"type": "cloud_changed", "folderId": folder_id})
    except Exception as exc:
        logger.warning("[cloud] could not announce change: %s", exc)


@router.get("/api/cloud/folders")
def get_cloud_folders(parentId: Optional[str] = None, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    user = db.get_user(userId)
    user_dept = user.get('department') if user else None
    folders = db.get_cloud_folders(userId, parentId, user_dept=user_dept)
    return snake_to_camel(folders)


@router.post("/api/cloud/folders")
def create_cloud_folder(body: CloudFolderCreate, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    folder = db.create_cloud_folder({
        'id': str(uuid.uuid4()),
        'name': body.name,
        'parent_id': body.parentId,
        'owner_id': userId,
    })
    if not folder:
        raise HTTPException(status_code=500, detail="Failed to create folder")
    _cloud_changed(body.parentId, folder)
    return snake_to_camel(folder)


@router.get("/api/cloud/folders/{folder_id}")
def get_cloud_folder_by_id_endpoint(folder_id: str, me: Identity = Depends(current_identity)):
    """Return a single folder by ID (for deep-link navigation)."""
    folder = db.get_cloud_folder_by_id(folder_id)
    if not folder or not _can_view_cloud(folder, me):
        raise HTTPException(status_code=404, detail="Folder not found")
    return snake_to_camel(folder)


@router.get("/api/cloud/files/{file_id}")
def get_cloud_file_by_id_endpoint(file_id: str, me: Identity = Depends(current_identity)):
    """Return a single file by ID (for deep-link navigation)."""
    file = db.get_cloud_file_by_id(file_id)
    if not file or not _can_view_cloud(file, me):
        raise HTTPException(status_code=404, detail="File not found")
    return snake_to_camel(file)


@router.patch("/api/cloud/folders/{folder_id}/pin")
def toggle_pin_folder(folder_id: str, pinned: bool = True, me: Identity = Depends(current_identity)):
    """Pin or unpin a folder."""
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    result = db.conn.fetch_one(
        "UPDATE cloud_folders SET is_pinned = %s, updated_at = NOW() WHERE id = %s AND owner_id = %s RETURNING *",
        (pinned, folder_id, userId)
    )
    if not result:
        raise HTTPException(status_code=404, detail="Folder not found or not owner")
    return snake_to_camel(dict(result))


@router.post("/api/cloud/folders/reorder")
def reorder_folders(body: dict = Body(...), me: Identity = Depends(current_identity)):
    """Save folder order. Body: { order: [{id, sortOrder}] }"""
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    items = body.get('order', [])
    for item in items:
        fid = item.get('id')
        sort_order = int(item.get('sortOrder', 0))
        if fid:
            db.conn.execute_query(
                "UPDATE cloud_folders SET sort_order = %s WHERE id = %s AND owner_id = %s",
                (sort_order, fid, userId)
            )
    return {"ok": True}


@router.put("/api/cloud/folders/{folder_id}")
def update_cloud_folder(folder_id: str, body: CloudFolderUpdate, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    result = None
    if body.name is not None:
        result = db.rename_cloud_folder(folder_id, userId, body.name)
    if body.parentId is not None:
        result = db.move_cloud_folder(folder_id, userId, body.parentId)
    if body.color is not None or (body.name is None and body.parentId is None):
        r = db.conn.fetch_one(
            "UPDATE cloud_folders SET color = %s, updated_at = NOW() WHERE id = %s AND owner_id = %s RETURNING *",
            (body.color, folder_id, userId)
        )
        if r: result = dict(r)
    if not result:
        raise HTTPException(status_code=400, detail="Nothing to update or folder not found")
    _cloud_changed(result.get('parent_id'), result, extra_folders=(body.parentId,) if body.parentId else ())
    return snake_to_camel(result)


@router.delete("/api/cloud/folders/{folder_id}")
def delete_cloud_folder(folder_id: str, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    before = db.get_cloud_folder_by_id(folder_id)
    db.delete_cloud_folder(folder_id, userId)
    if before:
        _cloud_changed(before.get('parent_id'), before)
    return {"ok": True}


@router.put("/api/cloud/folders/{folder_id}/access")
def update_cloud_folder_access(folder_id: str, body: CloudAccessUpdate, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    old = db.get_cloud_folder_by_id(folder_id)
    old_shared = set(old.get('shared_with') or []) if old else set()
    edit_access = list(body.editAccess or [])
    combined_shared = list(set(body.sharedWith) | set(edit_access))

    # Update shared_with (always works — column exists from original schema)
    result = db.update_cloud_folder_access(folder_id, userId, combined_shared)
    if not result:
        raise HTTPException(status_code=404, detail="Folder not found or not owner")

    # Try to also persist edit_access if the column exists
    try:
        db.conn.execute_query(
            "UPDATE cloud_folders SET edit_access = %s WHERE id = %s AND owner_id = %s",
            (Json(edit_access), folder_id, userId)
        )
    except Exception as e:
        logger.warning(f"edit_access column not ready: {e}")

    newly_added = set(combined_shared) - old_shared
    if newly_added:
        _notify_access_granted(userId, result.get('name', ''), 'folder', newly_added, item_id=folder_id)
    _cloud_changed(result.get('parent_id'), result, old)
    return snake_to_camel(result)


@router.patch("/api/cloud/files/{file_id}/metadata")
def update_file_metadata(file_id: str, body: dict = Body(...), me: Identity = Depends(current_identity)):
    """Update image/file metadata (title, description, tags, altText)."""
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    allowed = {'title', 'description', 'tags', 'altText'}
    clean = {k: v for k, v in body.items() if k in allowed}
    result = db.conn.fetch_one(
        "UPDATE cloud_files SET metadata = metadata || %s::jsonb, updated_at = NOW() "
        "WHERE id = %s AND (owner_id = %s OR COALESCE(edit_access, '[]'::jsonb) ? %s) RETURNING *",
        (Json(clean), file_id, userId, userId)
    )
    if not result:
        raise HTTPException(status_code=404, detail="File not found")
    return snake_to_camel(dict(result))


_DIM_EXT = {'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'}


def _image_size(row: dict):
    """Ширина и высота картинки (с учётом поворота по EXIF) — по первым 256 КБ файла: заголовка хватает, целиком не читаем."""
    name = str(row.get('name') or '')
    if name.rsplit('.', 1)[-1].lower() not in _DIM_EXT:
        return None
    key = row.get('s3_key') or (f"uploads/{str(row.get('url') or '').rsplit('/', 1)[-1]}" if row.get('url') else '')
    if not key:
        return None
    try:
        import io

        from PIL import Image

        if s3_storage.enabled:
            obj = s3_storage.get_object(key)
            head = obj["Body"].read(262144) if obj else b''
        else:
            from app.core.storage import UPLOAD_DIR

            path = UPLOAD_DIR / key
            head = path.open('rb').read(262144) if path.exists() else b''
        if not head:
            return None
        img = Image.open(io.BytesIO(head))
        w, h = img.size
        try:
            if int(img.getexif().get(274, 1)) in (5, 6, 7, 8):  # снято боком: ширина и высота меняются местами
                w, h = h, w
        except Exception:  # noqa: BLE001
            pass
        return (int(w), int(h)) if w and h else None
    except Exception as exc:  # noqa: BLE001 — не картинка или повреждена: размера просто нет
        logger.debug("[cloud] image size unavailable: %s", exc)
        return None


@router.post("/api/cloud/files/dims")
def cloud_files_dims(body: dict = Body(...), me: Identity = Depends(current_identity)):
    """Разрешение картинок для подписи под плиткой: {ids: [...]} → {dims: {id: [ширина, высота]}}. Считается один раз и
    запоминается у файла (вместе с размером файла: заменили содержимое — посчитается заново)."""
    import json as _json

    out: dict = {}
    for fid in [str(i) for i in (body.get('ids') or [])][:60]:
        row = db.get_cloud_file_by_id(fid)
        if not row or not _can_view_cloud(row, me):
            continue
        meta = row.get('metadata') or {}
        if isinstance(meta, str):
            try:
                meta = _json.loads(meta)
            except ValueError:
                meta = {}
        if meta.get('width') and meta.get('height') and meta.get('dimsFor') == row.get('size'):
            out[fid] = [meta['width'], meta['height']]
            continue
        size = _image_size(row)
        if size:
            out[fid] = list(size)
            try:
                db.conn.execute_query(
                    "UPDATE cloud_files SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb WHERE id = %s",
                    (Json({'width': size[0], 'height': size[1], 'dimsFor': row.get('size')}), fid))
            except Exception as exc:  # noqa: BLE001
                logger.debug("[cloud] could not remember image size: %s", exc)
    return {"dims": out}


@router.get("/api/cloud/files")
def get_cloud_files(folderId: Optional[str] = None, allFiles: bool = False, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    try:
        user = db.get_user(userId)
        user_dept = user.get('department') if user else None
        files = db.get_cloud_files(userId, folderId, user_dept=user_dept, all_files=allFiles)
        return snake_to_camel(files)
    except Exception as exc:
        logger.error(f"[cloud/files] GET error userId={userId} folderId={folderId}: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail="Не удалось получить файлы")


@router.post("/api/cloud/files")
def create_cloud_file(body: CloudFileMeta, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    # s3Key попадает в delete_object при удалении файла: произвольный ключ позволял бы
    # стереть чужой объект бакета. Принимаем только ключи наших загрузок.
    if body.s3Key:
        prefix, _, name = body.s3Key.partition("/")
        if prefix != "uploads" or not is_upload_name(name):
            raise HTTPException(status_code=400, detail="Invalid s3Key")
    file = db.create_cloud_file({
        'id': str(uuid.uuid4()),
        'name': body.name,
        'folder_id': body.folderId,
        'owner_id': userId,
        'url': body.url,
        's3_key': body.s3Key,
        'size': body.size or 0,
        'mime_type': body.mimeType,
        'file_type': body.fileType or 'file',
    })
    if not file:
        raise HTTPException(status_code=500, detail="Failed to save file")
    _cloud_changed(file.get('folder_id'), file)
    return snake_to_camel(file)


@router.put("/api/cloud/files/{file_id}")
def update_cloud_file(file_id: str, body: CloudFileUpdate, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    if body.name is not None:
        result = db.rename_cloud_file(file_id, userId, body.name)
    elif body.moveToRoot:
        result = db.move_cloud_file(file_id, userId, None)
    elif body.folderId is not None:
        result = db.move_cloud_file(file_id, userId, body.folderId)
    else:
        raise HTTPException(status_code=400, detail="Nothing to update")
    if not result:
        raise HTTPException(status_code=404, detail="File not found")
    _cloud_changed(result.get('folder_id'), result, extra_folders=(body.folderId,) if body.folderId else ())
    return snake_to_camel(result)


def _notify_access_granted(owner_id: str, item_name: str, item_type: str, new_entries: set, item_id: str = ''):
    """Send notification-chat messages + SSE to users newly granted access."""
    try:
        owner = db.get_user(owner_id)
        owner_name = (owner.get('name') or 'Пользователь') if owner else 'Пользователь'
        type_ru = 'файлу' if item_type == 'file' else 'папке'
        content = f'{owner_name} открыл(а) вам доступ к {type_ru} «{item_name}»'

        notif_user_ids: set = set()
        for entry in new_entries:
            if entry.startswith('dept:'):
                dept_value = entry[5:]
                normalized_dept = slugify_department(dept_value)
                for u in (db.get_users() or []):
                    user_dept = u.get('department')
                    if user_dept and u['id'] != owner_id and (user_dept == dept_value or slugify_department(user_dept) == normalized_dept):
                        notif_user_ids.add(u['id'])
            elif entry and entry != owner_id:
                notif_user_ids.add(entry)

        # Build metadata with file/folder link so frontend renders "Открыть файл" button
        metadata: dict = {'notificationType': 'file_access'}
        if item_id:
            if item_type == 'file':
                metadata['linkedFileId'] = item_id
            else:
                metadata['linkedFolderId'] = item_id

        for uid in notif_user_ids:
            try:
                chat = get_or_create_notifications_chat(uid)
                msg = {
                    "id": str(uuid.uuid4()),
                    "chat_id": chat['id'],
                    "author_id": owner_id,
                    "author_name": "Система",
                    "content": content,
                    "mentions": [],
                    "metadata": metadata,
                    "created_at": datetime.now().isoformat(),
                    "is_system_message": True,
                }
                if not db.add_message(msg):
                    # add_message swallows the real DB exception internally and returns
                    # None on failure — without this check the SSE push below still
                    # fired, telling uid's client a notification arrived that was never
                    # actually persisted (and would vanish on their next reload).
                    logger.warning("[access] failed to persist notification for %s", uid)
                    continue
                sse_manager.push(uid, {
                    "type": "new_message",
                    "chatId": chat['id'],
                    "message": snake_to_camel(msg),
                })
            except Exception as e:
                logger.warning("[access] notify %s: %s", uid, e)
    except Exception as e:
        logger.warning("[access] _notify_access_granted: %s", e)


@router.put("/api/cloud/files/{file_id}/access")
def update_cloud_file_access(file_id: str, body: CloudAccessUpdate, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    old = db.get_cloud_file_by_id(file_id)
    old_shared = set(old.get('shared_with') or []) if old else set()
    edit_access = list(body.editAccess or [])
    combined_shared = list(set(body.sharedWith) | set(edit_access))

    result = db.update_cloud_file_access(file_id, userId, combined_shared)
    if not result:
        raise HTTPException(status_code=404, detail="File not found or not owner")

    try:
        db.conn.execute_query(
            "UPDATE cloud_files SET edit_access = %s WHERE id = %s AND owner_id = %s",
            (Json(edit_access), file_id, userId)
        )
    except Exception as e:
        logger.warning(f"edit_access column not ready: {e}")

    newly_added = set(combined_shared) - old_shared
    if newly_added:
        _notify_access_granted(userId, result.get('name', ''), 'file', newly_added, item_id=file_id)
    _cloud_changed(result.get('folder_id'), result, old)
    return snake_to_camel(result)


# ── Скачать выбранное архивом ───────────────────────────────────────────────────
# GET, а не POST: в приложении скачивание идёт через окно «Сохранить как» (downloadURL), а оно умеет только GET.
# Папки кладутся целиком, с вложенными; доступ проверяется на каждый файл и папку, чужое молча пропускается.

ZIP_MAX_FILES = 3000
ZIP_MAX_BYTES = 2 * 1024 ** 3
_ZIP_STORED_EXT = {"zip", "rar", "7z", "gz", "png", "jpg", "jpeg", "gif", "webp", "heic", "mp4", "mov", "mkv", "webm", "mp3", "m4a", "pdf",
                   "docx", "xlsx", "pptx"}  # уже сжаты — второй раз жать только тратить время


def _zip_name(name: str, taken: set) -> str:
    """Имя внутри архива: без путей и запрещённых знаков, одинаковые различаются номером."""
    clean = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', ' ', str(name or '')).strip().strip('.') or 'file'
    if clean not in taken:
        taken.add(clean)
        return clean
    stem, dot, ext = clean.rpartition('.')
    base, suffix = (stem, f".{ext}") if dot and stem else (clean, '')
    n = 2
    while f"{base} ({n}){suffix}" in taken:
        n += 1
    out = f"{base} ({n}){suffix}"
    taken.add(out)
    return out


def _file_stream(row: dict):
    """Содержимое файла как поток (S3 или диск сервера) либо None, если байтов нет."""
    from app.core.storage import UPLOAD_DIR

    key = row.get('s3_key') or (f"uploads/{str(row.get('url') or '').rsplit('/', 1)[-1]}" if row.get('url') else '')
    if not key:
        return None
    if s3_storage.enabled:
        obj = s3_storage.get_object(key)
        return obj["Body"] if obj else None
    path = UPLOAD_DIR / key
    return path.open('rb') if path.exists() else None


@router.get("/api/cloud/zip")
def download_cloud_zip(files: str = "", folders: str = "", name: str = "", me: Identity = Depends(current_identity)):
    """Архив из выбранных файлов и папок. files / folders — id через запятую."""
    import shutil
    import tempfile
    import zipfile
    from urllib.parse import quote

    from fastapi.responses import StreamingResponse

    file_ids = [i for i in (x.strip() for x in files.split(',')) if i][:500]
    folder_ids = [i for i in (x.strip() for x in folders.split(',')) if i][:200]
    if not file_ids and not folder_ids:
        raise HTTPException(status_code=400, detail="Nothing selected")

    # Что кладём: (путь внутри архива, строка файла)
    entries: list = []
    top_taken: set = set()
    skipped: list = []

    def walk(folder: dict, prefix: str, depth: int = 0):
        if depth > 12 or len(entries) >= ZIP_MAX_FILES:
            return
        taken: set = set()
        for f in db.conn.fetch_all("SELECT * FROM cloud_files WHERE folder_id = %s ORDER BY name", (folder['id'],)) or []:
            entries.append((prefix + _zip_name(f.get('name'), taken), dict(f)))
        for d in db.conn.fetch_all("SELECT * FROM cloud_folders WHERE parent_id = %s ORDER BY name", (folder['id'],)) or []:
            walk(dict(d), prefix + _zip_name(d.get('name'), taken) + '/', depth + 1)

    for fid in file_ids:
        row = db.get_cloud_file_by_id(fid)
        if not row or not _can_view_cloud(row, me):
            skipped.append(fid)
            continue
        entries.append((_zip_name(row.get('name'), top_taken), row))
    first_folder = None
    for did in folder_ids:
        folder = db.get_cloud_folder_by_id(did)
        if not folder or not _can_view_cloud(folder, me):
            skipped.append(did)
            continue
        first_folder = first_folder or folder
        walk(folder, _zip_name(folder.get('name'), top_taken) + '/')
    if not entries:
        raise HTTPException(status_code=404, detail="Nothing to download")
    if len(entries) > ZIP_MAX_FILES:
        raise HTTPException(status_code=413, detail="Слишком много файлов для одного архива")
    if sum(int(r.get('size') or 0) for _, r in entries) > ZIP_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Архив получился бы больше 2 ГБ")

    tmp = tempfile.SpooledTemporaryFile(max_size=32 * 1024 * 1024)
    missing: list = []
    try:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for arc, row in entries:
                try:
                    src = _file_stream(row)
                except Exception:  # noqa: BLE001 — хранилище не ответило на один файл: остальные кладём
                    src = None
                if src is None:
                    missing.append(arc)
                    continue
                ext = arc.rsplit('.', 1)[-1].lower() if '.' in arc else ''
                info = zipfile.ZipInfo(arc)
                ts = row.get('updated_at') or row.get('created_at')
                if hasattr(ts, 'timetuple'):
                    info.date_time = tuple(ts.timetuple()[:6]) if ts.year >= 1980 else (1980, 1, 1, 0, 0, 0)
                info.compress_type = zipfile.ZIP_STORED if ext in _ZIP_STORED_EXT else zipfile.ZIP_DEFLATED
                with src, zf.open(info, 'w', force_zip64=True) as dst:
                    shutil.copyfileobj(src, dst, 1024 * 256)
            if missing:
                zf.writestr('НЕ ВОШЛИ В АРХИВ.txt', "Этих файлов не оказалось в хранилище:\n" + "\n".join(missing))
    except Exception:
        tmp.close()
        raise
    size = tmp.tell()
    tmp.seek(0)

    base = (name or '').strip() or (first_folder.get('name') if first_folder and len(folder_ids) == 1 and not file_ids else 'Файлы Шара')
    filename = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', ' ', base).strip() or 'Файлы'
    if not filename.lower().endswith('.zip'):
        filename += '.zip'

    def chunks():
        try:
            while True:
                block = tmp.read(1024 * 256)
                if not block:
                    break
                yield block
        finally:
            tmp.close()

    return StreamingResponse(chunks(), media_type="application/zip", headers={
        "Content-Length": str(size),
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
    })


# ── Замена содержимого файла с историей версий ──────────────────────────────────
# Файл остаётся тем же (id, ссылка, папка, доступы) — меняются только байты. Прежние байты уходят в metadata.versions
# (так же, как при правках агентов, см. mcp/files.py): оттуда их можно скачать или вернуть. Новая таблица не нужна.

KEEP_VERSIONS = 20  # сколько прежних версий файла помним


def _editable_file(file_id: str, me: Identity) -> dict:
    """Файл, который этот человек может менять: свой или с правом редактирования (в т.ч. от папки выше)."""
    from types import SimpleNamespace

    from app.modules.mcp import files as mcp_files  # поздний импорт: mcp/files сам импортирует этот модуль

    row = db.get_cloud_file_by_id(file_id)
    level = mcp_files.rights(SimpleNamespace(me=me), row) if row else None
    if not level:
        raise HTTPException(status_code=404, detail="File not found")
    if level not in ("owner", "edit"):
        raise HTTPException(status_code=403, detail="Файл открыт только на просмотр")
    return row


def _stamp(value) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value or "")


def _version_of(row: dict, me: Identity) -> dict:
    """Текущее содержимое файла как запись истории."""
    from pathlib import Path

    meta = row.get("metadata") or {}
    key = row.get("s3_key") or (f"uploads/{Path(str(row.get('url') or '')).name}" if row.get("url") else "")
    user = db.get_user_by_id(me.user_id) or {}
    return {"id": Path(key).name or uuid.uuid4().hex, "url": row.get("url") or "", "s3Key": key, "size": row.get("size") or 0,
            "mimeType": row.get("mime_type") or "", "at": _stamp(row.get("updated_at")),
            "replacedAt": datetime.now().astimezone().isoformat(timespec="seconds"), "by": me.user_id,
            "byName": user.get("name") or "", "own": bool(key) and meta.get("ownKey") == key}


def _swap_content(row: dict, me: Identity, versions: list, url: str, key: str, size: int, mime: str, own: bool) -> dict:
    """Записать новое содержимое и историю одной проверенной операцией (не затираем чужую правку, сделанную между чтением и записью)."""
    from app.modules.mcp import files as mcp_files

    updated = db.replace_cloud_file_content(str(row["id"]), _stamp(row.get("updated_at")), url, key, size, mime,
                                            {"versions": versions[:KEEP_VERSIONS], "ownKey": key if own else None,
                                             "width": None, "height": None, "dimsFor": None})  # разрешение картинки посчитается заново
    if not updated:
        raise HTTPException(status_code=409, detail="Файл изменился: откройте его заново и повторите")
    for dropped in versions[KEEP_VERSIONS:]:  # вытесненные из памяти отката — после успешной записи
        if dropped.get("own"):
            mcp_files._discard(dropped.get("s3Key") or "")
    return updated


@router.post("/api/cloud/files/{file_id}/replace")
def replace_cloud_file(file_id: str, body: CloudFileReplace, me: Identity = Depends(current_identity)):
    """Заменить содержимое файла новым (из буфера обмена или с диска). Ссылка на файл не меняется, прежнее — в истории."""
    from app.modules.mcp import files as mcp_files

    row = _editable_file(file_id, me)
    prefix, _, name = body.s3Key.partition("/")
    if prefix != "uploads" or not is_upload_name(name):
        raise HTTPException(status_code=400, detail="Invalid s3Key")
    versions = list((row.get("metadata") or {}).get("versions") or [])
    if row.get("url") or row.get("s3_key"):
        versions.insert(0, _version_of(row, me))
    try:
        updated = _swap_content(row, me, versions, body.url, body.s3Key, int(body.size or 0),
                                body.mimeType or row.get("mime_type") or "application/octet-stream", own=True)
    except HTTPException:
        mcp_files._discard(body.s3Key)  # загрузка осталась без файла — убираем
        raise
    if body.fileType and body.fileType != row.get("file_type"):
        db.conn.execute_query("UPDATE cloud_files SET file_type = %s WHERE id = %s", (body.fileType, file_id))
        updated["file_type"] = body.fileType
    _cloud_changed(updated.get("folder_id"), updated)
    return snake_to_camel(updated)


@router.get("/api/cloud/files/{file_id}/versions")
def get_cloud_file_versions(file_id: str, me: Identity = Depends(current_identity)):
    """Текущая версия и прежние: когда заменены, кем, размер, адрес (для скачивания)."""
    row = db.get_cloud_file_by_id(file_id)
    if not row or not _can_view_cloud(row, me):
        raise HTTPException(status_code=404, detail="File not found")
    try:
        _editable_file(file_id, me)
        can_restore = True
    except HTTPException:
        can_restore = False
    versions = [{"id": v.get("id"), "url": v.get("url"), "size": v.get("size"), "mimeType": v.get("mimeType"), "at": v.get("at"),
                 "replacedAt": v.get("replacedAt"), "by": v.get("by"), "byName": v.get("byName")}
                for v in (row.get("metadata") or {}).get("versions") or []]
    return {"id": str(row["id"]), "name": row.get("name"), "canRestore": can_restore,
            "current": {"url": row.get("url"), "size": row.get("size"), "mimeType": row.get("mime_type"), "updatedAt": _stamp(row.get("updated_at"))},
            "versions": versions}


@router.post("/api/cloud/files/{file_id}/restore")
def restore_cloud_file_version(file_id: str, body: CloudFileRestore, me: Identity = Depends(current_identity)):
    """Вернуть прежнюю версию: она становится текущей, а текущая сама уходит в историю — ничего не пропадает."""
    row = _editable_file(file_id, me)
    versions = list((row.get("metadata") or {}).get("versions") or [])
    target = next((v for v in versions if v.get("id") == body.versionId), None)
    if not target:
        raise HTTPException(status_code=404, detail="Version not found")
    rest = [v for v in versions if v is not target]
    rest.insert(0, _version_of(row, me))
    updated = _swap_content(row, me, rest, target.get("url") or "", target.get("s3Key") or "", int(target.get("size") or 0),
                            target.get("mimeType") or row.get("mime_type") or "application/octet-stream", own=bool(target.get("own")))
    _cloud_changed(updated.get("folder_id"), updated)
    return snake_to_camel(updated)


@router.delete("/api/cloud/files/{file_id}")
def delete_cloud_file(file_id: str, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    deleted = db.delete_cloud_file(file_id, userId)
    if not deleted:
        raise HTTPException(status_code=404, detail="File not found")
    _cloud_changed(deleted.get('folder_id'), deleted)
    try:
        from app.modules.mcp.files import discard_versions

        discard_versions(deleted)  # версии, оставшиеся от правок агентов
    except Exception as exc:
        logger.warning("[cloud] could not discard file versions: %s", exc)
    if deleted.get('s3_key') and s3_storage.enabled:
        try:
            s3_storage.delete_object(deleted['s3_key'])
        except Exception:
            pass
    return {"ok": True}


@router.get("/api/cloud/chat-folders")
def get_cloud_chat_folders(me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    rows = db.get_attachment_chats(userId)
    def _fmt(r: dict) -> dict:
        ts = r.get('last_at')
        return {
            'chatId': str(r.get('chat_id') or ''),
            'chatName': r.get('chat_name') or '',
            'isGroup': bool(r.get('is_group')),
            'chatAvatar': r.get('chat_avatar') or None,
            'count': int(r.get('count') or 0),
            'lastAt': ts.isoformat() if hasattr(ts, 'isoformat') else str(ts) if ts else None,
        }
    return [_fmt(r) for r in rows]


@router.get("/api/cloud/attachments")
def get_cloud_attachments(fileType: Optional[str] = None, chatId: Optional[str] = None,
                          limit: int = 200, offset: int = 0, me: Identity = Depends(current_identity)):
    userId = me.user_id
    limit = min(max(limit, 1), 500)
    rows = db.get_chat_attachments(userId, fileType, limit, offset, chatId)
    def _normalize_url(url: str) -> str:
        if not url:
            return url
        m = re.search(r'/uploads/([^/?#\s]+)', url)
        if m:
            return f"/api/uploads/{m.group(1)}"
        return url

    def _fmt(r: dict) -> dict:
        ts = r.get('created_at')
        return {
            'messageId': r.get('message_id'),
            'chatId': r.get('chat_id'),
            'authorId': r.get('author_id'),
            'authorName': r.get('author_name'),
            'chatName': r.get('chat_name'),
            'url': _externalize_inline(_normalize_url(r.get('url') or ''), str(r.get('message_id') or '')),
            'filename': r.get('filename'),
            'fileType': r.get('file_type'),
            'size': r.get('size'),
            'createdAt': ts.isoformat() if hasattr(ts, 'isoformat') else str(ts) if ts else None,
        }
    return [_fmt(r) for r in rows]
