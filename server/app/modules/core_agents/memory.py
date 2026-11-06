"""Что агент знает о человеке и о компании: профиль, память и навыки. Живёт в базе Шара, а не на ноде: нода — только
руки, сменить её или войти в другого агента (Claude → GPT → Gemini) — человек не начинает с нуля.

  профиль   один Markdown на человека: кто он, как с ним работать, что он поправлял за агентом. Агент дописывает
            наблюдения сам (profile_note), человек видит и правит текст целиком в Настройках → Ядро.
  память    короткие факты с метками: решения, договорённости, «где что лежит». Агент ищет по словам (memory_search).
            Запись бывает личной или общей для компании (shared): общее видят агенты всех сотрудников — как память
            проекта в MBOX, только масштаб — компания в Шаре. Удалить общее может её автор или админ.
  навыки    инструкции «как делать X» (SKILL.md по образцу Anthropic и Gemini CLI): название, когда применять, тело.
            Агент пишет их сам, когда задача повторяется, человек может выключить или поправить. Общие навыки
            компании (user_id = COMPANY) видят все; свой навык с тем же именем перекрывает общий.

Каждый запуск агента получает профиль, свежее из общей памяти и оглавление навыков (prompt_context) — дальше читает
по надобности.

  GET    /api/core/memory                  профиль, память (своя и общая), навыки
  PUT    /api/core/memory/profile          {text}
  DELETE /api/core/memory/notes/{id}
  GET    /api/core/memory/skills/{name}
  PUT    /api/core/memory/skills/{name}    {description, body, enabled, shared?}
  DELETE /api/core/memory/skills/{name}?shared=1
"""

from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.security import Identity, current_identity

router = APIRouter()

PROFILE_MAX = 12_000
PROMPT_PROFILE = 2_500
PROMPT_PASSPORT = 1_600
# Общая запись с этим тегом — паспорт компании, целиком в начале каждого запуска; с тегом «о компании» — справочник.
PASSPORT_TAG = "паспорт"
REFERENCE_TAG = "о компании"
NOTE_MAX = 2_000
SKILL_MAX = 20_000
NOTES_KEEP = 2_000
SKILLS_MAX = 100
SKILL_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$")
# Общее для всей компании: навыки, которые видят агенты всех сотрудников, хранятся под этим user_id.
COMPANY = "*company*"

schema.register("core_memory", """
CREATE TABLE IF NOT EXISTS core_profiles (
    user_id TEXT PRIMARY KEY,
    body TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS core_notes (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT[] NOT NULL DEFAULT '{}',
    actor TEXT NOT NULL DEFAULT '',
    shared BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Текст в нижнем регистре для поиска: lower() базы с локалью C не трогает кириллицу.
ALTER TABLE core_notes ADD COLUMN IF NOT EXISTS search TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_core_notes_user ON core_notes(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_core_notes_shared ON core_notes(id DESC) WHERE shared;
CREATE TABLE IF NOT EXISTS core_skills (
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT true,
    uses INTEGER NOT NULL DEFAULT 0,
    actor TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, name)
);
""")


class MemoryError_(Exception):
    """Ошибка для агента — текстом."""


# ── профиль ──────────────────────────────────────────────────────────────────

def profile(user_id: str) -> str:
    row = db.conn.fetch_one("SELECT body FROM core_profiles WHERE user_id = %s", (user_id,))
    return (row or {}).get("body") or ""


def set_profile(user_id: str, text: str, actor: str) -> None:
    db.conn.execute_query(
        "INSERT INTO core_profiles (user_id, body, updated_by) VALUES (%s, %s, %s) "
        "ON CONFLICT (user_id) DO UPDATE SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()",
        (user_id, text[:PROFILE_MAX], actor))


