"""Рабочие материалы: заметки, документы, таблицы и презентации.

Один набор таблиц на четыре вида — у них общее: владелец, доступ, закрепление, ссылки
«по ссылке» и выдача прав поимённо. Различается только содержимое (`content`), его формат
знает клиент:

  note          Markdown
  document      снимок Univer Docs (JSON)
  table         книга xlsx в base64
  presentation  JSON колоды (тема и слайды)

Сервер содержимое не разбирает — кроме текста для поиска (`text_of`).
Доступ: владелец; все (access_level = 'all', права остальных — access_mode); поимённо (workspace_item_shares).
Ссылки без входа — по одной на режим view/edit (workspace_item_links), отзыв — удалением строки.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import uuid
from typing import Any, Optional

from app.core import schema
from app.core.db import db
from app.core.db.connection import Json
from app.core.storage import s3_storage

log = logging.getLogger("shar.workspace")

KINDS = ("note", "table", "document", "presentation")
ACCESS_LEVELS = ("private", "all")
ACCESS_MODES = ("edit", "view")

# Предельный размер содержимого по виду: защита базы от мусора, в том числе при правке по ссылке.
MAX_BYTES = {"note": 4 * 1024 * 1024, "document": 25 * 1024 * 1024, "table": 25 * 1024 * 1024, "presentation": 45 * 1024 * 1024}
# По ссылке без входа правят осторожнее.
MAX_SHARED_BYTES = 8 * 1024 * 1024

schema.register("workspace", """
CREATE TABLE IF NOT EXISTS workspace_items (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('note', 'table', 'document', 'presentation')),
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    text_content TEXT NOT NULL DEFAULT '',
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    pinned BOOLEAN NOT NULL DEFAULT false,
    is_template BOOLEAN NOT NULL DEFAULT false,
    owner_id TEXT NOT NULL,
    access_level TEXT NOT NULL DEFAULT 'private',
    access_mode TEXT NOT NULL DEFAULT 'edit',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Содержимое лежит в S3 (приватный объект workspace/<id>/<версия>), в строке — только ключ и размер.
