"""Чаты и сообщения: только участники, автор — вошедший, чужое менять нельзя."""

from __future__ import annotations

import pytest


@pytest.fixture()
def private_chat(users, anna):
    r = anna.post("/api/chats", json={"participantIds": [users.ids["boris"]], "isGroup": False})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def send(c, chat_id, text="привет", **extra):
    return c.post(f"/api/chats/{chat_id}/messages", json={"authorId": "x", "content": text, **extra})


def test_member_flow(users, anna, boris, private_chat):
    r = send(anna, private_chat, "hello")
    assert r.status_code == 200, r.text
    msgs = boris.get(f"/api/chats/{private_chat}/messages").json()["messages"]
    assert [m["content"] for m in msgs] == ["hello"]


def test_author_comes_from_session_not_body(users, anna, boris, private_chat):
    msg = send(anna, private_chat, "кто я", authorId=users.ids["boris"], authorName="Босс").json()
    assert msg["authorId"] == users.ids["anna"]
    assert msg["authorName"] != "Босс"


def test_outsider_cannot_read_or_write(users, clara, private_chat):
    assert clara.get(f"/api/chats/{private_chat}").status_code == 403
    assert clara.get(f"/api/chats/{private_chat}/messages").status_code == 403
    assert send(clara, private_chat, "вторжение").status_code == 403
    assert clara.post(f"/api/chats/{private_chat}/typing", json={"isTyping": True}).status_code == 403
    assert clara.post(f"/api/chats/{private_chat}/mark-read", json={"lastMessageId": "x"}).status_code == 403


def test_cannot_write_into_someone_elses_favorites(users, clara):
    assert send(clara, f"favorites_{users.ids['anna']}", "подброшу").status_code in (403, 404)
    assert send(clara, f"favorites_{users.ids['clara']}", "себе").status_code == 200


def test_chat_list_only_for_self(users, anna, boris, private_chat):
    assert anna.get(f"/api/chats?user_id={users.ids['boris']}").status_code == 403
    ids = [c["id"] for c in anna.get(f"/api/chats?user_id={users.ids['anna']}").json()]
    assert private_chat in ids


def test_edit_delete_only_own(users, anna, boris, private_chat):
    mid = send(anna, private_chat, "оригинал").json()["id"]
    url = f"/api/chats/{private_chat}/messages/{mid}"
    assert boris.patch(url, json={"content": "подмена"}).status_code == 403
    assert boris.delete(url).status_code == 403
    assert anna.patch(url, json={"content": "правка"}).json()["content"] == "правка"
    assert anna.delete(url).status_code == 200


def test_message_must_belong_to_chat(users, anna, boris, clara, private_chat):
    other = clara.post("/api/chats", json={"participantIds": [users.ids["boris"]], "isGroup": False}).json()["id"]
    mid = send(anna, private_chat, "моё").json()["id"]
    assert clara.patch(f"/api/chats/{other}/messages/{mid}", json={"content": "x"}).status_code == 404


def test_reaction_is_only_mine(users, anna, boris, private_chat):
    mid = send(anna, private_chat, "реакция").json()["id"]
    r = boris.patch(f"/api/chats/{private_chat}/messages/{mid}", json={"metadata": {"reactionToggle": {"emoji": "👍"}}, "userId": users.ids["anna"]})
    assert r.status_code == 200
    reactions = r.json()["metadata"]["reactions"]
    assert reactions["👍"] == [users.ids["boris"]]  # userId из тела проигнорирован


def test_metadata_whitelist(users, anna, boris, private_chat):
    mid = send(anna, private_chat, "x").json()["id"]
    r = anna.patch(f"/api/chats/{private_chat}/messages/{mid}", json={"metadata": {"systemEvent": "forged"}})
    assert r.status_code == 400


