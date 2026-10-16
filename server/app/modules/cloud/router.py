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
    return bool(dept) and f"dept:{dept}" in shared


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


@router.delete("/api/cloud/files/{file_id}")
def delete_cloud_file(file_id: str, me: Identity = Depends(current_identity)):
    userId = me.user_id  # владелец — вошедший, не параметр запроса
    deleted = db.delete_cloud_file(file_id, userId)
    if not deleted:
        raise HTTPException(status_code=404, detail="File not found")
    _cloud_changed(deleted.get('folder_id'), deleted)
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
