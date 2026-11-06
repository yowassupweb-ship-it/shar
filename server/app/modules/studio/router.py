"""Студия картинок: рисование, галерея, референсы и то, чему агент учится на оценках.

Раздел открыт тем, у кого включено «Ядро» (как и сам чат с агентами): отдельной выдачи прав нет — «идёт из коробки».
Рисует тот же Gemini по ключу человека, что и MCP image_generate (core_agents/images.py), поэтому всё, что агент
нарисовал в чате, тоже попадает сюда — в галерею — и наоборот: агент видит референсы человека и его оценки.

  галерея     каждая нарисованная картинка: запрос, формат, референсы, из чего сделана (родитель), оценка (👍 / 👎 с
              причиной), избранное, заметка, метки;
  референсы   загруженные примеры — стиль, персонаж, предмет, логотип, фон: к запросу прикладываются сами;
  обучение    оценки превращаются в «что нравится / чего избегать» (insights): их видит человек в студии, они идут
              агентам в начало каждого запуска (prompt_block) и в профиль человека (memory.profile_note) — агент,
              который рисует в чате, учитывает вкус, а не начинает с нуля.

  GET    /api/studio                      галерея, референсы, выводы, подключён ли ключ
  POST   /api/studio/generate             {prompt, aspect, refs[], parentId?, useStyle?}
  PATCH  /api/studio/images/{id}          {rating?, reason?, favorite?, note?, tags?, name?}
  DELETE /api/studio/images/{id}
  POST   /api/studio/refs                 {name, kind, note, key | imageId, tags}
  PATCH  /api/studio/refs/{id}            {name?, kind?, note?, tags?}
  DELETE /api/studio/refs/{id}
"""

from __future__ import annotations

import logging
import re
import uuid
from collections import Counter
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app.core import schema
from app.core.db import db
from app.core.ratelimit import limiter
from app.core.security import Identity, current_identity

router = APIRouter()
log = logging.getLogger("shar.studio")

KINDS = {"style": "Стиль", "character": "Персонаж", "product": "Предмет", "logo": "Логотип", "scene": "Место и фон", "other": "Другое"}
MAX_REFS_PER_RUN = 6
GALLERY_LIMIT = 300

schema.register("studio", """
CREATE TABLE IF NOT EXISTS studio_images (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    aspect TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'studio',
    name TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    upload_key TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT 'image/png',
    size INTEGER NOT NULL DEFAULT 0,
    refs TEXT[] NOT NULL DEFAULT '{}',
    parent_id TEXT,
    rating SMALLINT NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    favorite BOOLEAN NOT NULL DEFAULT false,
    note TEXT NOT NULL DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE studio_images ADD COLUMN IF NOT EXISTS marks JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_studio_images_user ON studio_images (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS studio_refs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'style',
    note TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    upload_key TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT 'image/png',
    size INTEGER NOT NULL DEFAULT 0,
    tags TEXT[] NOT NULL DEFAULT '{}',
    uses INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_studio_refs_user ON studio_refs (user_id, created_at DESC);
""")


class StudioError(RuntimeError):
    """Ошибка для человека и агента — текстом."""


def ready() -> bool:
    """Таблиц может не быть: на проде схема догоняется отдельным шагом. Без них студия просто молчит."""
    try:
        from app.modules.workspace import store as ws_store

        return ws_store.table_ready("studio_images") and ws_store.table_ready("studio_refs") and ws_store.column_ready("studio_images", "marks")
    except Exception:  # noqa: BLE001
        return False


def allowed(me: Identity) -> bool:
    from app.modules.core_chat.router import allowed as core_allowed

    return core_allowed(me)


def _guard(me: Identity) -> None:
    if not allowed(me):
        raise HTTPException(status_code=403, detail="Студия открыта тем, у кого включено «Ядро» — его включает администратор")
    if not ready():
        raise HTTPException(status_code=503, detail="Студия ещё не готова: администратору нужно обновить схему базы")


# ── представление ────────────────────────────────────────────────────────────

