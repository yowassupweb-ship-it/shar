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
def fake_agent(monkeypatch, users):
    """Рисует «агент»: запуск студии уходит в dispatch (подменён) — он заводит ответ агента и запоминает, с чем позвали.
    draw(run) — агент закончил: прикрепляет PNG к ответу (как встроенный image_gen GPT) и сообщает о конце (studio.finished)."""
    from app.modules.core_agents import dispatch
    from app.modules.core_chat.router import post_agent_message

    calls = []
    db.conn.execute_query("INSERT INTO core_accounts (user_id, provider, state) VALUES (%s, 'codex', 'ready') ON CONFLICT DO NOTHING", (users.ids["anna"],))

    def fake(user_id, thread, message, *, wanted="", effort="", plan=False):
        reply = post_agent_message(user_id, thread["id"], "GPT", status="working", props={"provider": wanted})
        row = db.conn.fetch_one("SELECT props FROM core_messages WHERE id = %s", (message["id"],))
        calls.append({"runId": message["id"], "replyId": reply["id"], "wanted": wanted, "note": row["props"].get("agentNote") or "",
                      "attachments": row["props"].get("attachments") or []})
        return reply

    def draw(run_id, *, failed=False):
        call = next(c for c in calls if c["runId"] == run_id)
        if not failed:
            images.attach_bytes(call["replyId"], users.ids["anna"], _png(), name="картинка")
        S.finished({"user_id": users.ids["anna"], "message_id": call["replyId"], "payload": {"userMessageId": run_id}},
                   "failed" if failed else "done", "сбой" if failed else "Нарисовал")
        return db.conn.fetch_one("SELECT props FROM core_messages WHERE id = %s", (run_id,))["props"].get("studioResult") or {}

    monkeypatch.setattr(dispatch, "dispatch", fake)
    yield SimpleNamespace(calls=calls, draw=draw)
    db.conn.execute_query("DELETE FROM core_accounts WHERE user_id = %s AND provider = 'codex'", (users.ids["anna"],))


def _image(core_user, image_id):
    return next(i for i in core_user.get("/api/studio").json()["images"] if i["id"] == image_id)


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
    assert set(r.json()) >= {"images", "refs", "insights", "hasKey", "agents", "pending", "kinds", "aspects"}


def test_generate_with_references_and_rating_teaches_agents(users, core_user, fake_agent):
    anna = users.ids["anna"]
    from app.modules.files.uploads import save_upload_bytes

    up = save_upload_bytes("бренд.png", _png(), "image/png", anna)
    ref = core_user.post("/api/studio/refs", json={"name": "Фирменный стиль", "kind": "style", "note": "оранжевый и бежевый", "key": up["key"]})
    assert ref.status_code == 201, ref.text
    ref_id = ref.json()["ref"]["id"]
    assert core_user.post("/api/studio/refs", json={"name": "Чужое", "key": "../../etc/passwd"}).status_code == 400

    # кто рисует — подключённые агенты; GPT первым (встроенный генератор)
    state = core_user.get("/api/studio").json()
    assert state["hasKey"] and state["agents"][0]["id"] == "codex"

    made = core_user.post("/api/studio/generate", json={"prompt": "Афиша тура на Байкал", "agent": "codex", "aspect": "4:5", "refs": [ref_id], "useStyle": True})
    assert made.status_code == 200, made.text
    run_id = made.json()["runId"]
    call = fake_agent.calls[-1]
    assert call["wanted"] == "codex" and "Афиша тура на Байкал" in call["note"] and "4:5" in call["note"]
    assert any(a["url"] == ref.json()["ref"]["url"] for a in call["attachments"]), "референс приложен агенту"
    assert [p["runId"] for p in core_user.get("/api/studio").json()["pending"]] == [run_id]

    result = fake_agent.draw(run_id)
    image = _image(core_user, result["imageId"])
    assert image["refs"] == [ref_id] and image["aspect"] == "4:5" and image["source"] == "studio" and image["model"] == "codex"
    assert run_id not in [p["runId"] for p in core_user.get("/api/studio").json()["pending"]]
    assert core_user.get("/api/studio").json()["refs"][0]["uses"] == 1
    # одна картинка — одна строка галереи (растровую «из чата» переписали в запуск студии, а не задвоили)
    assert sum(1 for i in core_user.get("/api/studio").json()["images"] if i["url"] == image["url"]) == 1

    bad = core_user.patch(f"/api/studio/images/{image['id']}", json={"rating": -1, "reason": "слишком мрачные цвета"})
    assert bad.status_code == 200
    assert bad.json()["insights"]["avoid"][0]["reason"] == "слишком мрачные цвета"
    assert "слишком мрачные цвета" in memory.profile(anna)

    second_run = core_user.post("/api/studio/generate", json={"prompt": "Афиша тура на Байкал, светлая", "agent": "codex", "aspect": "4:5"}).json()["runId"]
    second = fake_agent.draw(second_run)["imageId"]
    core_user.patch(f"/api/studio/images/{second}", json={"rating": 1})
    got = S.insights(anna)
    assert got["aspect"] == "4:5" and got["liked"][0]["prompt"].startswith("Афиша тура на Байкал, светлая")
    assert "Понравилось" in memory.profile(anna)

    block = memory.prompt_context(anna)
    assert "Картинки" in block and "слишком мрачные цвета" in block and ref_id in block
    core_user.post("/api/studio/generate", json={"prompt": "Баннер", "agent": "codex", "useStyle": True})
    assert "слишком мрачные цвета" in fake_agent.calls[-1]["note"]


