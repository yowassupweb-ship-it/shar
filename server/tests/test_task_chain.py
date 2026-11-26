"""Цепочки задач (уведомления этапов), «Новое» у задач и поток агента в задаче."""

from __future__ import annotations

import uuid

import pytest

from app.modules.todos import router as todos_router


def _task(owner, uid, title="Задача", **extra) -> str:
    r = owner.post("/api/todos", json={"type": "todo", "title": title, "assignedToId": uid, "assignedToIds": [uid], **extra})
    assert r.status_code in (200, 201), r.text
    return str(r.json()["id"])


@pytest.fixture()
def notices(monkeypatch):
    got: list[tuple[str, str, str, str]] = []
    monkeypatch.setattr(todos_router, "_send_task_notice", lambda uid, kind, tid, text, actor: got.append((uid, kind, tid, text)))
    return got


CHAIN_ID = f"c-site-{uuid.uuid4().hex[:8]}"  # база между прогонами не чистится — своя цепочка на прогон


def _chain(client, tid: str, order: int, owner: str | None = None, chain_id: str = CHAIN_ID):
    ref = {"id": chain_id, "order": order * 1024, "name": "Сайт", **({"owner": owner} if owner else {})}
    r = client.put("/api/todos", json={"id": tid, "type": "todo", "metadata": {"chain": ref}})
    assert r.status_code == 200, r.text


def _done(client, tid: str, value: bool = True):
    r = client.put("/api/todos", json={"id": tid, "type": "todo", "isCompleted": value, "completed": value})
    assert r.status_code == 200, r.text


def test_chain_turns_reopen_and_finish(users, anna, boris, clara, notices):
    a, b, c = users.ids["anna"], users.ids["boris"], users.ids["clara"]
    t1 = _task(anna, a, "Макет")          # ответственный не назначен — по умолчанию заказчик (Анна)
    t2 = _task(anna, b, "Тестирование")   # ответственный — Борис
    t3 = _task(anna, c, "Тексты")         # ответственный — Клара
    notices.clear()
    for i, (tid, owner) in enumerate(((t1, None), (t2, b), (t3, c)), start=1):
        _chain(anna, tid, i, owner)
    owners = {(uid, kind) for uid, kind, _, _ in notices if kind == "task_chain_owner"}
    assert owners == {(b, "task_chain_owner"), (c, "task_chain_owner")}  # Анна включала сама — ей не пишем

    notices.clear()
    _done(anna, t1)
    turn = [n for n in notices if n[1] == "task_chain_turn"]
    assert [(uid, tid) for uid, _, tid, _ in turn] == [(b, t2)]
    assert "этап 2 из 3" in turn[0][3] and "«Сайт»" in turn[0][3]

    notices.clear()
    _done(boris, t2)
    assert [(n[0], n[2]) for n in notices if n[1] == "task_chain_turn"] == [(c, t3)]

    notices.clear()
    _done(clara, t3)
    done = [n for n in notices if n[1] == "task_chain_done"]
    assert {n[0] for n in done} == {a}  # заказчик этапов; Клара закрыла сама

    notices.clear()
    _done(anna, t3, False)
    assert [(n[0], n[1]) for n in notices if n[1] == "task_chain_reopened"] == [(c, "task_chain_reopened")]


def test_new_badge_until_opened(users, anna, boris):
    from app.modules.todos import seen

    seen.new_since()  # точка отсчёта «нового» — первое обращение после выкатки, до этой задачи
    tid = _task(anna, users.ids["boris"], "Поручение")
    listed = {str(t["id"]): t for t in boris.get("/api/todos").json()["todos"]}
    assert listed[tid]["isNew"] is True
    # Своя задача и поручение самому себе — не «новые».
    assert {str(t["id"]): t for t in anna.get("/api/todos").json()["todos"]}[tid].get("isNew") is False
    assert boris.post(f"/api/todos/{tid}/seen").status_code == 200
    assert {str(t["id"]): t for t in boris.get("/api/todos").json()["todos"]}[tid]["isNew"] is False


def test_agent_streams_task_text(users, anna, client, monkeypatch):
    """Агент (MCP task_update) — перед записью текст задачи уходит открывшим частями (task_stream), итог — правкой."""
    from app.modules.core_agents import dispatch
    from app.modules.mcp import apps
    from tests.test_core_agents import _rpc

    tid = _task(anna, users.ids["anna"], "Отчёт")
    streamed: list[dict] = []
    monkeypatch.setattr(todos_router, "push_task_stream", lambda task, data: streamed.append(data))
    monkeypatch.setattr(apps, "STREAM_BUDGET_S", 0.0)
    token, _ = dispatch._mcp_key(users.ids["anna"], "claude", "")
    text = "Собрать цифры продаж за ноябрь по всем направлениям и сравнить с прошлым годом."
    assert not _rpc(client, token, "task_update", id=tid, text=text).get("isError")
    assert streamed and streamed[-1]["md"] == text and len(streamed) > 3
    assert all(text.startswith(p["md"]) for p in streamed) and streamed[0]["agent"]
    saved = {str(t["id"]): t for t in anna.get("/api/todos").json()["todos"]}[tid]
    assert saved["metadata"]["md"] == text


def test_owner_is_separate_from_assignee(users, anna, boris, clara, notices):
    """Ответственный за этап — своя роль цепочки: по умолчанию заказчик, исполнитель на неё не влияет."""
    a, b, c = users.ids["anna"], users.ids["boris"], users.ids["clara"]
    chain_id = f"c-own-{uuid.uuid4().hex[:8]}"
    t1 = _task(anna, b, "Бриф")
    t2 = _task(anna, b, "Вёрстка")        # исполнитель Борис, ответственный не назначен → Анна
    _chain(anna, t1, 1, chain_id=chain_id)
    _chain(anna, t2, 2, chain_id=chain_id)
    assert not [n for n in notices if n[1] == "task_chain_owner"]  # Анна сама себе не пишет, Борис не ответственный

    notices.clear()
    _done(boris, t1)                      # очередь второго этапа — его ответственной (Анне), не исполнителю
    assert [(n[0], n[2]) for n in notices if n[1] == "task_chain_turn"] == [(a, t2)]

    # Назначили ответственной Клару (она не исполнитель и не заказчик) — ей уведомление, задача у неё в списке.
    notices.clear()
    _chain(anna, t2, 2, owner=c, chain_id=chain_id)
    assert [(n[0], n[2]) for n in notices if n[1] == "task_chain_owner"] == [(c, t2)]
    mine = {str(t["id"]) for t in clara.get("/api/todos").json()["todos"]}
    assert t2 in mine
    assert clara.get("/api/todos", params={"taskId": t2}).status_code == 200
    # Исполнитель при этом не менялся.
    saved = {str(t["id"]): t for t in anna.get("/api/todos").json()["todos"]}[t2]
    assert b in (saved.get("assignedToIds") or []) and saved["metadata"]["chain"]["owner"] == c
