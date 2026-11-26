"""Комментарий к задаче — как сообщение: уведомление участникам, непрочитанные у задачи и число на кнопке «Задачи»,
которое гаснет, когда задачу открыли. И два правила пушей: активному в Шаре на телефон не шлём, прочитанный чат
снимает уведомление на остальных устройствах."""

from __future__ import annotations

import pytest

from app.modules.todos import router as todos_router


def _task(owner, uid, title="Задача") -> str:
    r = owner.post("/api/todos", json={"type": "todo", "title": title, "assignedToId": uid, "assignedToIds": [uid]})
    assert r.status_code in (200, 201), r.text
    return str(r.json()["id"])


@pytest.fixture()
def notices(monkeypatch):
    got: list[tuple[str, str, str, str]] = []
    monkeypatch.setattr(todos_router, "_send_task_notice", lambda uid, kind, tid, text, actor: got.append((uid, kind, tid, text)))
    return got


def _unread(client, tid: str) -> int:
    return {str(t["id"]): t for t in client.get("/api/todos").json()["todos"]}[tid].get("unreadComments", 0)


def test_comment_notifies_participants_and_counts_until_opened(users, anna, boris, clara, notices):
    from app.modules.todos import seen

    seen.new_since()
    a, b = users.ids["anna"], users.ids["boris"]
    tid = _task(anna, b, "Макет буклета")
    anna.post(f"/api/todos/{tid}/seen")
    boris.post(f"/api/todos/{tid}/seen")
    notices.clear()
    before = boris.get("/api/todos/badge").json()["count"]

    assert anna.post(f"/api/todos/{tid}/comments", json={"body": "Поправь, пожалуйста, обложку"}).status_code == 201
    got = [(uid, kind) for uid, kind, t, _ in notices if t == tid]
    assert got == [(b, "task_comment")]  # себе (Анне) не пишем, Клара — не участник
    assert "Поправь" in notices[-1][3] and "Макет буклета" in notices[-1][3]

    assert _unread(boris, tid) == 1 and _unread(anna, tid) == 0
    assert boris.get("/api/todos/badge").json()["count"] == before + 1

    # Борис открыл задачу — прочитано.
    assert boris.post(f"/api/todos/{tid}/seen").status_code == 200
    assert _unread(boris, tid) == 0
    assert boris.get("/api/todos/badge").json()["count"] == before

    # Ответ Бориса — Анне; Борис теперь и сам участник обсуждения.
    notices.clear()
    boris.post(f"/api/todos/{tid}/comments", json={"body": "Готово"})
    assert [(uid, kind) for uid, kind, t, _ in notices if t == tid] == [(a, "task_comment")]


def test_active_user_gets_no_push_and_read_dismisses(monkeypatch):
    from app.modules.push import activity, service, store

    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(store, "subscriptions_of", lambda uid: [
        {"endpoint": f"https://web.push.apple.com/{uid}-phone", "subscription": {}, "user_agent": "iPhone", "caps": "dismiss"},
        {"endpoint": f"https://fcm.googleapis.com/{uid}-old", "subscription": {}, "user_agent": "Android", "caps": ""},
    ])
    monkeypatch.setattr(service, "_send_one", lambda item, data, tag: sent.append((item["endpoint"], data)) or True)

    activity.touch("u-active")
    assert activity.is_active("u-active") and not activity.is_active("u-idle")

    # «Отмена» — только устройствам, которые её умеют, и одна на пуш.
    activity.mark_pushed("u-idle", "chat-9")
    assert activity.take_pushed("u-idle", "chat-9") and not activity.take_pushed("u-idle", "chat-9")
    service.dismiss("u-idle", "c9")
    assert [e for e, _ in sent] == ["https://web.push.apple.com/u-idle-phone"]
    assert '"type": "dismiss"' in sent[0][1] and '"chatId": "c9"' in sent[0][1]


def test_reply_to_specific_message_keeps_who(users, anna, boris, notices):
    tid = _task(anna, users.ids["boris"], "Ответы")
    root = anna.post(f"/api/todos/{tid}/comments", json={"body": "Кто берёт обложку?"}).json()["comment"]
    first = boris.post(f"/api/todos/{tid}/comments", json={"body": "Я", "parentId": root["id"]}).json()["comment"]
    reply = anna.post(f"/api/todos/{tid}/comments", json={
        "body": "Спасибо", "parentId": root["id"],
        "anchor": {"kind": "reply", "to": first["id"], "name": "Борис", "quote": "Я", "junk": "x"}}).json()["comment"]
    assert reply["anchor"] == {"kind": "reply", "to": first["id"], "name": "Борис", "quote": "Я"}
    # у ответа нельзя подсунуть привязку к тексту
    odd = anna.post(f"/api/todos/{tid}/comments", json={"body": "x", "parentId": root["id"], "anchor": {"kind": "text", "quote": "y"}}).json()["comment"]
    assert odd["anchor"] == {}