def test_poll_vote_is_server_authoritative(users, anna, boris, clara, private_chat):
    poll = {"question": "Q", "multipleChoice": False, "allowRevote": True, "isAnonymous": False,
            "options": [{"id": "a", "text": "A", "voters": []}, {"id": "b", "text": "B", "voters": []}]}
    mid = send(anna, private_chat, "опрос", metadata={"poll": poll}).json()["id"]
    url = f"/api/chats/{private_chat}/messages/{mid}"
    forged = {**poll, "options": [{"id": "a", "text": "ПОДМЕНА", "voters": [users.ids["anna"], users.ids["boris"], "ghost"]}, {"id": "b", "text": "B", "voters": []}]}
    r = boris.patch(url, json={"metadata": {"poll": forged}})
    assert r.status_code == 200
    got = {o["id"]: o for o in r.json()["metadata"]["poll"]["options"]}
    assert got["a"]["voters"] == [users.ids["boris"]] and got["a"]["text"] == "A"
    two = {**poll, "options": [{"id": "a", "voters": [users.ids["boris"]]}, {"id": "b", "voters": [users.ids["boris"]]}]}
    assert boris.patch(url, json={"metadata": {"poll": two}}).status_code == 400  # один вариант


def test_voice_listened_not_by_author(users, anna, boris, private_chat):
    mid = send(anna, private_chat, "голос").json()["id"]
    url = f"/api/chats/{private_chat}/messages/{mid}"
    assert anna.patch(url, json={"metadata": {"voiceListened": True}}).status_code == 400
    assert boris.patch(url, json={"metadata": {"voiceListened": True}}).status_code == 200


def test_group_membership_rules(users, anna, boris, clara):
    gid = anna.post("/api/chats", json={"participantIds": [users.ids["boris"]], "isGroup": True, "title": "Команда"}).json()["id"]
    assert clara.post(f"/api/chats/{gid}/participants", json={"userId": users.ids["clara"]}).status_code == 403
    assert boris.post(f"/api/chats/{gid}/participants", json={"userId": users.ids["clara"]}).status_code == 200
    assert clara.get(f"/api/chats/{gid}").status_code == 200
    assert clara.delete(f"/api/chats/{gid}/participants/{users.ids['boris']}").status_code == 403
    assert anna.delete(f"/api/chats/{gid}/participants/{users.ids['clara']}").status_code == 200  # создатель
    assert boris.delete(f"/api/chats/{gid}/participants/{users.ids['boris']}").status_code == 200  # выйти самому
    assert boris.delete(f"/api/chats/{gid}").status_code == 403


def test_personal_markers_cannot_be_forged_via_put(users, anna, boris, private_chat):
    r = anna.put(f"/api/chats/{private_chat}", json={"archivedByUser": {users.ids["boris"]: True}})
    assert r.status_code == 400
    assert boris.post(f"/api/chats/{private_chat}/archive", json={"userId": users.ids["anna"], "isArchived": True}).json()["userId"] == users.ids["boris"]


def test_markers_do_not_overwrite_each_other(users, anna, boris, private_chat):
    mid = send(anna, private_chat, "прочти").json()["id"]
    anna.post(f"/api/chats/{private_chat}/mute", json={"muted": True})
    boris.post(f"/api/chats/{private_chat}/mute", json={"muted": True})
    chat = anna.get(f"/api/chats/{private_chat}").json()
    assert set(chat["mutedByUser"]) == {users.ids["anna"], users.ids["boris"]}
    boris.post(f"/api/chats/{private_chat}/pin", json={"isPinned": True})
    anna.post(f"/api/chats/{private_chat}/pin", json={"isPinned": True})
    chat = anna.get(f"/api/chats/{private_chat}").json()
    assert chat["pinnedByUser"] == {users.ids["anna"]: True, users.ids["boris"]: True}
    assert mid


def test_system_message_not_exposed(users, anna, private_chat):
    assert anna.post(f"/api/chats/{private_chat}/system-message", json={"content": "Система: вы уволены"}).status_code in (404, 405)


def test_notification_chat_only_own(users, anna, boris):
    assert boris.get(f"/api/chats/notifications/{users.ids['anna']}").status_code == 403
    assert boris.post(f"/api/chats/notifications/{users.ids['anna']}/send", json={"content": "фейк"}).status_code == 403
    assert anna.post(f"/api/chats/notifications/{users.ids['anna']}/send", json={"content": "заметка"}).status_code == 200