def profile_note(user_id: str, section: str, text: str, actor: str, *, keep: int = 0) -> str:
    """Дописать наблюдение в раздел профиля (## section). Повтор того же — не дублируем. keep — сколько последних пунктов
    оставлять в разделе (0 — без ограничения): так оценки и поправки не раздувают профиль, свежее важнее давнего."""
    text = " ".join(str(text).split())[:600]
    section = " ".join(str(section).split())[:60] or "Наблюдения"
    if not text:
        raise MemoryError_("Пустое наблюдение")
    body = profile(user_id)
    if text in body:
        return body
    heading = f"## {section}"
    if heading in body:
        start = body.index(heading) + len(heading)
        nxt = body.find("\n## ", start)
        body = f"{body[:nxt].rstrip()}\n- {text}\n{body[nxt:]}" if nxt >= 0 else f"{body.rstrip()}\n- {text}\n"
    else:
        body = f"{body.rstrip()}\n\n{heading}\n- {text}\n" if body.strip() else f"{heading}\n- {text}\n"
    if keep:
        body = _trim_section(body, heading, keep)
    if len(body) > PROFILE_MAX:
        raise MemoryError_("Профиль переполнен: сожмите его (profile_write) — объедините похожие пункты")
    set_profile(user_id, body, actor)
    return body


def _trim_section(body: str, heading: str, keep: int) -> str:
    """В разделе heading оставить последние keep пунктов («- …»); остальной профиль не трогаем."""
    start = body.find(heading)
    if start < 0:
        return body
    end = body.find("\n## ", start + len(heading))
    end = len(body) if end < 0 else end
    lines = body[start:end].split("\n")
    items = [i for i, line in enumerate(lines) if line.startswith("- ")]
    drop = set(items[:-keep]) if len(items) > keep else set()
    if not drop:
        return body
    return body[:start] + "\n".join(line for i, line in enumerate(lines) if i not in drop) + body[end:]


# ── память ───────────────────────────────────────────────────────────────────

def add_note(user_id: str, text: str, tags: list[str], actor: str, shared: bool = False) -> dict:
    text = str(text).strip()[:NOTE_MAX]
    if not text:
        raise MemoryError_("Пустая запись")
    clean = [t.strip().lower()[:30] for t in tags if str(t).strip()][:8]
    # Тот же факт второй раз не копим: агент пересказывает известное, и память зарастала повторами, из-за которых
    # поиск отдавал одно и то же. Совпало слово в слово — освежаем запись и дополняем метки.
    # lower() базы с локалью C не трогает кириллицу — сравниваем по полю search (оно уже в нижнем регистре, его пишем сами).
    low = text.lower()
    candidates = db.conn.fetch_all(
        "SELECT id, body, tags, created_at FROM core_notes WHERE user_id = %s AND shared = %s AND left(search, %s) = %s LIMIT 20",
        (user_id, shared, len(low), low)) or []
    same = next((c for c in candidates if str(c["body"]).lower() == low), None)
    if same:
        merged = list(dict.fromkeys([*(same["tags"] or []), *clean]))[:8]
        db.conn.execute_query("UPDATE core_notes SET tags = %s, search = %s, created_at = now() WHERE id = %s",
                              (merged, f"{text} {' '.join(merged)}".lower(), same["id"]))
        return {"id": str(same["id"]), "createdAt": same["created_at"].isoformat(), "shared": shared, "duplicate": True}
    row = db.conn.fetch_one(
        "INSERT INTO core_notes (user_id, body, search, tags, actor, shared) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id, created_at",
        (user_id, text, f"{text} {' '.join(clean)}".lower(), clean, actor, shared))
    db.conn.execute_query(
        "DELETE FROM core_notes WHERE user_id = %s AND NOT shared AND id < "
        "(SELECT id FROM core_notes WHERE user_id = %s AND NOT shared ORDER BY id DESC OFFSET %s LIMIT 1)",
        (user_id, user_id, NOTES_KEEP))
    return {"id": str(row["id"]), "createdAt": row["created_at"].isoformat(), "shared": shared}


