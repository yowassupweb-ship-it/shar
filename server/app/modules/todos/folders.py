"""Папки задач: доступ людям (как у папок документов) и история версий текста задачи.

Папка задач — это «список» (todo_lists): название, цвет, создатель. Раньше доступ к списку (allowed_users) решал только,
кто видит сам список; задачи в нём видели лишь участники. Теперь папку можно открыть людям по-настоящему: тот, кому она
открыта, видит все её задачи (view) или ещё и правит их и добавляет свои (edit). Открытие хранится отдельной таблицей
todo_list_shares — старое allowed_users не трогаем, чтобы чужие списки на проде не стали вдруг открыты вместе с задачами.

История версий: на каждое сохранение названия или текста задачи (как у документов — слитно, если один автор правит
подряд меньше 10 минут), хранится не больше MAX_VERSIONS. Восстановление сперва сохраняет текущее состояние.

Новые таблицы на проде появляются отдельным шагом схемы; пока их нет, код ведёт себя как раньше (table_ready).
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.realtime import sse_manager
from app.core.security import Identity, current_identity

router = APIRouter()
log = logging.getLogger("shar.todos.folders")

LEVELS = ("view", "edit")
VERSION_GAP_SECONDS = 600
MAX_VERSIONS = 60

schema.register("todo_list_shares", """
CREATE TABLE IF NOT EXISTS todo_list_shares (
    list_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'edit',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (list_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_todo_list_shares_user ON todo_list_shares(user_id);
""")

schema.register("task_versions", """
CREATE TABLE IF NOT EXISTS task_versions (
    id BIGSERIAL PRIMARY KEY,
    task_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    saved_by TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_versions_task ON task_versions(task_id, id DESC);
""")


def _ready(table: str) -> bool:
    from app.modules.workspace import store  # поздний импорт: workspace тянет S3

    return store.table_ready(table)


# ── доступ к задачам через папку ─────────────────────────────────────────────

def levels_of(user_id: str) -> dict[str, str]:
    """list_id → level для папок, открытых этому человеку."""
    if not _ready("todo_list_shares"):
        return {}
    rows = db.conn.fetch_all("SELECT list_id, level FROM todo_list_shares WHERE user_id = %s", (user_id,)) or []
    return {str(r["list_id"]): r["level"] for r in rows}


def shared_for(user_id: str) -> tuple[list[dict], list[dict]]:
    """(задачи, папки), открытые человеку через папки. Свои и чужие по участию он и так получает обычным путём."""
    levels = levels_of(user_id)
    if not levels:
        return [], []
    ids = list(levels)
    tasks = db.conn.fetch_all("SELECT * FROM tasks WHERE list_id = ANY(%s) ORDER BY created_at DESC", (ids,)) or []
    lists = db.conn.fetch_all("SELECT * FROM todo_lists WHERE id = ANY(%s)", (ids,)) or []
    return [dict(t) for t in tasks], [{**dict(l), "shared_level": levels.get(str(l["id"]))} for l in lists]


def task_level(task: Optional[dict], user_id: str) -> Optional[str]:
    """Уровень доступа к задаче через её папку: view | edit | None."""
    list_id = (task or {}).get("list_id") or (task or {}).get("listId")
    if not list_id or not _ready("todo_list_shares"):
        return None
    row = db.conn.fetch_one("SELECT level FROM todo_list_shares WHERE list_id = %s AND user_id = %s", (str(list_id), user_id))
    return row["level"] if row else None


def members(list_id: Optional[str]) -> set[str]:
    """Кому папка открыта — чтобы им доходили живые обновления её задач."""
    if not list_id or not _ready("todo_list_shares"):
        return set()
    rows = db.conn.fetch_all("SELECT user_id FROM todo_list_shares WHERE list_id = %s", (str(list_id),)) or []
    return {str(r["user_id"]) for r in rows}


def require_write(task: dict, me: Identity, involved: bool) -> None:
    """Правка задачи: участнику и админу можно всегда, «только просмотр» через папку — нельзя."""
    if me.is_admin or involved:
        return
    level = task_level(task, me.user_id)
    if level == "view":
        raise HTTPException(status_code=403, detail="Папка открыта вам только на просмотр")


def require_can_add(list_id: Optional[str], me: Identity) -> None:
    """Добавить задачу в чужую папку: если она открыта только на просмотр — нельзя."""
    if not list_id or me.is_admin:
        return
    if levels_of(me.user_id).get(str(list_id)) == "view":
        raise HTTPException(status_code=403, detail="Папка открыта вам только на просмотр")


# ── доступ к самой папке ─────────────────────────────────────────────────────

class ShareItem(BaseModel):
    userId: str = Field(min_length=1, max_length=255)
    level: str = "edit"


class SharesBody(BaseModel):
    shares: list[ShareItem] = Field(default_factory=list, max_length=500)


def _own_list(list_id: str, me: Identity) -> dict:
    row = db.conn.fetch_one("SELECT * FROM todo_lists WHERE id = %s", (list_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Папка не найдена")
    if not (me.is_admin or str(row.get("creator_id") or "") == me.user_id):
        raise HTTPException(status_code=403, detail="Доступом к папке управляет её создатель")
    return dict(row)


def _ping(user_ids: set[str]) -> None:
    for uid in user_ids:
        try:
            sse_manager.push(uid, {"type": "tasks_resync"})
        except Exception as exc:  # живое обновление не должно ломать запрос
            log.debug("push failed: %s", exc)


@router.get("/api/todos/lists/{list_id}/shares")
def get_shares(list_id: str, me: Identity = Depends(current_identity)):
    row = _own_list(list_id, me)
    rows = db.conn.fetch_all("SELECT user_id, level FROM todo_list_shares WHERE list_id = %s ORDER BY created_at", (list_id,)) if _ready("todo_list_shares") else []
    return {"owner": str(row.get("creator_id") or ""), "shares": [{"userId": str(r["user_id"]), "level": r["level"]} for r in rows or []]}


@router.put("/api/todos/lists/{list_id}/shares")
def put_shares(list_id: str, body: SharesBody, me: Identity = Depends(current_identity)):
    row = _own_list(list_id, me)
    if not _ready("todo_list_shares"):
        raise HTTPException(status_code=503, detail="Доступ к папкам ещё не включён на сервере: нужна схема (выкладка с -Schema)")
    owner = str(row.get("creator_id") or "")
    wanted = {s.userId: (s.level if s.level in LEVELS else "edit") for s in body.shares if s.userId != owner}
    known = {str(u["id"]) for u in (db.conn.fetch_all("SELECT id FROM users WHERE id = ANY(%s)", (list(wanted),)) or [])} if wanted else set()
    wanted = {uid: level for uid, level in wanted.items() if uid in known}
    before = members(list_id)
    db.conn.execute_query("DELETE FROM todo_list_shares WHERE list_id = %s", (list_id,))
    for uid, level in wanted.items():
        db.conn.execute_query("INSERT INTO todo_list_shares (list_id, user_id, level) VALUES (%s, %s, %s)", (list_id, uid, level))
    _ping(before | set(wanted))
    return {"owner": owner, "shares": [{"userId": uid, "level": level} for uid, level in wanted.items()]}


@router.get("/api/todos/lists/{list_id}/summary")
def folder_summary(list_id: str, me: Identity = Depends(current_identity)):
    """Для окна «Доступ»: сколько задач в папке — предупредить при удалении."""
    row = _own_list(list_id, me)
    n = db.conn.fetch_one("SELECT count(*)::int AS n FROM tasks WHERE list_id = %s", (list_id,))["n"]
    return {"id": list_id, "name": row.get("name"), "tasks": n}


def forget_folder(list_id: str) -> None:
    """Папку удалили: доступ к ней больше не нужен. Задачи остаются у участников, просто без папки."""
    if _ready("todo_list_shares"):
        db.conn.execute_query("DELETE FROM todo_list_shares WHERE list_id = %s", (list_id,))


# ── история версий ───────────────────────────────────────────────────────────

def _text_of(task: dict) -> str:
    meta: Any = task.get("metadata") or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except ValueError:
            meta = {}
    md = meta.get("md") if isinstance(meta, dict) else None
    return md if isinstance(md, str) else str(task.get("description") or "")


def save_version(task: Optional[dict], author_id: str, label: str = "") -> Optional[int]:
    """Записать текущее состояние задачи в историю. Повтор того же текста и частые правки одного автора — без новой строки."""
    if not task or not _ready("task_versions"):
        return None
    task_id = str(task.get("id"))
    title = str(task.get("title") or "")
    content = _text_of(task)
    last = db.conn.fetch_one(
        "SELECT id, title, content, saved_by, label, extract(epoch FROM now() - created_at) AS age FROM task_versions WHERE task_id = %s ORDER BY id DESC LIMIT 1",
        (task_id,))
    if last and last["title"] == title and last["content"] == content and not label:
        return int(last["id"])
    if last and not label and not last["label"] and last["saved_by"] == author_id and float(last["age"]) < VERSION_GAP_SECONDS:
        db.conn.execute_query("UPDATE task_versions SET title = %s, content = %s, created_at = now() WHERE id = %s", (title, content, last["id"]))
        return int(last["id"])
    row = db.conn.fetch_one(
        "INSERT INTO task_versions (task_id, title, content, saved_by, label) VALUES (%s, %s, %s, %s, %s) RETURNING id",
        (task_id, title, content, author_id, label))
    db.conn.execute_query("DELETE FROM task_versions WHERE task_id = %s AND id NOT IN (SELECT id FROM task_versions WHERE task_id = %s ORDER BY id DESC LIMIT %s)",
                          (task_id, task_id, MAX_VERSIONS))
    return int(row["id"]) if row else None


def _task_or_403(task_id: str, me: Identity) -> dict:
    from app.modules.todos import router as todos

    return todos._owned_task_or_403(task_id, me)


def _view(row: dict, names: dict[str, str]) -> dict:
    return {"id": int(row["id"]), "title": row["title"], "label": row["label"], "savedBy": row["saved_by"], "savedByName": names.get(str(row["saved_by"]), ""),
            "createdAt": row["created_at"].isoformat(), "size": len(row.get("content") or "")}


@router.get("/api/todos/{task_id}/versions")
def list_versions(task_id: str, me: Identity = Depends(current_identity)):
    _task_or_403(task_id, me)
    if not _ready("task_versions"):
        return {"versions": [], "ready": False}
    rows = db.conn.fetch_all("SELECT id, title, content, saved_by, label, created_at FROM task_versions WHERE task_id = %s ORDER BY id DESC", (task_id,)) or []
    ids = list({str(r["saved_by"]) for r in rows if r["saved_by"]})
    names = {str(u["id"]): u.get("name") or u.get("username") or "" for u in (db.conn.fetch_all("SELECT id, name, username FROM users WHERE id = ANY(%s)", (ids,)) or [])} if ids else {}
    return {"versions": [_view(r, names) for r in rows], "ready": True}


@router.get("/api/todos/{task_id}/versions/{version_id}")
def read_version(task_id: str, version_id: int, me: Identity = Depends(current_identity)):
    _task_or_403(task_id, me)
    row = db.conn.fetch_one("SELECT * FROM task_versions WHERE id = %s AND task_id = %s", (version_id, task_id)) if _ready("task_versions") else None
    if not row:
        raise HTTPException(status_code=404, detail="Версия не найдена")
    return {"id": int(row["id"]), "title": row["title"], "md": row["content"], "label": row["label"], "createdAt": row["created_at"].isoformat()}


class VersionBody(BaseModel):
    label: str = Field(default="", max_length=80)


@router.post("/api/todos/{task_id}/versions", status_code=201)
def make_version(task_id: str, body: VersionBody, me: Identity = Depends(current_identity)):
    """«Сохранить версию» вручную, с названием."""
    task = _task_or_403(task_id, me)
    if not _ready("task_versions"):
        raise HTTPException(status_code=503, detail="История версий ещё не включена на сервере: нужна схема (выкладка с -Schema)")
    vid = save_version(task, me.user_id, label=body.label.strip() or "Сохранено вручную")
    return {"id": vid}


@router.post("/api/todos/{task_id}/versions/{version_id}/restore")
def restore_version(task_id: str, version_id: int, me: Identity = Depends(current_identity)):
    """Отдаёт содержимое версии; само применение — обычным сохранением задачи (клиент). Текущее состояние кладём в историю заранее."""
    from app.modules.todos import router as todos

    task = _task_or_403(task_id, me)
    todos._require_task_write(task, me)
    row = db.conn.fetch_one("SELECT * FROM task_versions WHERE id = %s AND task_id = %s", (version_id, task_id)) if _ready("task_versions") else None
    if not row:
        raise HTTPException(status_code=404, detail="Версия не найдена")
    save_version(task, me.user_id, label="Перед восстановлением")
    return {"id": int(row["id"]), "title": row["title"], "md": row["content"]}
