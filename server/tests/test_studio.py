"""Студия картинок: доступ вместе с «Ядром», галерея, референсы, оценки → выводы о вкусе → агенту и в профиль."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from app.core.db import db
from app.modules.core_agents import images, memory
from app.modules.studio import router as S


def _png() -> bytes:
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 120, 200)).save(out, "PNG")
    return out.getvalue()


@pytest.fixture()
def fake_gemini(monkeypatch):
    """Gemini не трогаем: «рисование» кладёт настоящий файл в загрузки и запоминает, с чем его позвали."""
    calls = []

    def fake(user_id, prompt, *, aspect="", source_url="", name="", refs=None, **_):
        calls.append({"prompt": prompt, "aspect": aspect, "source_url": source_url, "refs": [r["id"] for r in refs or []]})
        from app.modules.files.uploads import save_upload_bytes

        saved = save_upload_bytes(f"{uuid.uuid4().hex[:6]}.png", _png(), "image/png", user_id)
        return {"name": saved["filename"], "url": saved["url"], "size": saved["size"], "type": "image/png", "key": saved["key"], "model": "gemini-test", "note": ""}

    monkeypatch.setattr(images, "generate", fake)
    return calls


@pytest.fixture()
def core_user(users):
    """Анна с включённым «Ядром»: студия открывается вместе с ним."""
    db.update_user(users.ids["anna"], {"enabledTools": ["core"]})
    yield users._clients["anna"]
    db.update_user(users.ids["anna"], {"enabledTools": []})


def test_studio_comes_with_core_access(clara, core_user):
    assert clara.get("/api/studio").status_code == 403
    r = core_user.get("/api/studio")
    assert r.status_code == 200, r.text
    assert set(r.json()) >= {"images", "refs", "insights", "hasKey", "kinds", "aspects"}


def test_generate_with_references_and_rating_teaches_agents(users, core_user, fake_gemini):
    anna = users.ids["anna"]
    # референс: загруженный файл
    from app.modules.files.uploads import save_upload_bytes

    up = save_upload_bytes("бренд.png", _png(), "image/png", anna)
    ref = core_user.post("/api/studio/refs", json={"name": "Фирменный стиль", "kind": "style", "note": "оранжевый и бежевый", "key": up["key"]})
    assert ref.status_code == 201, ref.text
    ref_id = ref.json()["ref"]["id"]
    assert core_user.post("/api/studio/refs", json={"name": "Чужое", "key": "../../etc/passwd"}).status_code == 400

    made = core_user.post("/api/studio/generate", json={"prompt": "Афиша тура на Байкал", "aspect": "4:5", "refs": [ref_id], "useStyle": True})
    assert made.status_code == 200, made.text
    image = made.json()["image"]
    assert image["refs"] == [ref_id] and image["aspect"] == "4:5" and image["source"] == "studio"
    assert fake_gemini[-1]["refs"] == [ref_id]
    assert core_user.get("/api/studio").json()["refs"][0]["uses"] == 1

    # 👎 с причиной → вывод «избегать» и строка в профиле; 👍 → «нравилось»
    bad = core_user.patch(f"/api/studio/images/{image['id']}", json={"rating": -1, "reason": "слишком мрачные цвета"})
    assert bad.status_code == 200
    assert bad.json()["insights"]["avoid"][0]["reason"] == "слишком мрачные цвета"
    assert "слишком мрачные цвета" in memory.profile(anna)

    second = core_user.post("/api/studio/generate", json={"prompt": "Афиша тура на Байкал, светлая", "aspect": "4:5"}).json()["image"]
    core_user.patch(f"/api/studio/images/{second['id']}", json={"rating": 1})
    got = S.insights(anna)
    assert got["aspect"] == "4:5" and got["liked"][0]["prompt"].startswith("Афиша тура на Байкал, светлая")
    assert "Понравилось" in memory.profile(anna)

    # агент получает вкус в начале каждого запуска и в запросе, если просят «учитывать предпочтения»
    block = memory.prompt_context(anna)
    assert "Картинки" in block and "слишком мрачные цвета" in block and ref_id in block
    core_user.post("/api/studio/generate", json={"prompt": "Баннер", "useStyle": True})
    assert "слишком мрачные цвета" in fake_gemini[-1]["prompt"] or "Учитывай вкус" in fake_gemini[-1]["prompt"]


def test_agent_tools_see_refs_and_gallery(users, core_user, fake_gemini):
    from app.modules.mcp import apps

    anna = users.ids["anna"]
    access = SimpleNamespace(me=SimpleNamespace(user_id=anna, display_name="Анна"), ctx=SimpleNamespace(scope={}))
    from app.modules.files.uploads import save_upload_bytes

    up = save_upload_bytes("герой.png", _png(), "image/png", anna)
    ref = core_user.post("/api/studio/refs", json={"name": "Герой Байкал", "kind": "character", "key": up["key"]}).json()["ref"]
    assert any(r["id"] == ref["id"] for r in apps.studio_refs(access, {"query": "байкал"})["refs"])

    done = apps.image_generate(access, {"prompt": "Герой на льду", "reference_ids": [ref["id"]]})
    assert done["image"]["model"] == "gemini-test" and fake_gemini[-1]["refs"] == [ref["id"]]
    # то, что агент нарисовал в чате, — в галерее студии, источник «chat»
    gallery = apps.studio_gallery(access, {"query": "льду"})
    assert gallery["images"] and core_user.get("/api/studio").json()["images"][0]["source"] == "chat"


def test_rating_is_private(users, core_user, fake_gemini, admin):
    mine = core_user.post("/api/studio/generate", json={"prompt": "Моя картинка"}).json()["image"]
    assert admin.patch(f"/api/studio/images/{mine['id']}", json={"rating": 1}).status_code == 404
    assert admin.delete(f"/api/studio/images/{mine['id']}").status_code == 404
    assert core_user.delete(f"/api/studio/images/{mine['id']}").status_code == 200


def test_marks_clean_text_and_scheme():
    """Метки: границы 0…1, номера по порядку, область не выходит за край; словами — проценты; схема — настоящая PNG с маркерами."""
    marks = S.clean_marks([
        {"x": 0.3, "y": 0.2, "note": "  лишний   предмет "},
        {"x": 0.7, "y": 0.6, "w": 0.5, "h": 0.2, "note": "фон светлее"},
        {"x": 1.4, "y": 0.1, "note": "за краем"}, {"x": "a", "y": 0}, "мусор",
    ])
    assert [m["n"] for m in marks] == [1, 2] and marks[0]["note"] == "лишний предмет"
    assert "w" not in marks[0] and marks[1]["w"] == 0.3, "область обрезана по краю фото"
    text = S.marks_text(marks)
    assert "1) точка (30%, 20%): лишний предмет" in text and "2) область от (70%, 60%) размером 30%×20%: фон светлее" in text
    from PIL import Image
    import io

    png = S.annotated_png(_png(), marks)
    assert png and Image.open(io.BytesIO(png)).format == "PNG"
    assert len(S.clean_marks([{"x": 0.1, "y": 0.1}] * 40)) == S.MAX_MARKS


def test_edit_own_photo_with_marks_bridge(users, core_user, fake_gemini, monkeypatch):
    """Мост человек ↔ агент: своё фото → в галерею → метки → правка получает их текстом и схемой; агент читает метки и ставит свои."""
    from types import SimpleNamespace

    from app.modules.files.uploads import save_upload_bytes
    from app.modules.mcp import apps

    anna = users.ids["anna"]
    seen = {}

    def fake(user_id, prompt, *, aspect="", source_url="", name="", refs=None, extra_text="", extra_images=None):
        seen.update(prompt=prompt, source_url=source_url, extra_text=extra_text, extra=len(extra_images or []))
        saved = save_upload_bytes("result.png", _png(), "image/png", user_id)
        return {"name": saved["filename"], "url": saved["url"], "size": saved["size"], "type": "image/png", "key": saved["key"], "model": "gemini-test", "note": ""}

    monkeypatch.setattr(images, "generate", fake)
    monkeypatch.setattr(images, "_source", lambda url: ("image/png", _png()))

    up = save_upload_bytes("photo.png", _png(), "image/png", anna)
    assert core_user.post("/api/studio/uploads", json={"key": "../../x.png"}).status_code == 400
    assert core_user.post("/api/studio/uploads", json={"key": up["key"].replace(".png", ".exe")}).status_code in (400, 404)
    photo = core_user.post("/api/studio/uploads", json={"key": up["key"], "name": "фото банера"}).json()["image"]
    assert photo["source"] == "upload" and photo["marks"] == []

    marked = core_user.patch(f"/api/studio/images/{photo['id']}", json={"marks": [{"x": 0.25, "y": 0.4, "note": "убрать надпись"}, {"x": 0.6, "y": 0.1, "w": 0.2, "h": 0.2, "note": "небо ярче"}]})
    assert marked.status_code == 200 and [m["n"] for m in marked.json()["image"]["marks"]] == [1, 2]

    done = core_user.post("/api/studio/generate", json={"prompt": "Сделай как на баннер", "parentId": photo["id"]})
    assert done.status_code == 200, done.text
    assert seen["source_url"] == photo["url"] and "точка (25%, 40%): убрать надпись" in seen["extra_text"] and seen["extra"] == 1
    assert done.json()["image"]["parentId"] == photo["id"]

    # Агент: правит по адресу картинки из галереи — метки подхватываются сами; читает метки; ставит свои.
    access = SimpleNamespace(me=SimpleNamespace(user_id=anna, display_name="Анна"), ctx=SimpleNamespace(scope={}))
    seen.clear()
    out = apps.image_generate(access, {"prompt": "поправь по меткам", "source_url": photo["url"]})
    assert "убрать надпись" in seen["extra_text"] and out["image"]["studioUrl"].startswith("/studio?image=")
    gallery = apps.studio_gallery(access, {"query": "банер"})
    row = next(i for i in gallery["images"] if i["id"] == photo["id"])
    assert row["marks"] and "небо ярче" in row["marksText"] and row["studioUrl"] == f"/studio?image={photo['id']}"
    placed = apps.studio_mark(access, {"image_id": photo["id"], "marks": [{"x": 0.5, "y": 0.5, "note": "здесь поправлю"}]})
    assert placed["marks"][0]["n"] == 1 and "здесь поправлю" in placed["marksText"]
    assert core_user.get("/api/studio").json()["images"][0]["marks"] is not None
