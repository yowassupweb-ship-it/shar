"""Студия картинок: рисование, галерея, референсы и то, чему агент учится на оценках.

Раздел открыт тем, у кого включено «Ядро» (как и сам чат с агентами): отдельной выдачи прав нет — «идёт из коробки».
Рисует агент «Ядра» по подписке человека — тот, кого он выбрал (GPT встроенным image_gen, Claude и Kimi — своим средством,
обычно SVG). Запуск идёт в чат «Ядра» «Студия» (там видно, как агент работает), готовая картинка возвращается сюда
(finished). Всё, что агент нарисовал и в обычном чате, тоже попадает в галерею — и наоборот: агент видит референсы
человека и его оценки. Своего генератора у Шара нет (прежний Gemini по ключу удалён 18.11.2026).

  галерея     каждая нарисованная картинка: запрос, формат, референсы, из чего сделана (родитель), оценка (👍 / 👎 с
              причиной), избранное, заметка, метки;
  референсы   загруженные примеры — стиль, персонаж, предмет, логотип, фон: к запросу прикладываются сами;
  обучение    оценки превращаются в «что нравится / чего избегать» (insights): их видит человек в студии, они идут
              агентам в начало каждого запуска (prompt_block) и в профиль человека (memory.profile_note) — агент,
              который рисует в чате, учитывает вкус, а не начинает с нуля.

  GET    /api/studio                      галерея, референсы, выводы, агенты, которые могут рисовать, идущие запуски
  POST   /api/studio/generate             {prompt, agent, aspect, refs[], parentId?, useStyle?} → {runId}; картинка — событием studio_ready
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
from app.core.db.connection import Json
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
    """Картинка — в галерею: из студии, из чата с агентом или от встроенного генератора GPT.
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
        parts = ["## Картинки (студия человека)"]
        if refs:
            parts.append("Референсы человека (смотреть по адресу из studio_refs): "
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

STUDIO_THREAD = "Студия: картинки"
RUN_TTL_MIN = 60


def _studio_thread(user_id: str, provider: str) -> dict:
    """Чат «Ядра», куда уходят запуски студии: один на человека, чтобы ход работы агентов был в одном месте."""
    row = db.conn.fetch_one("SELECT * FROM core_threads WHERE user_id = %s AND title = %s ORDER BY created_at DESC LIMIT 1", (user_id, STUDIO_THREAD))
    if row:
        return dict(row)
    return dict(db.conn.fetch_one("INSERT INTO core_threads (id, user_id, title, peer) VALUES (%s, %s, %s, %s) RETURNING *",
                                  (uuid.uuid4().hex[:24], user_id, STUDIO_THREAD, provider)))


def image_agents(user_id: str) -> list[dict]:
    """Кто из подключённых агентов человека может нарисовать: GPT — встроенным генератором, остальные — своим средством."""
    from app.modules.core_agents import store

    out = []
    for a in store.ready_agents(user_id):
        if a["provider"] == "gemini":
            continue  # Gemini по ключу картинок больше не рисует (запасной путь удалён)
        native = a["provider"] == "codex"
        out.append({"id": a["provider"], "label": a["label"], "model": a["model"], "nodeOnline": a["nodeOnline"],
                    "how": "встроенный генератор картинок" if native else "своим средством: обычно SVG или код"})
    return sorted(out, key=lambda x: x["id"] != "codex")


def make(user_id: str, prompt: str, *, agent: str = "", aspect: str = "", ref_ids: Optional[list[str]] = None, parent_id: Optional[str] = None,
         use_style: bool = False) -> dict:
    """Поручить картинку агенту «Ядра». Ответ сразу — {runId}; картинка придёт, когда агент закончит (finished → studio_ready)."""
    from app.modules.core_agents import dispatch, images
    from app.modules.core_chat.router import _announce, _touch, present_message
    from app.modules.files.uploads import save_upload_bytes

    prompt = str(prompt or "").strip()
    if not prompt:
        raise StudioError("Опишите, что нарисовать")
    choices = image_agents(user_id)
    chosen = next((a for a in choices if a["id"] == (agent or "").split(":")[0]), None) or (choices[0] if choices else None)
    if chosen is None:
        raise StudioError("Рисует агент «Ядра» по вашей подписке: подключите GPT, Claude или Kimi в настройках «Ядра»")
    refs = list_refs(user_id, list(dict.fromkeys(ref_ids or []))[:MAX_REFS_PER_RUN]) if ref_ids else []
    parent = None
    if parent_id:
        parent = db.conn.fetch_one("SELECT * FROM studio_images WHERE id = %s AND user_id = %s", (parent_id, user_id))
        if not parent:
            raise StudioError("Исходная картинка не найдена")

    attachments: list[dict] = []
    lines = [f"Нарисуйте картинку для «Студии» Шара по запросу человека: {prompt}"]
    if aspect:
        lines.append(f"Соотношение сторон: {aspect}.")
    if parent:
        attachments.append({"name": f"исходник-{parent['id'][:6]}", "url": parent["url"], "type": parent.get("mime") or "image/png"})
        lines.append("Это правка готовой картинки: исходник приложен — меняйте только то, о чём просят, остальное сохраните.")
        marks = list(parent.get("marks") or [])
        if marks:
            lines.append(marks_text(marks))
            try:
                mime, data = images._source(parent["url"])  # noqa: SLF001 — тот же загрузчик исходников
                drawn = annotated_png(data, marks)
                if drawn:
                    saved = save_upload_bytes("метки.png", drawn, "image/png", user_id)
                    attachments.append({"name": "метки", "url": saved["url"], "type": "image/png"})
                    lines.append("Приложенная схема «метки» — копия исходника с пронумерованными маркерами: только чтобы показать места, в результат маркеры не переносите.")
            except images.ImageError:
                pass
    if refs:
        attachments += [{"name": r["name"] or "референс", "url": r["url"], "type": "image/png"} for r in refs]
        lines.append("Референсы человека приложены — учитывайте: " + "; ".join(f"«{r['name']}» — {r['kindLabel'].lower()}{(': ' + r['note']) if r.get('note') else ''}" for r in refs) + ".")
    if use_style:
        style = style_text(user_id)
        if style:
            lines.append(f"Учитывайте вкус человека. {style}")
    lines.append("Сделайте ровно одну картинку своим средством и отдайте её человеку как файл (у GPT — встроенный генератор картинок; "
                 "у остальных — аккуратный SVG в папку готовых картинок). Вопросов не задавайте, ответьте одной строкой, что нарисовали.")

    thread = _studio_thread(user_id, chosen["id"])
    user = db.get_user_by_id(user_id) or {}
    run_id = f"studio-{uuid.uuid4().hex[:20]}"
    props = {"studioRun": {"prompt": prompt, "aspect": aspect, "refs": [r["id"] for r in refs], "parentId": parent_id or None, "agent": chosen["id"]},
             "agentNote": "\n\n".join(lines), "attachments": attachments}
    created = db.conn.fetch_one(
        """INSERT INTO core_messages (id, thread_id, user_id, role, actor, body, props, status)
           VALUES (%s, %s, %s, 'user', %s, %s, %s, 'done') RETURNING *""",
        (run_id, thread["id"], user_id, user.get("name") or user.get("username") or "Студия", f"🎨 {prompt}"[:4000], Json(props)))
    _touch(thread["id"])
    message = present_message(created)
    _announce(user_id, message, thread["id"])
    reply = dispatch.dispatch(user_id, thread, message, wanted=chosen["id"])
    if reply is None:
        raise StudioError("Не получилось запустить агента: проверьте подключение в настройках «Ядра»")
    if reply.get("status") == "failed":
        _mark_done(run_id, error=str(reply.get("body") or "Агент не запустился"))
        raise StudioError(str(reply.get("body") or "Агент не запустился"))
    return {"runId": run_id, "agent": chosen["label"], "threadId": thread["id"]}


def _mark_done(run_id: str, *, error: str = "", image_id: str = "") -> None:
    db.conn.execute_query(
        "UPDATE core_messages SET props = jsonb_set(props, '{studioRun,doneAt}', to_jsonb(now()::text)) "
        "|| jsonb_build_object('studioResult', jsonb_build_object('error', %s::text, 'imageId', %s::text)) WHERE id = %s",
        (error[:500], image_id, run_id))


def pending_runs(user_id: str) -> list[dict]:
    """Запуски студии, которые ещё рисуются (за последний час) — чтобы после перезагрузки страницы не терялся «рисует…»."""
    rows = db.conn.fetch_all(
        "SELECT id, props, created_at FROM core_messages WHERE user_id = %s AND role = 'user' AND props ? 'studioRun' "
        "AND NOT (props->'studioRun' ? 'doneAt') AND created_at > now() - make_interval(mins => %s) ORDER BY created_at DESC LIMIT 10",
        (user_id, RUN_TTL_MIN)) or []
    return [{"runId": r["id"], "prompt": (r["props"].get("studioRun") or {}).get("prompt") or "", "agent": (r["props"].get("studioRun") or {}).get("agent") or "",
             "startedAt": r["created_at"].isoformat() if r.get("created_at") else None} for r in rows]


def finished(job: dict, kind: str, body: str) -> None:
    """Ответ агента закончился (core_agents/node.py). Если это запуск студии — картинку в галерею, человеку событие studio_ready."""
    from app.core.realtime import sse_manager

    payload = job.get("payload") or {}
    run_id = str(payload.get("userMessageId") or "")
    if not run_id.startswith("studio-") or not ready():
        return
    user_msg = db.conn.fetch_one("SELECT props FROM core_messages WHERE id = %s", (run_id,))
    run = ((user_msg or {}).get("props") or {}).get("studioRun")
    if not run or run.get("doneAt"):
        return
    user_id = job["user_id"]
    agent_msg = db.conn.fetch_one("SELECT props FROM core_messages WHERE id = %s", (job.get("message_id"),))
    files = [f for f in ((agent_msg or {}).get("props") or {}).get("attachments") or [] if str(f.get("type") or "").startswith("image/") and f.get("url")]
    saved = None
    for f in files[-1:]:  # просили одну — берём последнюю (агенты иногда сначала отдают черновик)
        existing = db.conn.fetch_one("SELECT id FROM studio_images WHERE user_id = %s AND url = %s", (user_id, f["url"]))
        if existing:  # растровую картинку агента галерея уже записала как «из чата» — переписываем в запуск студии
            row = db.conn.fetch_one(
                "UPDATE studio_images SET source = 'studio', prompt = %s, aspect = %s, refs = %s, parent_id = %s, model = %s WHERE id = %s RETURNING *",
                (run.get("prompt") or "", run.get("aspect") or "", list(run.get("refs") or []), run.get("parentId"), run.get("agent") or "", existing["id"]))
            saved = _image_view(dict(row)) if row else None
        else:
            saved = record_image(user_id, {**f, "model": run.get("agent") or ""}, prompt=run.get("prompt") or "", aspect=run.get("aspect") or "",
                                 refs=list(run.get("refs") or []), parent_id=run.get("parentId"))
    if saved and run.get("refs"):
        db.conn.execute_query("UPDATE studio_refs SET uses = uses + 1 WHERE user_id = %s AND id = ANY(%s)", (user_id, list(run["refs"])))
    error = "" if saved else (body.strip()[:400] if kind == "failed" and body else "Агент закончил, но картинку не отдал. Откройте чат «Студия: картинки» в «Ядре» — там видно почему.")
    _mark_done(run_id, error=error, image_id=(saved or {}).get("id") or "")
    sse_manager.push(user_id, {"type": "studio_ready", "runId": run_id, "image": saved, "error": error, "note": body.strip()[:300] if saved else ""})


# ── маршруты ─────────────────────────────────────────────────────────────────

class GenerateBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    agent: str = Field(default="", max_length=40)
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
    from app.modules.core_agents import images

    agents = image_agents(me.user_id)
    return {"images": list_images(me.user_id), "refs": list_refs(me.user_id), "insights": insights(me.user_id),
            "agents": agents, "pending": pending_runs(me.user_id), "hasKey": bool(agents),
            "kinds": KINDS, "aspects": sorted(images.ASPECTS), "model": ""}


@router.post("/api/studio/generate")
async def generate(body: GenerateBody, me: Identity = Depends(current_identity)):
    _guard(me)
    if not limiter.allow(f"studio:{me.user_id}", 20, 60):
        raise HTTPException(status_code=429, detail="Слишком часто — подождите минуту")
    try:
        return await run_in_threadpool(make, me.user_id, body.prompt, agent=body.agent, aspect=body.aspect, ref_ids=body.refs,
                                       parent_id=body.parentId, use_style=body.useStyle)
    except StudioError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None


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