def search_notes(user_id: str, query: str = "", tag: str = "", limit: int = 20, scope: str = "all") -> list[dict]:
    """Поиск по словам: запись подходит, если в ней есть все слова (по началу слова — «отпуск» найдёт «отпуска»).
    scope: all — свои и общие, mine — только свои, company — только общие."""
    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 2][:6]
    where = [{"mine": "user_id = %s AND NOT shared", "company": "shared AND %s <> ''"}.get(scope, "(user_id = %s OR shared)")]
    params: list = [user_id]
    # Слово ищется с начала слова: «инн» найдёт «ИНН», но не «длинные». Буквы перечислены явно — база может быть в локали C.
    stems = [word[:max(4, len(word) - 2)] for word in words]
    for stem in stems:
        where.append("search ~ %s")
        params.append(f"(^|[^0-9a-zа-яё]){re.escape(stem)}")
    if tag:
        where.append("%s = ANY(tags)")
        params.append(tag.lower())
    # Выше — записи, у которых слова есть в заголовке (первые ~120 знаков), затем свежие.
    rank = " + ".join(["(position(%s in left(search, 120)) > 0)::int"] * len(stems))
    rows = db.conn.fetch_all(
        f"SELECT id, user_id, body, tags, actor, shared, created_at FROM core_notes WHERE {' AND '.join(where)} "
        f"ORDER BY {f'{rank} DESC, ' if rank else ''}id DESC LIMIT %s",
        (*params, *stems, max(1, min(limit, 200)))) or []
    return [{"id": str(r["id"]), "text": r["body"], "tags": list(r["tags"] or []), "by": r["actor"], "shared": r["shared"],
             "mine": r["user_id"] == user_id, "at": r["created_at"].isoformat()} for r in rows]


_STOP = {"это", "как", "что", "для", "или", "при", "еще", "ещё", "мне", "нам", "его", "ней", "над", "про", "все", "всё", "так", "там", "тут",
         "надо", "нужно", "можно", "сделай", "сделать", "пожалуйста", "который", "которые", "когда", "если", "чтобы", "очень"}


def _stems(text: str, limit: int = 8) -> list[str]:
    """Основы значимых слов запроса (первые 5–6 букв): «отпуска» и «отпуск» — одна основа."""
    out: list[str] = []
    for word in re.findall(r"[0-9a-zа-яё]+", str(text).lower()):
        if len(word) < 4 or word in _STOP:
            continue
        stem = word[:max(4, len(word) - 2)][:6]
        if stem not in out:
            out.append(stem)
    return out[:limit]


def recall(user_id: str, ask: str, *, notes: int = 4, skills_n: int = 2) -> str:
    """Память по теме просьбы — сразу в сообщение агенту. Раньше агент вспоминал сам (memory_search) и чаще не вспоминал:
    полезное лежало в базе, а ответ шёл без него. Подходит запись, если в ней есть основы хотя бы двух слов просьбы
    (одного, если слов мало); выше — те, где совпало больше. Пусто — блока нет."""
    stems = _stems(ask)
    if not stems:
        return ""
    need = 2 if len(stems) >= 3 else 1
    rows = db.conn.fetch_all(
        "SELECT id, body, tags, shared, search FROM core_notes WHERE user_id = %s OR shared ORDER BY id DESC LIMIT 600", (user_id,)) or []
    scored = []
    for r in rows:
        hay = r["search"] or ""
        score = sum(1 for s in stems if re.search(r"(^|[^0-9a-zа-яё])" + re.escape(s), hay))
        if score >= need:
            scored.append((score, int(r["id"]), r))
    scored.sort(key=lambda x: (-x[0], -x[1]))
    lines = [f"- {r['body'][:220]}{' (общее)' if r['shared'] else ''}" for _, _, r in scored[:notes]]
    picked = []
    for sk in skills(user_id, enabled_only=True):
        hay = f"{sk['name'].replace('-', ' ')} {sk['description']}".lower()
        score = sum(1 for s in stems if re.search(r"(^|[^0-9a-zа-яё])" + re.escape(s), hay))
        if score >= need:
            picked.append((score, sk))
    picked.sort(key=lambda x: -x[0])
    if not lines and not picked:
        return ""
    parts = ["Из памяти по теме просьбы (может пригодиться; свежее слово человека важнее):"]
    parts += lines
    for _, sk in picked[:skills_n]:
        parts.append(f"- Навык «{sk['name']}» — {sk['description'][:140]}: прочитайте skill_read, прежде чем делать.")
    return "\n".join(parts)


