"""Комментарии к задачам: видят и пишут участники, ответы, «Решено», права на правку и удаление."""

from __future__ import annotations


def _task(owner, uid, title="Задача", **extra) -> str:
    r = owner.post("/api/todos", json={"type": "todo", "title": title, "assignedToId": uid, "assignedToIds": [uid], **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_comment_thread_on_task(users, anna, boris, clara):
    task = _task(anna, users.ids["boris"], "С комментариями")
    r = boris.post(f"/api/todos/{task}/comments", json={"body": "Уточни срок", "anchor": {"kind": "text", "quote": "срок"}})
    assert r.status_code == 201, r.text
    root = r.json()["comment"]
    assert root["anchor"] == {"kind": "text", "quote": "срок"}

    reply = anna.post(f"/api/todos/{task}/comments", json={"body": "Пятница", "parentId": root["id"]})
    assert reply.status_code == 201, reply.text
    # ответ на ответ нельзя
    assert boris.post(f"/api/todos/{task}/comments", json={"body": "x", "parentId": reply.json()["comment"]["id"]}).status_code == 400

    listed = anna.get(f"/api/todos/{task}/comments").json()
    assert listed["ready"] is True and [c["body"] for c in listed["comments"]] == ["Уточни срок", "Пятница"]

    # чужой задачи не видно
    assert clara.get(f"/api/todos/{task}/comments").status_code == 404
    assert clara.post(f"/api/todos/{task}/comments", json={"body": "Я тут"}).status_code == 404

    # править текст — только автор; закрыть ветку — любой участник
    assert anna.patch(f"/api/todos/{task}/comments/{root['id']}", json={"body": "Чужая правка"}).status_code == 403
    done = anna.patch(f"/api/todos/{task}/comments/{root['id']}", json={"resolved": True})
    assert done.status_code == 200 and done.json()["comment"]["resolved"] is True

    # удалить чужой может автор задачи; ветка уходит вместе с ответами
    assert anna.delete(f"/api/todos/{task}/comments/{root['id']}").status_code == 200
    assert anna.get(f"/api/todos/{task}/comments").json()["comments"] == []


def test_empty_comment_rejected(users, anna):
    task = _task(anna, users.ids["anna"])
    assert anna.post(f"/api/todos/{task}/comments", json={"body": "   "}).status_code == 400