-- Без S3 (локальная разработка) оно остаётся в content.
ALTER TABLE workspace_items ADD COLUMN IF NOT EXISTS content_key TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_items ADD COLUMN IF NOT EXISTS content_size BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_workspace_items_kind ON workspace_items(kind, pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_items_owner ON workspace_items(owner_id);
CREATE TABLE IF NOT EXISTS workspace_item_shares (
    item_id BIGINT NOT NULL REFERENCES workspace_items(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (item_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_item_shares_user ON workspace_item_shares(user_id);
CREATE TABLE IF NOT EXISTS workspace_item_dept_shares (
    item_id BIGINT NOT NULL REFERENCES workspace_items(id) ON DELETE CASCADE,
    department_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (item_id, department_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_item_dept_shares_dept ON workspace_item_dept_shares(department_id);
CREATE TABLE IF NOT EXISTS workspace_item_links (
    token TEXT PRIMARY KEY,
    item_id BIGINT NOT NULL REFERENCES workspace_items(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('view', 'edit')),
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_item_links_mode ON workspace_item_links(item_id, mode);
-- История версий: снимки содержимого (в S3 — ссылка на тот же объект, без копирования).
ALTER TABLE workspace_items ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS workspace_item_versions (
    id BIGSERIAL PRIMARY KEY,
    item_id BIGINT NOT NULL REFERENCES workspace_items(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    content_key TEXT NOT NULL DEFAULT '',
    content_size BIGINT NOT NULL DEFAULT 0,
    saved_by TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspace_item_versions_item ON workspace_item_versions(item_id, id DESC);
""")

# В списке содержимого нет: снимок документа весит сотни килобайт, а списку нужны название, дата и фрагмент.
LIST_COLUMNS = """id::text AS id, kind, title, pinned, is_template, meta, owner_id, access_level, access_mode,
    created_at::text AS created_at, updated_at::text AS updated_at,
    GREATEST(octet_length(content), content_size) AS size_bytes, left(regexp_replace(text_content, '\\s+', ' ', 'g'), 160) AS snippet"""
FULL_COLUMNS = LIST_COLUMNS + ", content, content_key, updated_by"

_CONTROL = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f]")
_TAGS = re.compile(r"<[^>]+>")


class WorkspaceError(Exception):
    """Ошибка, которую роутер превращает в ответ: (код HTTP, сообщение)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def text_of(kind: str, content: str) -> str:
    """Текст для поиска и фрагмента в списке. Формат разбирается мягко: битый JSON — пустой текст."""
    if kind == "note":
        return content
    try:
        if kind == "document":
            stream = str(((json.loads(content) or {}).get("body") or {}).get("dataStream") or "")
            return re.sub(r"\n{3,}", "\n\n", _CONTROL.sub("\n", stream).replace("\r", "\n")).strip()
        if kind == "presentation":
            deck = json.loads(content) or {}
            parts: list[str] = []
            for slide in deck.get("slides") or []:
                for element in slide.get("elements") or []:
                    html = element.get("html") or element.get("text") or ""
                    parts.append(re.sub(r"\s+", " ", _TAGS.sub(" ", str(html))).strip())
            return "\n".join(p for p in parts if p)
    except (ValueError, TypeError, AttributeError):
        return ""
    return ""  # таблица лежит файлом xlsx: по ячейкам не ищем


def slide_count(content: str) -> int | None:
    try:
        slides = (json.loads(content) or {}).get("slides")
        return len(slides) if isinstance(slides, list) else None
    except (ValueError, TypeError, AttributeError):
        return None


def validate_content(kind: str, content: str, *, shared: bool = False) -> None:
    limit = MAX_SHARED_BYTES if shared else MAX_BYTES[kind]
    if len(content.encode("utf-8")) > limit:
        raise WorkspaceError(413, "Материал слишком большой")
    if kind == "document":
        try:
            snapshot = json.loads(content)
        except ValueError:
            raise WorkspaceError(400, "Документ повреждён: ожидается снимок редактора") from None
        if not isinstance(snapshot, dict) or not isinstance((snapshot.get("body") or {}).get("dataStream"), str):
            raise WorkspaceError(400, "Документ повреждён: ожидается снимок редактора")
    elif kind == "presentation":
        try:
            deck = json.loads(content)
        except ValueError:
            raise WorkspaceError(400, "Презентация повреждена") from None
        if not isinstance(deck, dict) or not isinstance(deck.get("slides"), list):
            raise WorkspaceError(400, "Презентация повреждена")


# ── права ───────────────────────────────────────────────────────────────────

def _ensure_dept_columns() -> None:
    """parent_id у отделов и department_ids у людей создаются лениво — к моменту первого запроса их может не быть."""
    for guard in ("_ensure_departments_columns", "_ensure_users_columns"):
        fn = getattr(db, guard, None)
        if callable(fn):
            try:
                fn()
            except Exception as exc:  # столбцы нужны только отделам; без них остаётся доступ поимённо
                log.debug("workspace: %s failed: %s", guard, exc)


def user_dept_ids(user_id: str) -> list[str]:
    """Отделы человека и их родители: материал, выданный отделу, открыт и его подразделам."""
    _ensure_dept_columns()
    user = db.get_user_by_id(user_id) or {}
    own = {str(d) for d in (user.get("department_ids") or []) if d}
    if user.get("department"):
        own.add(str(user["department"]))
    if not own:
        return []
    parents = db.conn.fetch_all("SELECT parent_id FROM departments WHERE id = ANY(%s) AND parent_id IS NOT NULL", (list(own),)) or []
    return sorted(own | {str(p["parent_id"]) for p in parents})


def dept_members(dept_ids: list[str]) -> set[str]:
    """Все, кто входит в эти отделы или в их подразделы."""
    if not dept_ids:
        return set()
    _ensure_dept_columns()
    children = db.conn.fetch_all("SELECT id FROM departments WHERE parent_id = ANY(%s)", (dept_ids,)) or []
    every = sorted(set(dept_ids) | {str(c["id"]) for c in children})
    rows = db.conn.fetch_all("SELECT id FROM users WHERE department = ANY(%s) OR department_ids && %s::text[]", (every, every)) or []
    return {str(r["id"]) for r in rows}


def visible_sql(alias: str = "i") -> str:
    """Условие «пользователь видит материал»; параметры — visible_params(user_id)."""
    return (f"({alias}.owner_id = %s OR {alias}.access_level = 'all' "
            f"OR EXISTS (SELECT 1 FROM workspace_item_shares s WHERE s.item_id = {alias}.id AND s.user_id = %s) "
            f"OR EXISTS (SELECT 1 FROM workspace_item_dept_shares d WHERE d.item_id = {alias}.id AND d.department_id = ANY(%s)))")


def visible_params(user_id: str) -> list[Any]:
    return [user_id, user_id, user_dept_ids(user_id)]


def permissions(row: dict[str, Any], user_id: str, depts: list[str] | None = None) -> dict[str, Any]:
    """Что может человек с этим материалом. Правка: владелец; выданное поимённо или его отделу (если есть
    право на правку хоть где — правит); остальные, кто видит материал по уровню доступа, — по режиму материала."""
    if str(row["owner_id"]) == user_id:
        return {"isOwner": True, "canEdit": True, "role": "owner"}
    roles = [s["role"] for s in db.conn.fetch_all("SELECT role FROM workspace_item_shares WHERE item_id = %s AND user_id = %s", (row["id"], user_id)) or []]
    if depts is None:
        depts = user_dept_ids(user_id)
    if depts:
        roles += [s["role"] for s in db.conn.fetch_all("SELECT role FROM workspace_item_dept_shares WHERE item_id = %s AND department_id = ANY(%s)", (row["id"], depts)) or []]
    if roles:
        role = "edit" if "edit" in roles else "view"
        return {"isOwner": False, "canEdit": role == "edit", "role": role}
    if row["access_level"] == "all":
        mode = row["access_mode"]
        return {"isOwner": False, "canEdit": mode != "view", "role": "view" if mode == "view" else "edit"}
    return {"isOwner": False, "canEdit": False, "role": None}


def present(row: dict[str, Any], user_id: str | None = None, *, with_content: bool = False,
            depts: list[str] | None = None, owners: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """depts и owners — заранее посчитанные отделы смотрящего и владельцы: список не ходит за ними на каждую строку."""
    owner = owners.get(str(row["owner_id"])) if owners is not None else None
    if owner is None:
        owner = db.get_user_by_id(str(row["owner_id"])) or {}
    out: dict[str, Any] = {
        "id": row["id"], "kind": row["kind"], "title": row["title"], "pinned": row["pinned"], "isTemplate": row["is_template"],
        "meta": row["meta"] or {}, "ownerId": row["owner_id"], "ownerName": owner.get("name") or owner.get("username") or "",
        "accessLevel": row["access_level"], "accessMode": row["access_mode"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
        "sizeBytes": row.get("size_bytes") or 0, "snippet": row.get("snippet") or "",
    }
    if user_id is not None:
        out.update(permissions(row, user_id, depts))
    if with_content:
        out["content"] = row["content"]
    return out


def get_row(item_id: str, *, full: bool = True, content: bool = True) -> Optional[dict[str, Any]]:
    """content=False: все поля, кроме содержимого из S3 (для проверки прав и служебных запросов)."""
    if not str(item_id).isdigit():
        return None
    row = db.conn.fetch_one(f"SELECT {FULL_COLUMNS if full else LIST_COLUMNS} FROM workspace_items i WHERE id = %s", (int(item_id),))
    if row and full and content and row.get("content_key"):
        row["content"] = read_object(row["content_key"])
    return row


# ── содержимое в S3 ─────────────────────────────────────────────────────────

def read_object(key: str) -> str:
    obj = s3_storage.get_object(key)
    if obj is None:
        raise WorkspaceError(502, "Содержимое не найдено в хранилище")
    return obj["Body"].read().decode("utf-8")


def content_sets(item_id: int, content: str) -> tuple[list[str], list[Any], str]:
    """Куда записать содержимое: (части SET, параметры, новый ключ S3 или '').

    При включённом S3 объект уходит в хранилище сразу, под новым ключом: перезапись общего ключа до проверки
    конфликта (409) оставила бы в хранилище чужую правку. Вызывающий после UPDATE зовёт finish_content()."""
    if not s3_storage.enabled:
        return ["content = %s", "content_key = ''", "content_size = 0"], [content], ""
    data = content.encode("utf-8")
    key = f"workspace/{item_id}/{uuid.uuid4().hex}"
    try:
        s3_storage.put_private(key, data, "application/json; charset=utf-8")
    except Exception as exc:  # сеть, ключи, квота — человеку важно одно: не сохранилось
        log.error("workspace: S3 put failed for %s: %s", key, exc)
        raise WorkspaceError(502, "Не удалось сохранить в хранилище, попробуйте ещё раз") from exc
    return ["content = ''", "content_key = %s", "content_size = %s"], [key, len(data)], key


def finish_content(new_key: str, old_key: str, saved: bool) -> None:
    """Убрать лишний объект: старую версию после успешной записи, новую — после неудачной."""
    stale = old_key if saved else new_key
    if not stale or (saved and stale == new_key):
        return
    try:
        s3_storage.delete_object(stale)
    except Exception as exc:  # мусор в хранилище не должен ломать ответ
        log.warning("workspace: could not delete %s: %s", stale, exc)


def drop_objects(item_id: int) -> None:
    if not s3_storage.enabled:
        return
    try:
        s3_storage.delete_prefix(f"workspace/{item_id}/")
    except Exception as exc:
        log.warning("workspace: could not delete objects of %s: %s", item_id, exc)


def get_visible(item_id: str, user_id: str, *, content: bool = True) -> dict[str, Any]:
    """content=False — без содержимого из S3: присутствию, истории и управлению доступом оно не нужно, а качать
    документ целиком ради проверки прав (присутствие — раз в 15 с на каждого зрителя) дорого."""
    row = get_row(item_id, content=content)
    # Чужой закрытый материал не выдаёт даже своего существования.
    if not row or not (permissions(row, user_id)["role"]):
        raise WorkspaceError(404, "Материал не найден")
    return row


def clean_meta(kind: str, meta: Any) -> dict[str, Any]:
    if not isinstance(meta, dict):
        return {}
    out: dict[str, Any] = {}
    if kind == "note":
        color = str(meta.get("color") or "default")
        out["color"] = color if color in ("default", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "gray") else "default"
    return out


def new_token() -> str:
    return secrets.token_urlsafe(24)


def as_json(value: Any) -> Json:
    return Json(value)


# ── живое обновление: «в Офисе что-то поменялось» ────────────────────────────

def audience(row: dict[str, Any]) -> set[str]:
    """Кому материал виден сейчас: владелец, выданные поимённо, выданные отделам; при «Все в Шаре» — все."""
    if row.get("access_level") == "all":
        users = {str(u["id"]) for u in (db.get_users() or [])}
    else:
        users = set()
    users.add(str(row["owner_id"]))
    users |= {str(r["user_id"]) for r in db.conn.fetch_all("SELECT user_id FROM workspace_item_shares WHERE item_id = %s", (row["id"],)) or []}
    depts = [str(r["department_id"]) for r in db.conn.fetch_all("SELECT department_id FROM workspace_item_dept_shares WHERE item_id = %s", (row["id"],)) or []]
    return users | dept_members(depts)


def announce(users: set[str], row: dict[str, Any], reason: str, *, actor: str = "", exclude: str = "") -> None:
    """Сообщить, что в Офисе изменилось: у получателя сам обновится список. Без содержимого. Не ломает запрос.
    reason: 'shared' — вам открыли доступ, 'changed' — список изменился (убрали доступ, удалили, переименовали)."""
    try:
        from app.core.realtime import sse_manager  # поздний импорт: realtime тянет много, а store нужен и тестам

        actor_user = db.get_user_by_id(actor) if actor else None
        payload = {"type": "workspace_changed", "reason": reason, "itemId": str(row["id"]), "kind": row["kind"], "title": row.get("title") or "",
                   "by": (actor_user or {}).get("name") or (actor_user or {}).get("username") or ""}
        for uid in users:
            if uid and uid != exclude:
                sse_manager.push(uid, payload)
    except Exception as exc:
        log.warning("workspace: could not announce change: %s", exc)


# ── история версий ───────────────────────────────────────────────────────────
# Версия — состояние материала до очередной правки. Новая появляется, когда прошло ≥10 минут правок с
# прошлой версии, когда материал правит другой человек, а также по кнопке «Сохранить версию» и перед восстановлением.

VERSION_GAP_SECONDS = 600
MAX_VERSIONS = 60


def snapshot(row: dict[str, Any], editor: str, *, force: bool = False, label: str = "", keep_object: bool = False) -> bool:
    """Положить в историю содержимое `row` (то, что только что перезаписано новым). Зовут ПОСЛЕ успешной записи.

    Возвращает True, если версия забрала себе объект S3 (`content_key`): вызывающий тогда не должен его удалять.
    keep_object=True — материал продолжает ссылаться на тот же объект (ручная версия): для версии делается копия."""
    content = row.get("content") or ""
    key = row.get("content_key") or ""
    if not content and not key:
        return False
    item_id = int(row["id"])
    last = db.conn.fetch_one(
        """SELECT id, content, content_key, saved_by, EXTRACT(EPOCH FROM (%s::timestamptz - created_at)) AS gap
           FROM workspace_item_versions WHERE item_id = %s ORDER BY id DESC LIMIT 1""",
        (row["updated_at"], item_id),
    )
    previous_author = row.get("updated_by") or str(row["owner_id"])
    if not force and last:
        gap = float(last["gap"] or 0)
        if previous_author == editor and gap < VERSION_GAP_SECONDS:
            return False
        if not key and last["content"] == content:
            return False  # то же состояние уже записано
    taken = bool(key)
    if key and keep_object:
        copy_key = f"workspace/{item_id}/v-{uuid.uuid4().hex}"
        try:
            s3_storage.put_private(copy_key, content.encode("utf-8"), "application/json; charset=utf-8")
        except Exception as exc:
            log.error("workspace: S3 copy failed for %s: %s", copy_key, exc)
            raise WorkspaceError(502, "Не удалось сохранить версию в хранилище") from exc
        key, content, taken = copy_key, "", False
    db.conn.execute_query(
        """INSERT INTO workspace_item_versions (item_id, title, content, content_key, content_size, saved_by, label, created_at)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s::timestamptz)""",
        (item_id, row.get("title") or "", "" if key else content, key, len(content.encode("utf-8")) if content else int(row.get("size_bytes") or 0),
         previous_author, label[:80], row["updated_at"]),
    )
    stale = db.conn.fetch_all(
        "SELECT id, content_key FROM workspace_item_versions WHERE item_id = %s ORDER BY id DESC OFFSET %s", (item_id, MAX_VERSIONS),
    ) or []
    for old in stale:
        db.conn.execute_query("DELETE FROM workspace_item_versions WHERE id = %s", (old["id"],))
        if old["content_key"] and s3_storage.enabled:
            try:
                s3_storage.delete_object(old["content_key"])
            except Exception as exc:
                log.warning("workspace: could not delete version object %s: %s", old["content_key"], exc)
    return taken


def version_content(version: dict[str, Any]) -> str:
    return read_object(version["content_key"]) if version.get("content_key") else (version.get("content") or "")


# ── кто сейчас в материале ───────────────────────────────────────────────────
# «Присутствие» живёт в Redis (общее для воркеров), а без него — в памяти процесса. Клиент шлёт сигнал каждые
# несколько секунд; тот, кто замолчал на 25 секунд, считается ушедшим. По этому списку же рассылаются
# живые события: чужую правку получают только те, кто сейчас смотрит материал, а не вся компания.

PRESENCE_TTL = 25


class Presence:
    def __init__(self) -> None:
        import os

        self._redis = None
        try:
            import redis

            self._redis = redis.Redis.from_url(os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0"), decode_responses=True, socket_connect_timeout=1, socket_timeout=1)
        except Exception:
            self._redis = None
        self._local: dict[str, dict[str, tuple[float, bool]]] = {}

    @staticmethod
    def _now() -> float:
        import time

        return time.time()

    def touch(self, item_id: str, user_id: str, editing: bool) -> None:
        now = self._now()
        if self._redis is not None:
            try:
                key, hkey = f"shar:wsp:{item_id}", f"shar:wspe:{item_id}"
                pipe = self._redis.pipeline()
                pipe.zadd(key, {user_id: now})
                pipe.hset(hkey, user_id, "1" if editing else "0")
                pipe.expire(key, PRESENCE_TTL * 3)
                pipe.expire(hkey, PRESENCE_TTL * 3)
                pipe.execute()
                return
            except Exception as exc:
                log.debug("workspace presence: redis unavailable (%s)", exc)
        self._local.setdefault(item_id, {})[user_id] = (now, editing)

    def leave(self, item_id: str, user_id: str) -> None:
        if self._redis is not None:
            try:
                self._redis.zrem(f"shar:wsp:{item_id}", user_id)
                self._redis.hdel(f"shar:wspe:{item_id}", user_id)
            except Exception:
                pass
        self._local.get(item_id, {}).pop(user_id, None)

    def viewers(self, item_id: str) -> list[tuple[str, bool]]:
        now = self._now()
        if self._redis is not None:
            try:
                key, hkey = f"shar:wsp:{item_id}", f"shar:wspe:{item_id}"
                self._redis.zremrangebyscore(key, 0, now - PRESENCE_TTL)
                members = self._redis.zrange(key, 0, -1)
                flags = self._redis.hmget(hkey, members) if members else []
                return [(m, f == "1") for m, f in zip(members, flags)]
            except Exception as exc:
                log.debug("workspace presence: redis unavailable (%s)", exc)
        live = {u: v for u, v in self._local.get(item_id, {}).items() if v[0] >= now - PRESENCE_TTL}
        self._local[item_id] = live
        return [(u, v[1]) for u, v in live.items()]


presence = Presence()


def viewer_list(item_id: str) -> list[dict[str, Any]]:
    out = []
    for uid, editing in presence.viewers(item_id):
        user = db.get_user_by_id(uid) or {}
        out.append({"userId": uid, "name": user.get("name") or user.get("username") or uid, "avatar": user.get("avatar") or "", "editing": editing})
    return out


def push_to_viewers(item_id: str, payload: dict[str, Any], *, exclude: str = "") -> None:
    """Живое событие тем, кто сейчас открыл материал. Не ломает запрос."""
    try:
        from app.core.realtime import sse_manager

        for uid, _ in presence.viewers(item_id):
            if uid != exclude:
                sse_manager.push(uid, payload)
    except Exception as exc:
        log.warning("workspace: could not push live event: %s", exc)