def _image_view(r: dict) -> dict:
    return {
        "id": r["id"], "prompt": r["prompt"], "aspect": r["aspect"], "model": r["model"], "source": r["source"], "name": r["name"],
        "url": r["url"], "refs": list(r["refs"] or []), "parentId": r["parent_id"], "rating": int(r["rating"] or 0),
        "reason": r["reason"], "favorite": bool(r["favorite"]), "note": r["note"], "tags": list(r["tags"] or []),
        "marks": r.get("marks") or [], "createdAt": r["created_at"].isoformat(),
    }


def _ref_view(r: dict) -> dict:
    return {"id": r["id"], "name": r["name"], "kind": r["kind"], "kindLabel": KINDS.get(r["kind"], "Другое"), "note": r["note"],
            "url": r["url"], "tags": list(r["tags"] or []), "uses": int(r["uses"] or 0), "createdAt": r["created_at"].isoformat()}


def list_refs(user_id: str, ids: Optional[list[str]] = None) -> list[dict]:
    if ids is not None:
        rows = db.conn.fetch_all("SELECT * FROM studio_refs WHERE user_id = %s AND id = ANY(%s)", (user_id, ids)) or []
        order = {i: n for n, i in enumerate(ids)}
        rows = sorted(rows, key=lambda r: order.get(r["id"], 99))
    else:
        rows = db.conn.fetch_all("SELECT * FROM studio_refs WHERE user_id = %s ORDER BY created_at DESC LIMIT 200", (user_id,)) or []
    return [_ref_view(dict(r)) for r in rows]


def list_images(user_id: str, *, query: str = "", favorites: bool = False, limit: int = GALLERY_LIMIT) -> list[dict]:
    where, params = ["user_id = %s"], [user_id]
    if favorites:
        where.append("(favorite OR rating > 0)")
    for word in [w for w in re.findall(r"\w+", query.lower()) if len(w) > 2][:5]:
        where.append("lower(prompt || ' ' || name || ' ' || note || ' ' || array_to_string(tags, ' ')) LIKE %s")
        params.append(f"%{word}%")
    rows = db.conn.fetch_all(f"SELECT * FROM studio_images WHERE {' AND '.join(where)} ORDER BY created_at DESC LIMIT %s",
                             (*params, max(1, min(limit, 500)))) or []
    return [_image_view(dict(r)) for r in rows]


# ── метки на фото: мост «человек → агент» ────────────────────────────────────
# Человек (или агент) отмечает на фото места: точка или область и пояснение — «убрать», «светлее», «не то лицо». Координаты —
# доли ширины и высоты (0…1) от левого верхнего угла: не зависят от того, в каком размере показано фото. Метки хранятся у
# картинки; правка этой картинки получает их текстом (координаты в процентах) и схемой — копией фото с пронумерованными
# маркерами, — а агент читает их в studio_gallery и может править ровно отмеченное.

MAX_MARKS = 20


def clean_marks(raw: Any) -> list[dict]:
    """Метки из запроса → безопасный вид: до MAX_MARKS, координаты 0…1, пояснение до 300 знаков, номера по порядку."""
    out: list[dict] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            x, y = float(item.get("x")), float(item.get("y"))
        except (TypeError, ValueError):
            continue
        if not (0 <= x <= 1 and 0 <= y <= 1):
            continue
        mark: dict[str, Any] = {"n": len(out) + 1, "x": round(x, 4), "y": round(y, 4), "note": " ".join(str(item.get("note") or "").split())[:300]}
        try:
            w, h = float(item.get("w") or 0), float(item.get("h") or 0)
        except (TypeError, ValueError):
            w = h = 0.0
        if w > 0.005 and h > 0.005:  # область: правый нижний угол не дальше края фото
            mark.update(w=round(min(w, 1 - x), 4), h=round(min(h, 1 - y), 4))
        out.append(mark)
        if len(out) >= MAX_MARKS:
            break
    return out