FEEDBACK_KEEP = 8


def learn_from_feedback(user_id: str, ask: str, rating: int, reason: str = "", answer: str = "") -> None:
    """Оценка ответа (👍/👎 с причиной) — урок на будущее. Причина — в профиль («Поправки») и в память с тегом, чтобы её
    нашёл и recall, и memory_search; удача — в «Что получается хорошо». Без причины 👎 не пишем: «не то» без «почему»
    научить нечему. Профиль разделов держит не больше FEEDBACK_KEEP свежих пунктов."""
    ask = " ".join(str(ask or "").split())[:140]
    reason = " ".join(str(reason or "").split())[:300]
    if rating < 0 and reason:
        text = f"{reason} (запрос: «{ask}»)" if ask else reason
        profile_note(user_id, "Поправки: что было не так в ответах", text, "оценка", keep=FEEDBACK_KEEP)
        add_note(user_id, f"Поправка человека: {text}", ["оценка", "поправка"], "оценка")
    elif rating > 0 and len(ask) >= 12:
        text = f"Ответ на «{ask}» понравился — так и продолжать"
        profile_note(user_id, "Что получается хорошо", text, "оценка", keep=FEEDBACK_KEEP)


def delete_note(user_id: str, note_id: str, *, admin: bool = False) -> bool:
    """Свою запись — всегда; общую — её автор или админ."""
    if not str(note_id).isdigit():
        return False
    return bool(db.conn.fetch_one("DELETE FROM core_notes WHERE id = %s AND (user_id = %s OR (shared AND %s)) RETURNING id",
                                  (int(note_id), user_id, admin)))


# ── навыки ───────────────────────────────────────────────────────────────────

def skills(user_id: str, *, enabled_only: bool = False) -> list[dict]:
    """Свои навыки и общие навыки компании; свой с тем же именем перекрывает общий."""
    rows = db.conn.fetch_all(
        "SELECT user_id, author_id, name, description, enabled, uses, actor, updated_at, length(body) AS size FROM core_skills "
        "WHERE user_id IN (%s, %s)" + (" AND enabled" if enabled_only else "") + " ORDER BY uses DESC, name", (user_id, COMPANY)) or []
    own = {r["name"] for r in rows if r["user_id"] == user_id}
    return [{"name": r["name"], "description": r["description"], "enabled": r["enabled"], "uses": r["uses"], "by": r["actor"],
             "shared": r["user_id"] == COMPANY, "mine": r["user_id"] == user_id or r["author_id"] == user_id,
             "updatedAt": r["updated_at"].isoformat(), "size": r["size"]}
            for r in rows if r["user_id"] == user_id or r["name"] not in own]


def skill(user_id: str, name: str, *, count_use: bool = False) -> Optional[dict]:
    row = db.conn.fetch_one(
        "SELECT * FROM core_skills WHERE user_id IN (%s, %s) AND name = %s ORDER BY (user_id = %s) DESC LIMIT 1",
        (user_id, COMPANY, name, user_id))
    if not row:
        return None
    if count_use:
        db.conn.execute_query("UPDATE core_skills SET uses = uses + 1 WHERE user_id = %s AND name = %s", (row["user_id"], name))
    return {"name": row["name"], "description": row["description"], "body": row["body"], "enabled": row["enabled"],
            "uses": row["uses"] + (1 if count_use else 0), "shared": row["user_id"] == COMPANY, "authorId": row["author_id"]}