def test_agent_failure_reaches_the_studio(users, core_user, fake_agent):
    run_id = core_user.post("/api/studio/generate", json={"prompt": "Что-то", "agent": "codex"}).json()["runId"]
    result = fake_agent.draw(run_id, failed=True)
    assert result["error"] and not result["imageId"] and run_id not in [p["runId"] for p in core_user.get("/api/studio").json()["pending"]]


def test_no_agent_no_drawing(users, core_user):
    r = core_user.post("/api/studio/generate", json={"prompt": "Без агента"})
    assert r.status_code == 502 and "Ядра" in r.json()["detail"]


def test_agent_tools_see_refs_and_gallery(users, core_user):
    import base64

    from app.modules.mcp import apps

    anna = users.ids["anna"]
    access = SimpleNamespace(me=SimpleNamespace(user_id=anna, display_name="Анна"), ctx=SimpleNamespace(scope={}))
    from app.modules.files.uploads import save_upload_bytes

    up = save_upload_bytes("герой.png", _png(), "image/png", anna)
    ref = core_user.post("/api/studio/refs", json={"name": "Герой Байкал", "kind": "character", "key": up["key"]}).json()["ref"]
    assert any(r["id"] == ref["id"] for r in apps.studio_refs(access, {"query": "байкал"})["refs"])
    assert not hasattr(apps, "image_generate"), "запасной путь через Gemini удалён"
    # картинка агента из чата (image_attach) — в галерее студии, источник «chat»
    apps.image_attach(access, {"base64": base64.b64encode(_png()).decode(), "name": "Герой на льду"})
    gallery = apps.studio_gallery(access, {"query": "льду"})
    assert gallery["images"] and core_user.get("/api/studio").json()["images"][0]["source"] == "chat"


def test_rating_is_private(users, core_user, fake_agent, admin):
    run_id = core_user.post("/api/studio/generate", json={"prompt": "Моя картинка", "agent": "codex"}).json()["runId"]
    mine = fake_agent.draw(run_id)["imageId"]
    assert admin.patch(f"/api/studio/images/{mine}", json={"rating": 1}).status_code == 404
    assert admin.delete(f"/api/studio/images/{mine}").status_code == 404
    assert core_user.delete(f"/api/studio/images/{mine}").status_code == 200


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


def test_edit_own_photo_with_marks_bridge(users, core_user, fake_agent, monkeypatch):
    """Мост человек ↔ агент: своё фото → в галерею → метки → правка уходит агенту с исходником, текстом меток и схемой."""
    from app.modules.files.uploads import save_upload_bytes
    from app.modules.mcp import apps

    anna = users.ids["anna"]
    monkeypatch.setattr(images, "_source", lambda url: ("image/png", _png()))

    up = save_upload_bytes("photo.png", _png(), "image/png", anna)
    assert core_user.post("/api/studio/uploads", json={"key": "../../x.png"}).status_code == 400
    assert core_user.post("/api/studio/uploads", json={"key": up["key"].replace(".png", ".exe")}).status_code in (400, 404)
    photo = core_user.post("/api/studio/uploads", json={"key": up["key"], "name": "фото банера"}).json()["image"]
    assert photo["source"] == "upload" and photo["marks"] == []

    marked = core_user.patch(f"/api/studio/images/{photo['id']}", json={"marks": [{"x": 0.25, "y": 0.4, "note": "убрать надпись"}, {"x": 0.6, "y": 0.1, "w": 0.2, "h": 0.2, "note": "небо ярче"}]})
    assert marked.status_code == 200 and [m["n"] for m in marked.json()["image"]["marks"]] == [1, 2]

    done = core_user.post("/api/studio/generate", json={"prompt": "Сделай как на баннер", "agent": "codex", "parentId": photo["id"]})
    assert done.status_code == 200, done.text
    call = fake_agent.calls[-1]
    assert "точка (25%, 40%): убрать надпись" in call["note"]
    assert call["attachments"][0]["url"] == photo["url"] and any(a["name"] == "метки" for a in call["attachments"])
    result = fake_agent.draw(done.json()["runId"])
    assert _image(core_user, result["imageId"])["parentId"] == photo["id"]

    access = SimpleNamespace(me=SimpleNamespace(user_id=anna, display_name="Анна"), ctx=SimpleNamespace(scope={}))
    gallery = apps.studio_gallery(access, {"query": "банер"})
    row = next(i for i in gallery["images"] if i["id"] == photo["id"])
    assert row["marks"] and "небо ярче" in row["marksText"] and row["studioUrl"] == f"/studio?image={photo['id']}"
    placed = apps.studio_mark(access, {"image_id": photo["id"], "marks": [{"x": 0.5, "y": 0.5, "note": "здесь поправлю"}]})
    assert placed["marks"][0]["n"] == 1 and "здесь поправлю" in placed["marksText"]
