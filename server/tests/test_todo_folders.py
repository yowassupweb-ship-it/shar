"""Папки задач: открыть людям (view/edit) и история версий текста задачи."""

from __future__ import annotations


def _folder(owner, name="Папка") -> str:
    r = owner.post("/api/todos", json={"type": "list", "name": name, "color": "#3b82f6"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _task(owner, uid, list_id, title="Задача", **extra) -> str:
    r = owner.post("/api/todos", json={"type": "todo", "title": title, "listId": list_id, "assignedToId": uid, "assignedToIds": [uid], **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _ids(client) -> set[str]:
    return {t["id"] for t in client.get("/api/todos").json()["todos"]}


def test_shared_folder_shows_tasks_and_follows_level(users, anna, boris, clara):
    folder = _folder(anna)
    task = _task(anna, users.ids["anna"], folder, "Общая")
    assert task not in _ids(boris)  # пока не открыта — чужая задача не видна

    r = anna.put(f"/api/todos/lists/{folder}/shares", json={"shares": [{"userId": users.ids["boris"], "level": "view"}]})
    assert r.status_code == 200, r.text
    data = boris.get("/api/todos").json()
    assert task in {t["id"] for t in data["todos"]}
    assert folder in {l["id"] for l in data["lists"]}
    assert task not in _ids(clara)

    # только просмотр: ни править, ни добавлять
    assert boris.put("/api/todos", json={"id": task, "type": "todo", "title": "Взлом"}).status_code == 403
    assert boris.post("/api/todos", json={"type": "todo", "title": "Своя", "listId": folder}).status_code == 403

    anna.put(f"/api/todos/lists/{folder}/shares", json={"shares": [{"userId": users.ids["boris"], "level": "edit"}]})
    assert boris.put("/api/todos", json={"id": task, "type": "todo", "title": "Правка"}).status_code == 200
    own = _task(boris, users.ids["boris"], folder, "Задача Бориса")
    assert own in _ids(anna) or own in _ids(boris)

    # закрыли доступ — снова не видно
    anna.put(f"/api/todos/lists/{folder}/shares", json={"shares": []})
    assert task not in _ids(boris)


def test_only_owner_manages_shares(users, anna, boris):
    folder = _folder(anna, "Только моя")
    assert boris.get(f"/api/todos/lists/{folder}/shares").status_code == 403
    assert boris.put(f"/api/todos/lists/{folder}/shares", json={"shares": [{"userId": users.ids["boris"], "level": "edit"}]}).status_code == 403
    # владелец не может «поделиться сам с собой», неизвестные люди игнорируются
    r = anna.put(f"/api/todos/lists/{folder}/shares", json={"shares": [{"userId": users.ids["anna"]}, {"userId": "нет-такого"}]})
    assert r.status_code == 200 and r.json()["shares"] == []


def test_delete_folder_drops_shares(users, anna, boris):
    from app.core.db import db

    folder = _folder(anna, "Удаляемая")
    anna.put(f"/api/todos/lists/{folder}/shares", json={"shares": [{"userId": users.ids["boris"], "level": "edit"}]})
    assert anna.delete(f"/api/todos?id={folder}&type=list").status_code == 200
    assert db.conn.fetch_one("SELECT 1 FROM todo_list_shares WHERE list_id = %s", (folder,)) is None


def test_versions_merge_restore_and_access(users, anna, boris):
    task = _task(anna, users.ids["anna"], None, "Версии")
    anna.put("/api/todos", json={"id": task, "type": "todo", "title": "Версии", "metadata": {"md": "первый текст"}})
    anna.put("/api/todos", json={"id": task, "type": "todo", "title": "Версии", "metadata": {"md": "первый текст, дополнен"}})
    versions = anna.get(f"/api/todos/{task}/versions").json()["versions"]
    assert len(versions) == 1  # правки подряд одного автора слиты в одну версию
    assert anna.post(f"/api/todos/{task}/versions", json={"label": "Черновик"}).status_code == 201
    anna.put("/api/todos", json={"id": task, "type": "todo", "title": "Версии", "metadata": {"md": "второй текст"}})
    listed = anna.get(f"/api/todos/{task}/versions").json()["versions"]
    assert [v["label"] for v in listed][:2] == ["", "Черновик"]
    draft = next(v for v in listed if v["label"] == "Черновик")
    got = anna.get(f"/api/todos/{task}/versions/{draft['id']}").json()
    assert got["md"] == "первый текст, дополнен"
    restored = anna.post(f"/api/todos/{task}/versions/{draft['id']}/restore").json()
    assert restored["md"] == "первый текст, дополнен"
    assert any(v["label"] == "Перед восстановлением" for v in anna.get(f"/api/todos/{task}/versions").json()["versions"])
    assert boris.get(f"/api/todos/{task}/versions").status_code == 403