def write_skill(user_id: str, name: str, description: str, body: str, actor: str, enabled: Optional[bool] = None,
                *, shared: bool = False) -> dict:
    """Свой навык или общий (shared): общий правит его автор или админ — это проверяет вызывающий."""
    name = str(name).strip().lower()
    if not SKILL_NAME.match(name):
        raise MemoryError_("Имя навыка: 3–50 символов, латиница в нижнем регистре, цифры и дефис (например, tour-summary)")
    description = " ".join(str(description).split())[:400]
    body = str(body)[:SKILL_MAX]
    if not description or not body.strip():
        raise MemoryError_("Нужны описание (когда применять) и тело навыка (как делать)")
    owner = COMPANY if shared else user_id
    exists = db.conn.fetch_one("SELECT author_id FROM core_skills WHERE user_id = %s AND name = %s", (owner, name))
    if not exists:
        count = db.conn.fetch_one("SELECT count(*)::int AS n FROM core_skills WHERE user_id = %s", (owner,))["n"]
        if count >= SKILLS_MAX * (5 if shared else 1):
            raise MemoryError_("Навыков слишком много: обновите или объедините существующие")
    db.conn.execute_query(
        "INSERT INTO core_skills (user_id, name, description, body, actor, author_id, enabled) VALUES (%s, %s, %s, %s, %s, %s, COALESCE(%s, true)) "
        "ON CONFLICT (user_id, name) DO UPDATE SET description = EXCLUDED.description, body = EXCLUDED.body, "
        "actor = EXCLUDED.actor, enabled = COALESCE(%s, core_skills.enabled), updated_at = now()",
        (owner, name, description, body, actor, user_id, enabled, enabled))
    return {"name": name, "created": not exists, "shared": shared}


def shared_skill_author(name: str) -> Optional[str]:
    row = db.conn.fetch_one("SELECT author_id FROM core_skills WHERE user_id = %s AND name = %s", (COMPANY, name))
    return None if row is None else str(row["author_id"] or "")


def delete_skill(user_id: str, name: str, *, shared: bool = False) -> bool:
    return bool(db.conn.fetch_one("DELETE FROM core_skills WHERE user_id = %s AND name = %s RETURNING name",
                                  (COMPANY if shared else user_id, name)))


# ── для запуска агента ───────────────────────────────────────────────────────

def prompt_context(user_id: str) -> str:
    """Начало каждого запуска: профиль, свежее из общей памяти и оглавление навыков (тела — по skill_read,
    чтобы не жечь контекст)."""
    # Коротко: этот блок едет в каждую новую сессию. Полное — инструментами (profile_read, memory_search, skill_list).
    parts = []
    body = profile(user_id).strip()
    if len(body) > PROMPT_PROFILE:
        body = body[:PROMPT_PROFILE].rsplit("\n", 1)[0] + "\n… (целиком — profile_read)"
    parts.append("## Профиль человека (ведёте вы: profile_note / profile_write)\n" + (body or "Пока пусто — заполняйте по ходу работы."))
    # Паспорт компании (общая запись с тегом «паспорт») — целиком: агент сразу знает, где работает.
    passport = search_notes(user_id, tag=PASSPORT_TAG, limit=1, scope="company")
    if passport:
        parts.append("## О компании (подробнее — memory_search)\n" + passport[0]["text"][:PROMPT_PASSPORT])
    # Справочник (паспорт и записи с тегом «о компании») агент ищет сам — в «свежее» он не попадает.
    latest = [n for n in search_notes(user_id, limit=30, scope="company")
              if PASSPORT_TAG not in n["tags"] and REFERENCE_TAG not in n["tags"]][:6]
    if latest:
        parts.append("## Свежее в общей памяти компании (всё — memory_search)\n" + "\n".join(f"- {n['text'][:140]}" for n in latest))
    active = skills(user_id, enabled_only=True)
    if active:
        parts.append("## Навыки (прочитать перед применением: skill_read; все — skill_list)\n"
                     + "\n".join(f"- {s['name']}{' (общий)' if s['shared'] else ''}: {s['description'][:120]}" for s in active[:25]))
    try:
        from app.modules.studio.router import prompt_block

        block = prompt_block(user_id)
        if block:
            parts.append(block)
    except Exception:  # noqa: BLE001 — студия необязательна для запуска агента
        pass
    return "\n\n".join(parts)


