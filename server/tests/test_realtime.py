"""Сокет, присутствие («в сети»), звонки."""

from __future__ import annotations

import json
import time
import uuid

import pytest
from starlette.websockets import WebSocketDisconnect


def test_ws_rejects_foreign_and_anonymous(users, anna, client):
    with client.websocket_connect(f"/api/ws/{users.ids['boris']}") as ws:      # аноним
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_text()
        assert e.value.code == 1008
    with anna.websocket_connect(f"/api/ws/{users.ids['boris']}") as ws:        # чужой поток
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_text()
        assert e.value.code == 1008


def test_ws_delivers_own_events_and_marks_online(users, anna, boris):
    uid = users.ids["anna"]
    assert next(u for u in boris.get("/api/users/statuses").json() if u["id"] == uid)["isOnline"] is False
    with anna.websocket_connect(f"/api/ws/{uid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
        assert next(u for u in boris.get("/api/users/statuses").json() if u["id"] == uid)["isOnline"] is True
        profile = boris.get(f"/api/users/{uid}").json()
        assert profile["isOnline"] is True                     # профиль и список считают одинаково
        chat = boris.post("/api/chats", json={"participantIds": [uid], "isGroup": False}).json()["id"]
        boris.post(f"/api/chats/{chat}/messages", json={"content": "по сокету", "authorId": "x"})
        got = []
        for _ in range(6):
            ev = json.loads(ws.receive_text())
            got.append(ev["type"])
            if ev["type"] == "new_message":
                assert ev["message"]["content"] == "по сокету" and "seq" in ev
                break
        assert "new_message" in got


def test_ws_send_frame_uses_session_identity(users, anna, boris):
    uid = users.ids["anna"]
    chat = boris.post("/api/chats", json={"participantIds": [uid], "isGroup": False}).json()["id"]
    with anna.websocket_connect(f"/api/ws/{uid}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "send", "id": str(uuid.uuid4()), "chatId": chat, "content": "из сокета", "authorId": users.ids["boris"]}))
        for _ in range(8):
            ev = json.loads(ws.receive_text())
            if ev["type"] in ("ack", "nack"):
                assert ev["type"] == "ack", ev
                break
    msgs = boris.get(f"/api/chats/{chat}/messages").json()["messages"]
    mine = [m for m in msgs if m["content"] == "из сокета"]
    assert mine and mine[0]["authorId"] == uid


def test_presence_lease_expires_without_disconnect(users):
    """Сокет, который не закрылся «чисто» (падение процесса), не держит человека в сети вечно."""
    from app.modules.calls import presence

    uid = users.ids["clara"]
    presence._call_presence_connect(uid, "dead-conn")
    assert uid in presence._ws_online_ids([uid])
    key = presence._zkey(uid)
    if presence._redis_available():
        presence._call_redis.zadd(key, {"dead-conn": time.time() - 1})        # срок аренды истёк
    else:
        presence._local_presence[uid]["dead-conn"] = time.time() - 1
    assert uid not in presence._ws_online_ids([uid])
    presence._call_presence_connect(uid, "a")
    presence._call_presence_connect(uid, "b")
    presence._call_presence_disconnect_and_maybe_schedule(uid, None, "a")
    assert uid in presence._ws_online_ids([uid])                              # второе устройство держит
    presence._call_presence_disconnect_and_maybe_schedule(uid, None, "b")


def test_calls_signaling_scoped_to_chat(users, anna, boris, clara):
    chat = anna.post("/api/chats", json={"participantIds": [users.ids["boris"]], "isGroup": False}).json()["id"]
    body = {"type": "join", "callId": "call-1", "fromUserId": users.ids["clara"], "chatId": chat, "toUserIds": [users.ids["boris"]], "callType": "voice"}
    assert clara.post("/api/calls/signal", json=body).status_code == 403          # не участник
    ok = anna.post("/api/calls/signal", json={**body, "fromUserId": users.ids["clara"]})
    assert ok.status_code == 200
    second = boris.post("/api/calls/signal", json={**body, "toUserIds": [users.ids["anna"]]}).json()
    assert users.ids["anna"] in second["participantIds"]                           # anna вошла от своего имени, а не clara из тела
    assert users.ids["clara"] not in second["participantIds"]
    assert clara.get("/api/calls/active-rooms").json()["rooms"].get(chat) is None  # чужие комнаты не видны
    assert boris.get("/api/calls/active-rooms").json()["rooms"][chat]
    anna.post("/api/calls/signal", json={**body, "type": "leave", "toUserIds": []})