def marks_text(marks: list[dict]) -> str:
    """Метки словами для модели и агента: координаты в процентах от левого верхнего угла."""
    lines = []
    for m in marks or []:
        pct = lambda v: f"{round(float(v) * 100)}%"  # noqa: E731
        where = (f"область от ({pct(m['x'])}, {pct(m['y'])}) размером {pct(m['w'])}×{pct(m['h'])}" if m.get("w") else f"точка ({pct(m['x'])}, {pct(m['y'])})")
        lines.append(f"{m['n']}) {where}: {m.get('note') or 'обратить внимание'}")
    if not lines:
        return ""
    return ("Правки по меткам на исходном фото (координаты — доли ширины и высоты от левого верхнего угла): " + "; ".join(lines)
            + ". Меняй только отмеченное, остальное сохрани как есть.")


def annotated_png(data: bytes, marks: list[dict]) -> Optional[bytes]:
    """Копия фото с пронумерованными маркерами — модель видит, о каком месте речь. Не получилось — None (правим по тексту)."""
    try:
        import io

        from PIL import Image, ImageDraw

        img = Image.open(io.BytesIO(data)).convert("RGB")
        img.thumbnail((1600, 1600))
        w, h = img.size
        draw = ImageDraw.Draw(img, "RGBA")
        unit = max(10, min(w, h) // 36)
        for m in marks:
            cx, cy = m["x"] * w, m["y"] * h
            if m.get("w"):
                box = (cx, cy, (m["x"] + m["w"]) * w, (m["y"] + m["h"]) * h)
                draw.rectangle(box, outline=(255, 59, 48, 255), width=max(2, unit // 5), fill=(255, 59, 48, 40))
                cx, cy = box[0] + unit * 0.6, box[1] + unit * 0.6
            draw.ellipse((cx - unit, cy - unit, cx + unit, cy + unit), fill=(255, 59, 48, 255), outline=(255, 255, 255, 255), width=2)
            label = str(m["n"])
            draw.text((cx - unit * 0.35 * len(label), cy - unit * 0.55), label, fill=(255, 255, 255, 255))
        out = io.BytesIO()
        img.save(out, "PNG")
        return out.getvalue()
    except Exception as exc:  # noqa: BLE001
        log.debug("studio: схема меток не нарисована: %s", exc)
        return None


# ── запись картинок ──────────────────────────────────────────────────────────

def record_image(user_id: str, file: dict, *, prompt: str = "", aspect: str = "", source: str = "studio", refs: Optional[list[str]] = None,
                 parent_id: Optional[str] = None) -> Optional[dict]:
    """Картинка — в галерею: из студии, из чата с агентом (MCP image_generate) или от встроенного генератора GPT.
    Не падает: галерея не должна ломать рисование."""
    try:
        if not ready():
            return None
        image_id = uuid.uuid4().hex
        row = db.conn.fetch_one(
            "INSERT INTO studio_images (id, user_id, prompt, aspect, model, source, name, url, upload_key, mime, size, refs, parent_id) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
            (image_id, user_id, str(prompt or "")[:4000], aspect if aspect else "", str(file.get("model") or "")[:80], source,
             str(file.get("name") or "")[:200], file["url"], str(file.get("key") or ""), str(file.get("type") or "image/png"),
             int(file.get("size") or 0), list(refs or []), parent_id))
        return _image_view(dict(row)) if row else None
    except Exception as exc:  # noqa: BLE001
        log.warning("studio: не записал картинку в галерею: %s", exc)
        return None


# ── обучение на оценках ──────────────────────────────────────────────────────

def _snip(text: str, n: int = 160) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[:n].rsplit(" ", 1)[0] + "…"


def insights(user_id: str) -> dict:
    """Что известно о вкусе человека по его оценкам: удачные запросы, чего избегать, любимый формат и референсы."""
    if not ready():
        return {"liked": [], "avoid": [], "aspect": "", "favoriteRefs": [], "rated": 0}
    liked = db.conn.fetch_all(
        "SELECT prompt, aspect, refs, note FROM studio_images WHERE user_id = %s AND (rating > 0 OR favorite) AND prompt <> '' "
        "ORDER BY created_at DESC LIMIT 40", (user_id,)) or []
    avoid = db.conn.fetch_all(
        "SELECT prompt, reason, note FROM studio_images WHERE user_id = %s AND rating < 0 ORDER BY created_at DESC LIMIT 20", (user_id,)) or []
    rated = db.conn.fetch_one("SELECT count(*)::int AS n FROM studio_images WHERE user_id = %s AND (rating <> 0 OR favorite)", (user_id,)) or {}
    aspects = Counter(r["aspect"] for r in liked if r["aspect"])
    ref_ids = Counter(i for r in liked for i in (r["refs"] or []))
    fav_refs = []
    if ref_ids:
        names = {r["id"]: r["name"] for r in list_refs(user_id, [i for i, _ in ref_ids.most_common(5)])}
        fav_refs = [names[i] for i, _ in ref_ids.most_common(5) if i in names]
    return {
        "liked": [{"prompt": _snip(r["prompt"]), "aspect": r["aspect"], "note": _snip(r["note"], 100)} for r in liked[:8]],
        "avoid": [{"prompt": _snip(r["prompt"], 100), "reason": _snip(r["reason"] or r["note"], 160)} for r in avoid[:8] if (r["reason"] or r["note"])],
        "aspect": aspects.most_common(1)[0][0] if aspects else "",
        "favoriteRefs": fav_refs, "rated": int(rated.get("n") or 0),
    }


def style_text(user_id: str) -> str:
    """Те же выводы — коротким текстом: добавляется к запросу («учитывать мои предпочтения») и идёт агентам."""
    got = insights(user_id)
    lines = []
    if got["aspect"]:
        lines.append(f"Обычно нравится формат {got['aspect']}.")
    if got["liked"]:
        lines.append("Нравилось: " + "; ".join(f"«{x['prompt']}»" for x in got["liked"][:3]) + ".")
    if got["avoid"]:
        lines.append("Не нравилось: " + "; ".join(f"{x['reason']}" for x in got["avoid"][:4] if x["reason"]) + ".")
    return " ".join(lines)


def prompt_block(user_id: str) -> str:
    """Блок в начале каждого запуска агента: референсы и вкус человека в картинках (пусто — блока нет)."""
    try:
        if not ready():
            return ""
        refs = list_refs(user_id)[:8]
        got = insights(user_id)
        if not refs and not got["rated"]:
            return ""
        parts = ["## Картинки (студия человека; рисует image_generate)"]
        if refs:
            parts.append("Референсы человека (приложить: image_generate reference_ids): "
                         + "; ".join(f"{r['id']} — {r['name']} ({r['kindLabel'].lower()})" for r in refs) + ". Все — studio_refs.")
        if got["aspect"]:
            parts.append(f"Любимый формат: {got['aspect']}.")
        if got["liked"]:
            parts.append("Ему нравилось (по оценкам): " + " | ".join(x["prompt"] for x in got["liked"][:3]))
        if got["avoid"]:
            parts.append("Не нравилось, избегайте: " + " | ".join(x["reason"] for x in got["avoid"][:4]))
        parts.append("Оценки человека — studio_gallery; пишите запросы с учётом этого.")
        return "\n".join(parts)
    except Exception:  # noqa: BLE001 — подсказка не должна ронять запуск агента
        return ""


def _learn(user_id: str, image: dict, rating: int, reason: str) -> None:
    """Оценка → строка в профиле человека («Картинки»): агент увидит её в начале каждого запуска и без студии.
    Повторы memory.profile_note не дублирует; без причины 👎 в профиль не пишем — шум, а не знание."""
    try:
        from app.modules.core_agents import memory

        prompt = _snip(image["prompt"], 140)
        if rating > 0 and prompt:
            memory.profile_note(user_id, "Картинки", f"Понравилось: «{prompt}»" + (f" ({image['aspect']})" if image["aspect"] else ""), "студия")
        elif rating < 0 and reason.strip():
            memory.profile_note(user_id, "Картинки", f"Не нравится: {_snip(reason, 160)} (запрос: «{_snip(image['prompt'], 90)}»)", "студия")
    except Exception as exc:  # noqa: BLE001
        log.debug("studio: профиль не обновлён: %s", exc)


# ── рисование ────────────────────────────────────────────────────────────────

def make(user_id: str, prompt: str, *, aspect: str = "", ref_ids: Optional[list[str]] = None, parent_id: Optional[str] = None,
         use_style: bool = False, source: str = "studio", name: str = "", source_url: str = "") -> dict:
    """Нарисовать и записать. Референсы человека и родитель (правка готовой картинки) прикладываются к запросу."""
    from app.modules.core_agents import images

    prompt = str(prompt or "").strip()
    if not prompt:
        raise StudioError("Опишите, что нарисовать")
    refs = list_refs(user_id, list(dict.fromkeys(ref_ids or []))[:MAX_REFS_PER_RUN]) if ref_ids else []
    parent = None
    if not parent_id and source_url:
        # Агент прислал адрес картинки из галереи («правь эту») — это та же картинка с теми же метками человека.
        found = db.conn.fetch_one("SELECT id FROM studio_images WHERE user_id = %s AND url = %s ORDER BY created_at DESC LIMIT 1", (user_id, source_url))
        if found:
            parent_id = found["id"]
    if parent_id:
        parent = db.conn.fetch_one("SELECT * FROM studio_images WHERE id = %s AND user_id = %s", (parent_id, user_id))
        if not parent:
            raise StudioError("Исходная картинка не найдена")
        source_url = parent["url"]
    extra_text, extra_images = "", []
    marks = list((parent or {}).get("marks") or [])
    if marks:
        extra_text = marks_text(marks)
        try:
            mime, data = images._source(source_url)  # noqa: SLF001 — тот же загрузчик исходников, что у правки
            drawn = annotated_png(data, marks)
            if drawn:
                extra_images.append(("image/png", drawn))
                extra_text += " Последняя приложенная картинка — схема меток: маркеры нарисованы поверх исходного фото только для указания мест, в результат их не переноси."
        except images.ImageError:
            pass
    full = prompt
    if use_style:
        style = style_text(user_id)
        if style:
            full = f"{prompt}\n\nУчитывай вкус заказчика. {style}"
    try:
        file = images.generate(user_id, full, aspect=aspect, source_url=source_url, name=name or prompt, refs=refs,
                               extra_text=extra_text, extra_images=extra_images)
    except images.ImageError as exc:
        raise StudioError(str(exc)) from exc
    if refs:
        db.conn.execute_query("UPDATE studio_refs SET uses = uses + 1 WHERE user_id = %s AND id = ANY(%s)", (user_id, [r["id"] for r in refs]))
    saved = record_image(user_id, file, prompt=prompt, aspect=aspect, source=source, refs=[r["id"] for r in refs], parent_id=parent_id)
    return {"image": saved, "file": file, "note": file.get("note") or ""}


# ── маршруты ─────────────────────────────────────────────────────────────────

class GenerateBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    aspect: str = Field(default="", max_length=8)
    refs: list[str] = Field(default_factory=list, max_length=MAX_REFS_PER_RUN)
    parentId: Optional[str] = Field(default=None, max_length=64)
    useStyle: bool = False


class ImagePatch(BaseModel):
    rating: Optional[int] = Field(default=None, ge=-1, le=1)
    reason: Optional[str] = Field(default=None, max_length=400)
    favorite: Optional[bool] = None
    note: Optional[str] = Field(default=None, max_length=600)
    tags: Optional[list[str]] = Field(default=None, max_length=10)
    name: Optional[str] = Field(default=None, max_length=200)
    marks: Optional[list[dict]] = Field(default=None, max_length=MAX_MARKS)


class UploadBody(BaseModel):
    key: str = Field(max_length=200)
    name: str = Field(default="", max_length=200)


class RefBody(BaseModel):
    name: str = Field(default="", max_length=120)
    kind: str = Field(default="style", max_length=20)
    note: str = Field(default="", max_length=600)
    key: Optional[str] = Field(default=None, max_length=200)
    imageId: Optional[str] = Field(default=None, max_length=64)
    tags: list[str] = Field(default_factory=list, max_length=10)


class RefPatch(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    kind: Optional[str] = Field(default=None, max_length=20)
    note: Optional[str] = Field(default=None, max_length=600)
    tags: Optional[list[str]] = Field(default=None, max_length=10)


def _tags(items: list[str]) -> list[str]:
    return [t.strip().lower()[:30] for t in items if str(t).strip()][:10]


@router.get("/api/studio")
def get_studio(me: Identity = Depends(current_identity)):
    _guard(me)
    from app.modules.core_agents import images, store

    has_key = False
    try:
        has_key = bool(store.unseal((store.account(me.user_id, "gemini") or {}).get("secret_enc") or ""))
    except Exception:  # noqa: BLE001
        pass
    return {"images": list_images(me.user_id), "refs": list_refs(me.user_id), "insights": insights(me.user_id),
            "hasKey": has_key, "kinds": KINDS, "aspects": sorted(images.ASPECTS), "model": images.latest_model(me.user_id) if has_key else ""}


@router.post("/api/studio/generate")
async def generate(body: GenerateBody, me: Identity = Depends(current_identity)):
    _guard(me)
    if not limiter.allow(f"studio:{me.user_id}", 20, 60):
        raise HTTPException(status_code=429, detail="Слишком часто — подождите минуту")
    try:
        got = await run_in_threadpool(make, me.user_id, body.prompt, aspect=body.aspect, ref_ids=body.refs, parent_id=body.parentId,
                                      use_style=body.useStyle)
    except StudioError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    return {"image": got["image"], "note": got["note"]}


def _own_image(image_id: str, me: Identity) -> dict:
    row = db.conn.fetch_one("SELECT * FROM studio_images WHERE id = %s AND user_id = %s", (image_id, me.user_id))
    if not row:
        raise HTTPException(status_code=404, detail="Картинка не найдена")
    return dict(row)


@router.patch("/api/studio/images/{image_id}")
def patch_image(image_id: str, body: ImagePatch, me: Identity = Depends(current_identity)):
    _guard(me)
    row = _own_image(image_id, me)
    sets, params = [], []
    if body.rating is not None:
        sets.append("rating = %s")
        params.append(body.rating)
        if body.rating >= 0 and body.reason is None:
            sets.append("reason = ''")
    if body.reason is not None:
        sets.append("reason = %s")
        params.append(body.reason.strip())
    for field, value in (("favorite", body.favorite), ("note", body.note.strip() if body.note is not None else None),
                         ("name", body.name.strip() if body.name is not None else None)):
        if value is not None:
            sets.append(f"{field} = %s")
            params.append(value)
    if body.tags is not None:
        sets.append("tags = %s")
        params.append(_tags(body.tags))
    if body.marks is not None:
        from app.core.db.connection import Json

        sets.append("marks = %s")
        params.append(Json(clean_marks(body.marks)))
    if not sets:
        return {"image": _image_view(row)}
    updated = db.conn.fetch_one(f"UPDATE studio_images SET {', '.join(sets)} WHERE id = %s RETURNING *", (*params, image_id))
    if body.rating is not None and (body.rating != int(row["rating"] or 0) or (body.reason or "").strip() != (row["reason"] or "")):
        _learn(me.user_id, _image_view(dict(updated)), body.rating, (body.reason or "").strip())
    elif body.favorite and not row["favorite"]:
        _learn(me.user_id, _image_view(dict(updated)), 1, "")
    return {"image": _image_view(dict(updated)), "insights": insights(me.user_id)}


@router.post("/api/studio/uploads", status_code=201)
def upload_photo(body: UploadBody, me: Identity = Depends(current_identity)):
    """Своё фото для правки: загруженный файл (/api/upload) становится картинкой галереи — её можно разметить и править.
    Так редактируют готовое фото, а не рисуют «со слов»."""
    _guard(me)
    upload = _upload_name(body.key)
    ext = upload.rsplit(".", 1)[-1].lower() if "." in upload else ""
    if ext not in ("png", "jpg", "jpeg", "webp", "gif"):
        raise HTTPException(status_code=400, detail="Нужна картинка: PNG, JPEG, WebP или GIF")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}.get(ext, "image/png")
    saved = record_image(me.user_id, {"name": body.name or upload, "url": f"/api/uploads/{upload}", "key": f"uploads/{upload}", "type": mime, "model": ""},
                         prompt="", source="upload")
    if not saved:
        raise HTTPException(status_code=500, detail="Не удалось добавить фото")
    return {"image": saved}


@router.delete("/api/studio/images/{image_id}")
def delete_image(image_id: str, me: Identity = Depends(current_identity)):
    _guard(me)
    _own_image(image_id, me)
    db.conn.execute_query("DELETE FROM studio_images WHERE id = %s AND user_id = %s", (image_id, me.user_id))
    return {"ok": True}


def _upload_name(key: str) -> str:
    from pathlib import Path

    from app.core.storage import is_upload_name

    name = Path(key or "").name
    if not is_upload_name(name):
        raise HTTPException(status_code=400, detail="Файл не из загрузок Шара")
    return name


@router.post("/api/studio/refs", status_code=201)
def add_ref(body: RefBody, me: Identity = Depends(current_identity)):
    _guard(me)
    kind = body.kind if body.kind in KINDS else "other"
    if body.imageId:
        image = _own_image(body.imageId, me)
        url, key, mime, size = image["url"], image["upload_key"], image["mime"], image["size"]
        name = body.name.strip() or _snip(image["prompt"], 60) or "Референс"
    elif body.key:
        upload = _upload_name(body.key)
        url, key, mime, size = f"/api/uploads/{upload}", f"uploads/{upload}", "image/png", 0
        name = body.name.strip() or "Референс"
    else:
        raise HTTPException(status_code=400, detail="Нужна картинка: загрузите файл или возьмите из галереи")
    if db.conn.fetch_one("SELECT count(*)::int AS n FROM studio_refs WHERE user_id = %s", (me.user_id,))["n"] >= 200:
        raise HTTPException(status_code=409, detail="Референсов слишком много — удалите ненужные")
    row = db.conn.fetch_one(
        "INSERT INTO studio_refs (id, user_id, name, kind, note, url, upload_key, mime, size, tags) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
        (uuid.uuid4().hex, me.user_id, name[:120], kind, body.note.strip(), url, key, mime, int(size or 0), _tags(body.tags)))
    return {"ref": _ref_view(dict(row))}


@router.patch("/api/studio/refs/{ref_id}")
def patch_ref(ref_id: str, body: RefPatch, me: Identity = Depends(current_identity)):
    _guard(me)
    sets, params = [], []
    for field, value in (("name", body.name.strip() if body.name is not None else None), ("note", body.note.strip() if body.note is not None else None),
                         ("kind", (body.kind if body.kind in KINDS else "other") if body.kind is not None else None)):
        if value is not None:
            sets.append(f"{field} = %s")
            params.append(value)
    if body.tags is not None:
        sets.append("tags = %s")
        params.append(_tags(body.tags))
    if not sets:
        raise HTTPException(status_code=400, detail="Нечего менять")
    row = db.conn.fetch_one(f"UPDATE studio_refs SET {', '.join(sets)} WHERE id = %s AND user_id = %s RETURNING *", (*params, ref_id, me.user_id))
    if not row:
        raise HTTPException(status_code=404, detail="Референс не найден")
    return {"ref": _ref_view(dict(row))}


@router.delete("/api/studio/refs/{ref_id}")
def delete_ref(ref_id: str, me: Identity = Depends(current_identity)):
    _guard(me)
    if not db.conn.fetch_one("DELETE FROM studio_refs WHERE id = %s AND user_id = %s RETURNING id", (ref_id, me.user_id)):
        raise HTTPException(status_code=404, detail="Референс не найден")
    return {"ok": True}