# ── REST для настроек ────────────────────────────────────────────────────────

class ProfileBody(BaseModel):
    text: str = Field(default="", max_length=PROFILE_MAX)


class SkillBody(BaseModel):
    description: str = Field(default="", max_length=400)
    body: str = Field(default="", max_length=SKILL_MAX)
    enabled: Optional[bool] = None
    shared: bool = False


def _ready() -> None:
    from app.modules.workspace import store  # поздний импорт: workspace тянет S3

    if not store.table_ready("core_skills"):
        raise HTTPException(status_code=503, detail="Память агента ещё не включена на сервере: нужна схема (выкладка с -Schema)")


def _guard(me: Identity) -> None:
    from app.modules.core_chat.router import allowed

    if not allowed(me):
        raise HTTPException(status_code=403, detail="«Ядро» вам пока не включено")
    _ready()


def _may_edit_shared(name: str, me: Identity) -> None:
    author = shared_skill_author(name)
    if author is not None and author != me.user_id and not me.is_admin:
        raise HTTPException(status_code=403, detail="Общий навык правит его автор или администратор")


@router.get("/api/core/memory")
def get_memory(me: Identity = Depends(current_identity)):
    _guard(me)
    return {"profile": profile(me.user_id), "notes": search_notes(me.user_id, limit=200), "skills": skills(me.user_id),
            "canModerate": me.is_admin}


@router.put("/api/core/memory/profile")
def put_profile(body: ProfileBody, me: Identity = Depends(current_identity)):
    _guard(me)
    set_profile(me.user_id, body.text, me.display_name)
    return {"profile": profile(me.user_id)}


@router.delete("/api/core/memory/notes/{note_id}")
def remove_note(note_id: str, me: Identity = Depends(current_identity)):
    _guard(me)
    if not delete_note(me.user_id, note_id, admin=me.is_admin):
        raise HTTPException(status_code=404, detail="Запись не найдена или её удаляет автор")
    return {"ok": True}


@router.get("/api/core/memory/skills/{name}")
def get_skill(name: str, me: Identity = Depends(current_identity)):
    _guard(me)
    found = skill(me.user_id, name)
    if not found:
        raise HTTPException(status_code=404, detail="Навык не найден")
    return {"skill": found}


@router.put("/api/core/memory/skills/{name}")
def put_skill(name: str, body: SkillBody, me: Identity = Depends(current_identity)):
    _guard(me)
    if body.shared:
        _may_edit_shared(name, me)
    current = skill(me.user_id, name) or {}
    try:
        write_skill(me.user_id, name, body.description or current.get("description", ""), body.body or current.get("body", ""),
                    me.display_name, body.enabled, shared=body.shared)
    except MemoryError_ as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"skills": skills(me.user_id)}


@router.delete("/api/core/memory/skills/{name}")
def remove_skill(name: str, shared: bool = False, me: Identity = Depends(current_identity)):
    _guard(me)
    if shared:
        _may_edit_shared(name, me)
    if not delete_skill(me.user_id, name, shared=shared):
        raise HTTPException(status_code=404, detail="Навык не найден")
    return {"skills": skills(me.user_id)}
