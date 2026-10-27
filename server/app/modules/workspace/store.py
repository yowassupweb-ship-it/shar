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
import time
import uuid
from contextvars import ContextVar
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
-- «Новое»: когда человек последний раз открывал чужой материал и когда материал открыли всем.
CREATE TABLE IF NOT EXISTS workspace_item_seen (
    item_id BIGINT NOT NULL REFERENCES workspace_items(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (item_id, user_id)
);
ALTER TABLE workspace_items ADD COLUMN IF NOT EXISTS shared_all_at TIMESTAMPTZ;
""")

# Через что сделана правка: '' — человек сам, в интерфейсе; иначе — например «агент «Claude»» (ставит MCP на время своей
# правки). Хранится у материала (кто и как сделал текущее состояние) и у версии: история показывает, что правил агент,
# а новая версия заводится и тогда, когда после агента правит сам человек.
schema.register("workspace_edit_via", """
ALTER TABLE workspace_items ADD COLUMN IF NOT EXISTS updated_via TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_item_versions ADD COLUMN IF NOT EXISTS saved_via TEXT NOT NULL DEFAULT '';
""")
EDIT_VIA: ContextVar[str] = ContextVar("workspace_edit_via", default="")

# В списке содержимого нет: снимок документа весит сотни килобайт, а списку нужны название, дата и фрагмент.
LIST_COLUMNS = """id::text AS id, kind, title, pinned, is_template, meta, owner_id, access_level, access_mode,
    created_at::text AS created_at, updated_at::text AS updated_at,
    GREATEST(octet_length(content), content_size) AS size_bytes, left(regexp_replace(text_content, '\\s+', ' ', 'g'), 160) AS snippet"""
FULL_COLUMNS = LIST_COLUMNS + ", content, content_key, updated_by"

_CONTROL = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f]")
_TAGS = re.compile(r"<[^>]+>")
_NOTE_TAB = re.compile(r"<!-- shar-tab: (.*?) -->")


class WorkspaceError(Exception):
    """Ошибка, которую роутер превращает в ответ: (код HTTP, сообщение)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def text_of(kind: str, content: str) -> str:
    """Текст для поиска и фрагмента в списке. Формат разбирается мягко: битый JSON — пустой текст."""
    if kind == "note":
        # Служебные строки вкладок заметки (см. клиент lib/noteTabs) — в тексте для поиска остаются их названия.
        return _NOTE_TAB.sub(r"", content)
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
    if kind == "table":
        return _table_text(content)
    return ""


MAX_TABLE_TEXT = 200_000


def _table_text(content: str) -> str:
    """Текст таблицы для поиска: значения ячеек по строкам. Большие книги не разбираем — поиск не должен тормозить запись."""
    if not content or len(content) > 4 * 1024 * 1024:
        return ""
    try:
        import base64
        import io

        from openpyxl import load_workbook

        book = load_workbook(io.BytesIO(base64.b64decode(content)), read_only=True, data_only=True)
        lines: list[str] = []
        size = 0
        for sheet in book.worksheets:
            for row in sheet.iter_rows(values_only=True):
                line = " | ".join(str(v) for v in row if v not in (None, ""))
                if line:
                    lines.append(line)
                    size += len(line)
                if size > MAX_TABLE_TEXT:
                    return "\n".join(lines)
        return "\n".join(lines)
    except Exception as exc:  # noqa: BLE001 — битая книга: без текста для поиска, но сохраняется
        log.debug("workspace: table text failed: %s", exc)
        return ""


# ── поиск ────────────────────────────────────────────────────────────────────
# Один поиск для «Офиса», Spotlight и агента: все слова запроса (в любом порядке) — в названии или тексте; слово
# без окончания («казани» → «каза», «туры» → «тур»), чтобы находилась любая форма; совпадение в названии выше.

_WORD = re.compile(r"\w+", re.UNICODE)


def search_terms(query: str) -> list[str]:
    terms: list[str] = []
    for word in _WORD.findall(query.lower())[:8]:
        stem = word if word.isdigit() or len(word) <= 4 else word[:-2] if len(word) > 6 else word[:-1]
        if stem not in terms:
            terms.append(stem)
    return terms


def _like(term: str) -> str:
    return "%" + re.sub(r"([!%_])", r"!\1", term) + "%"


def search_sql(query: str, alias: str = "i") -> tuple[str, list[Any], str, list[Any], str, list[Any]]:
    """(условие, параметры; ранг, параметры; кусок текста у первого совпадения, параметры). Пустой запрос — ('', …)."""
    terms = search_terms(query)
    if not terms:
        return "", [], "0", [], "''", []
    a = alias
    where = " AND ".join(f"({a}.title ILIKE %s ESCAPE '!' OR {a}.text_content ILIKE %s ESCAPE '!')" for _ in terms)
    where_params: list[Any] = [p for t in terms for p in (_like(t), _like(t))]
    phrase = _like(query.strip().lower())
    rank = (f"(CASE WHEN {a}.title ILIKE %s ESCAPE '!' THEN 100 ELSE 0 END)"
            + "".join(f" + (CASE WHEN {a}.title ILIKE %s ESCAPE '!' THEN 10 ELSE 0 END)" for _ in terms)
            + f" + (CASE WHEN {a}.text_content ILIKE %s ESCAPE '!' THEN 5 ELSE 0 END)")
    rank_params: list[Any] = [phrase, *[_like(t) for t in terms], phrase]
    hit = f"substring({a}.text_content from greatest(1, strpos(lower({a}.text_content), %s) - 80) for 260)"
    return where, where_params, rank, rank_params, hit, [terms[0]]


def search_snippet(hit: str | None, fallback: str) -> str:
    """Кусок у совпадения — без переносов, с «…» по краям обрезанного."""
    text = re.sub(r"\s+", " ", hit or "").strip()
    return f"…{text}…" if text else fallback


def reindex_text(kinds: tuple[str, ...] = ("table",)) -> int:
    """Пересчитать текст для поиска у уже сохранённых материалов (таблицам он раньше не считался). Возвращает число строк."""
    done = 0
    for row in db.conn.fetch_all("SELECT id::text AS id FROM workspace_items WHERE kind = ANY(%s)", (list(kinds),)) or []:
        full = get_row(row["id"])
        if not full:
            continue
        db.conn.execute_query("UPDATE workspace_items SET text_content = %s WHERE id = %s", (text_of(full["kind"], full["content"] or ""), int(row["id"])))
        done += 1
    return done


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
    """Условие «пользователь видит материал»; параметры — visible_params(user_id). Через открытую папку виден
    только материал её владельца, который он сам туда положил: папкой нельзя раздать чужое."""
    return (f"({alias}.owner_id = %s OR {alias}.access_level = 'all' "
            f"OR EXISTS (SELECT 1 FROM workspace_item_shares s WHERE s.item_id = {alias}.id AND s.user_id = %s) "
            f"OR EXISTS (SELECT 1 FROM workspace_item_dept_shares d WHERE d.item_id = {alias}.id AND d.department_id = ANY(%s)) "
            f"OR EXISTS (SELECT 1 FROM workspace_item_folder fx WHERE fx.item_id = {alias}.id AND fx.user_id = {alias}.owner_id "
            f"AND fx.folder_id = ANY(%s)))")


def visible_params(user_id: str) -> list[Any]:
    depts = user_dept_ids(user_id)
    return [user_id, user_id, depts, list(shared_folder_roles(user_id, depts))]


def shared_folder_roles(user_id: str, depts: list[str] | None = None) -> dict[int, str]:
    """Чужие папки, открытые человеку (поимённо или его отделу), вместе со всеми вложенными: {id папки: право}.
    Право наследуется вниз; если папка открыта и на чтение, и на правку — правка."""
    if depts is None:
        depts = user_dept_ids(user_id)
    try:
        rows = db.conn.fetch_all(
            """WITH RECURSIVE base AS (
                   SELECT s.folder_id AS id, s.role FROM workspace_folder_shares s WHERE s.user_id = %s
                   UNION ALL
                   SELECT d.folder_id, d.role FROM workspace_folder_dept_shares d WHERE d.department_id = ANY(%s)
               ), tree AS (
                   SELECT id, role FROM base
                   UNION
                   SELECT f.id, t.role FROM workspace_folders f JOIN tree t ON f.parent_id = t.id
               )
               SELECT t.id, t.role FROM tree t JOIN workspace_folders f ON f.id = t.id WHERE f.owner_id <> %s""",
            (user_id, depts, user_id),
        ) or []
    except Exception as exc:  # таблиц ещё нет (старая база до папок) — открытых папок просто нет
        log.debug("workspace: folder shares unavailable (%s)", exc)
        return {}
    out: dict[int, str] = {}
    for r in rows:
        fid = int(r["id"])
        out[fid] = "edit" if r["role"] == "edit" or out.get(fid) == "edit" else "view"
    return out


def inherited_shares(start_folder_id: int | None) -> list[dict[str, Any]]:
    """Кому открыты папки от start_folder_id (включительно) и выше: доступ к папке наследуют вложенные папки и
    материалы в них, поэтому в окне доступа они должны быть видны, хоть выданы не здесь. Каждая запись знает, через
    какую папку пришла: {kind: user|department, id, name, role, members?, folderId, folderTitle}."""
    if start_folder_id is None:
        return []
    try:
        chain = db.conn.fetch_all(
            """WITH RECURSIVE up AS (
                   SELECT id, parent_id, title, 0 AS depth FROM workspace_folders WHERE id = %s
                   UNION ALL
                   SELECT p.id, p.parent_id, p.title, up.depth + 1 FROM workspace_folders p JOIN up ON p.id = up.parent_id
               ) SELECT id, title FROM up ORDER BY depth""", (int(start_folder_id),)) or []
        if not chain:
            return []
        ids = [int(r["id"]) for r in chain]
        titles = {int(r["id"]): r["title"] or "" for r in chain}
        order = {fid: i for i, fid in enumerate(ids)}
        users = db.conn.fetch_all("SELECT folder_id, user_id, role FROM workspace_folder_shares WHERE folder_id = ANY(%s)", (ids,)) or []
        depts = db.conn.fetch_all("SELECT folder_id, department_id, role FROM workspace_folder_dept_shares WHERE folder_id = ANY(%s)", (ids,)) or []
    except Exception as exc:  # таблиц папок ещё нет — наследовать нечего
        log.debug("workspace: inherited shares unavailable (%s)", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in sorted(users, key=lambda r: order[int(r["folder_id"])]):
        user = db.get_user_by_id(str(r["user_id"])) or {}
        out.append({"kind": "user", "id": str(r["user_id"]), "name": user.get("name") or user.get("username") or "", "role": r["role"],
                    "folderId": str(r["folder_id"]), "folderTitle": titles[int(r["folder_id"])]})
    names = {str(d["id"]): d["name"] for d in (db.get_departments() or [])} if depts else {}
    for r in sorted(depts, key=lambda r: order[int(r["folder_id"])]):
        dept = str(r["department_id"])
        out.append({"kind": "department", "id": dept, "name": names.get(dept, dept), "role": r["role"], "members": len(dept_members([dept])),
                    "folderId": str(r["folder_id"]), "folderTitle": titles[int(r["folder_id"])]})
    return out


def folder_audience(owner_id: str) -> set[str]:
    """Кому открыта хоть одна папка владельца (поимённо и через отделы): им тоже приходят изменения раскладки."""
    try:
        users = {str(r["user_id"]) for r in db.conn.fetch_all(
            "SELECT s.user_id FROM workspace_folder_shares s JOIN workspace_folders f ON f.id = s.folder_id WHERE f.owner_id = %s", (owner_id,)) or []}
        depts = [str(r["department_id"]) for r in db.conn.fetch_all(
            "SELECT d.department_id FROM workspace_folder_dept_shares d JOIN workspace_folders f ON f.id = d.folder_id WHERE f.owner_id = %s", (owner_id,)) or []]
    except Exception:
        return set()
    return users | dept_members(depts)


def item_folder_audience(row: dict[str, Any]) -> set[str]:
    """Кому материал виден через открытые папки владельца (папка, куда он его положил, и все выше неё)."""
    try:
        chain = [int(r["id"]) for r in db.conn.fetch_all(
            """WITH RECURSIVE up AS (
                   SELECT f.id, f.parent_id FROM workspace_item_folder x JOIN workspace_folders f ON f.id = x.folder_id
                   WHERE x.item_id = %s AND x.user_id = %s
                   UNION ALL
                   SELECT p.id, p.parent_id FROM workspace_folders p JOIN up ON p.id = up.parent_id
               ) SELECT id FROM up""", (int(row["id"]), str(row["owner_id"]))) or []]
        if not chain:
            return set()
        users = {str(r["user_id"]) for r in db.conn.fetch_all("SELECT user_id FROM workspace_folder_shares WHERE folder_id = ANY(%s)", (chain,)) or []}
        depts = [str(r["department_id"]) for r in db.conn.fetch_all("SELECT department_id FROM workspace_folder_dept_shares WHERE folder_id = ANY(%s)", (chain,)) or []]
    except Exception:
        return set()
    return users | dept_members(depts)


NEW_SINCE_KEY = "workspace:new-since"


def new_since() -> str:
    """С какого момента считаем «новое»: с первого обращения после выкатки. Иначе все чужие материалы,
    которые человек когда-то видел, но не открывал, разом стали бы «новыми»."""
    from app.core import kv

    value = kv.get(NEW_SINCE_KEY) or {}
    if not value.get("at"):
        now = db.conn.fetch_one("SELECT now()::text AS t")["t"]
        value = kv.update(NEW_SINCE_KEY, {}, lambda cur: cur if (cur or {}).get("at") else {"at": now})
    return str(value["at"])


def is_new_sql(alias: str = "i") -> str:
    """«Новое» для смотрящего: материал чужой, а доступ ему открыли (лично, его отделу или всем) позже, чем он
    его последний раз открывал. Параметры — is_new_params(user_id, depts)."""
    return (f"COALESCE({alias}.owner_id <> %s AND GREATEST("
            f"(SELECT max(s.created_at) FROM workspace_item_shares s WHERE s.item_id = {alias}.id AND s.user_id = %s), "
            f"(SELECT max(d.created_at) FROM workspace_item_dept_shares d WHERE d.item_id = {alias}.id AND d.department_id = ANY(%s)), "
            f"CASE WHEN {alias}.access_level = 'all' THEN COALESCE({alias}.shared_all_at, {alias}.created_at) END"
            f") > GREATEST(%s::timestamptz, COALESCE((SELECT seen_at FROM workspace_item_seen v WHERE v.item_id = {alias}.id AND v.user_id = %s), '-infinity')), false)")


def is_new_params(user_id: str, depts: list[str]) -> list[Any]:
    return [user_id, user_id, depts, new_since(), user_id]


def mark_seen(item_id: str, user_id: str) -> None:
    """Человек открыл чужой материал — бейдж «Новое» снимается."""
    db.conn.execute_query(
        "INSERT INTO workspace_item_seen (item_id, user_id, seen_at) VALUES (%s, %s, now()) "
        "ON CONFLICT (item_id, user_id) DO UPDATE SET seen_at = now()",
        (int(item_id), user_id),
    )


def permissions(row: dict[str, Any], user_id: str, depts: list[str] | None = None,
                folder_roles: dict[int, str] | None = None) -> dict[str, Any]:
    """Что может человек с этим материалом. Правка: владелец; выданное поимённо, его отделу или через открытую
    папку владельца (если есть право на правку хоть где — правит); остальные, кто видит материал по уровню
    доступа, — по режиму материала. folder_roles — заранее посчитанные открытые папки (для списка)."""
    if str(row["owner_id"]) == user_id:
        return {"isOwner": True, "canEdit": True, "role": "owner"}
    roles = [s["role"] for s in db.conn.fetch_all("SELECT role FROM workspace_item_shares WHERE item_id = %s AND user_id = %s", (row["id"], user_id)) or []]
    if depts is None:
        depts = user_dept_ids(user_id)
    if depts:
        roles += [s["role"] for s in db.conn.fetch_all("SELECT role FROM workspace_item_dept_shares WHERE item_id = %s AND department_id = ANY(%s)", (row["id"], depts)) or []]
    # Через открытую папку: куда владелец сам положил материал (список передаёт owner_folder_id готовым).
    if "owner_folder_id" in row:
        owner_folder = row.get("owner_folder_id")
    else:
        placed = db.conn.fetch_one("SELECT folder_id FROM workspace_item_folder WHERE item_id = %s AND user_id = %s", (row["id"], str(row["owner_id"])))
        owner_folder = placed["folder_id"] if placed else None
    if owner_folder is not None:
        via_folder = (folder_roles if folder_roles is not None else shared_folder_roles(user_id, depts)).get(int(owner_folder))
        if via_folder:
            roles.append(via_folder)
    if roles:
        role = "edit" if "edit" in roles else "view"
        return {"isOwner": False, "canEdit": role == "edit", "role": role}
    if row["access_level"] == "all":
        mode = row["access_mode"]
        return {"isOwner": False, "canEdit": mode != "view", "role": "view" if mode == "view" else "edit"}
    return {"isOwner": False, "canEdit": False, "role": None}


def present(row: dict[str, Any], user_id: str | None = None, *, with_content: bool = False,
            depts: list[str] | None = None, owners: dict[str, dict[str, Any]] | None = None,
            folder_roles: dict[int, str] | None = None) -> dict[str, Any]:
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
        "isNew": bool(row.get("is_new")),
        "folderId": row.get("folder_id"),
        "folderPosition": row.get("folder_position"),
        "rootPosition": row.get("root_position"),
    }
    if user_id is not None:
        out.update(permissions(row, user_id, depts, folder_roles))
    if with_content:
        out["content"] = row["content"]
    return out


_tables_seen: dict[str, float] = {}


def table_ready(name: str) -> bool:
    """Есть ли таблица в базе. На проде схему применяют вручную (SHAR_AUTO_MIGRATE=0): код, вышедший раньше своей
    таблицы, не должен ломать то, что работало без неё. Есть — помним навсегда, нет — перепроверяем раз в минуту."""
    seen = _tables_seen.get(name)
    if seen == float("inf") or (seen is not None and time.monotonic() - seen < 60):
        return seen == float("inf")
    row = db.conn.fetch_one("SELECT to_regclass(%s) IS NOT NULL AS ok", (name,))
    ok = bool(row and row.get("ok"))
    _tables_seen[name] = float("inf") if ok else time.monotonic()
    return ok


def column_ready(table: str, column: str) -> bool:
    """Есть ли столбец (как table_ready: код, вышедший раньше схемы, работает и без него)."""
    name = f"{table}.{column}"
    seen = _tables_seen.get(name)
    if seen == float("inf") or (seen is not None and time.monotonic() - seen < 60):
        return seen == float("inf")
    row = db.conn.fetch_one("SELECT 1 AS ok FROM information_schema.columns WHERE table_name = %s AND column_name = %s", (table, column))
    _tables_seen[name] = float("inf") if row else time.monotonic()
    return bool(row)


def via_ready() -> bool:
    return column_ready("workspace_items", "updated_via") and column_ready("workspace_item_versions", "saved_via")


def get_row(item_id: str, *, full: bool = True, content: bool = True) -> Optional[dict[str, Any]]:
    """content=False: все поля, кроме содержимого из S3 (для проверки прав и служебных запросов)."""
    if not str(item_id).isdigit():
        return None
    columns = (FULL_COLUMNS + (", updated_via" if via_ready() else "")) if full else LIST_COLUMNS
    row = db.conn.fetch_one(f"SELECT {columns} FROM workspace_items i WHERE id = %s", (int(item_id),))
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
    return users | dept_members(depts) | item_folder_audience(row)


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
    previous_via = row.get("updated_via") or ""
    if not force and last:
        gap = float(last["gap"] or 0)
        # Тот же человек тем же способом — правки копятся в одну версию; сменился человек или способ (сам ↔ агент) — новая.
        if previous_author == editor and previous_via == EDIT_VIA.get() and gap < VERSION_GAP_SECONDS:
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
    via = via_ready()
    db.conn.execute_query(
        f"""INSERT INTO workspace_item_versions (item_id, title, content, content_key, content_size, saved_by, label, created_at{', saved_via' if via else ''})
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s::timestamptz{', %s' if via else ''})""",
        (item_id, row.get("title") or "", "" if key else content, key, len(content.encode("utf-8")) if content else int(row.get("size_bytes") or 0),
         previous_author, label[:80], row["updated_at"], *([previous_via] if via else [])),
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


def viewers_many(item_ids: list[str], *, exclude: str = "") -> dict[str, list[dict[str, Any]]]:
    """Кто сейчас в каждом из материалов — одним походом в Redis (для строк списка). Только непустые."""
    if not item_ids:
        return {}
    raw: dict[str, list[tuple[str, bool]]] = {}
    if presence._redis is not None:
        try:
            now = presence._now()
            pipe = presence._redis.pipeline()
            for item_id in item_ids:
                pipe.zrangebyscore(f"shar:wsp:{item_id}", now - PRESENCE_TTL, "+inf")
                pipe.hgetall(f"shar:wspe:{item_id}")
            res = pipe.execute()
            for index, item_id in enumerate(item_ids):
                members, flags = res[2 * index] or [], res[2 * index + 1] or {}
                raw[item_id] = [(m, flags.get(m) == "1") for m in members]
        except Exception as exc:
            log.debug("workspace presence: redis unavailable (%s)", exc)
            raw = {}
    if not raw:
        raw = {item_id: presence.viewers(item_id) for item_id in item_ids}
    user_ids = sorted({uid for pairs in raw.values() for uid, _ in pairs if uid != exclude})
    if not user_ids:
        return {}
    users = {str(u["id"]): u for u in (db.conn.fetch_all("SELECT id, name, username, avatar FROM users WHERE id = ANY(%s)", (user_ids,)) or [])}
    out: dict[str, list[dict[str, Any]]] = {}
    for item_id, pairs in raw.items():
        people = [{"userId": uid, "name": (users.get(uid) or {}).get("name") or (users.get(uid) or {}).get("username") or uid,
                   "avatar": (users.get(uid) or {}).get("avatar") or "", "editing": editing} for uid, editing in pairs if uid != exclude]
        if people:
            out[item_id] = people
    return out


def announce_presence(row: dict[str, Any], viewers: list[dict[str, Any]]) -> None:
    """Состав присутствующих изменился — всем, кто видит материал: строка списка обновит аватарки. Не ломает запрос."""
    try:
        from app.core.realtime import sse_manager

        payload = {"type": "workspace_presence_list", "itemId": str(row["id"]), "viewers": viewers}
        for uid in audience(row):
            sse_manager.push(uid, payload)
    except Exception as exc:
        log.debug("workspace: presence announce failed: %s", exc)


def viewer_list(item_id: str) -> list[dict[str, Any]]:
    out = []
    for uid, editing in presence.viewers(item_id):
        user = db.get_user_by_id(uid) or {}
        out.append({"userId": uid, "name": user.get("name") or user.get("username") or uid, "avatar": user.get("avatar") or "", "editing": editing})
    return out


CURSOR_MAX_BYTES = 600


def relay_cursor(user_id: str, frame: dict[str, Any]) -> None:
    """Курсор и выделение коллеги, как в Google Docs: кадр из сокета раздаём остальным, кто сейчас в материале.

    Ничего не храним. Доступ не перепроверяем каждый раз: в присутствие попадает только тот, кому материал виден
    (set_presence), а кто не в материале — того кадр молча отбрасывается. Позицию понимает только редактор
    того же вида, сервер её не разбирает — лишь ограничивает размер.
    """
    item_id = str(frame.get("itemId") or "")
    if not item_id.isdigit():
        return
    cursor = frame.get("cursor")
    if cursor is not None and (not isinstance(cursor, dict) or len(json.dumps(cursor)) > CURSOR_MAX_BYTES):
        return
    viewers = [uid for uid, _ in presence.viewers(item_id)]
    if user_id not in viewers:
        return
    try:
        from app.core.realtime import sse_manager

        payload = {"type": "workspace_cursor", "itemId": item_id, "userId": user_id, "cursor": cursor}
        for uid in viewers:
            if uid != user_id:
                sse_manager.push(uid, payload)
    except Exception as exc:
        log.debug("workspace: cursor relay failed: %s", exc)


def push_to_viewers(item_id: str, payload: dict[str, Any], *, exclude: str = "") -> None:
    """Живое событие тем, кто сейчас открыл материал. Не ломает запрос."""
    try:
        from app.core.realtime import sse_manager

        for uid, _ in presence.viewers(item_id):
            if uid != exclude:
                sse_manager.push(uid, payload)
    except Exception as exc:
        log.warning("workspace: could not push live event: %s", exc)
