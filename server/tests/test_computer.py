"""Управление компьютером: агент → сервер → Shar OS человека → ответ со снимком экрана."""

from __future__ import annotations

import threading
import time

import pytest


@pytest.fixture()
def captured(monkeypatch):
    from app.core.realtime import sse_manager

    events: list[tuple[str, dict]] = []
    original = sse_manager.push
    monkeypatch.setattr(sse_manager, "push", lambda uid, data: (events.append((uid, data)), original(uid, data))[-1])
    return events


def _answer_when_asked(client, events, reply: dict, delay: float = 0.2):
    def run():
        for _ in range(100):
            asks = [e for _, e in events if e.get("type") == "computer_request"]
            if asks:
                client.post(f"/api/computer/result/{asks[-1]['id']}", json=reply)
                return
            time.sleep(0.05)
    t = threading.Thread(target=run)
    t.start()
    return t


def test_round_trip_and_isolation(users, anna, boris, captured):
    from app.modules.computer import router as computer

    with pytest.raises(computer.ComputerError):  # не включено — агенту понятная причина
        computer.call(users.ids["anna"], "screenshot", {})

    assert anna.post("/api/computer/presence", json={"deviceId": "dev-anna-0001", "name": "Ноутбук", "width": 1920, "height": 1080}).status_code == 200
    assert [d["name"] for d in computer.devices(users.ids["anna"])] == ["Ноутбук"]
    assert computer.devices(users.ids["boris"]) == []  # чужое устройство не видно

    t = _answer_when_asked(anna, captured, {"ok": True, "image": "QUJD", "width": 1366, "height": 768})
    got = computer.call(users.ids["anna"], "click", {"x": 10, "y": 20, "button": "left"})
    t.join()
    assert got["image"] == "QUJD" and got["device"] == "Ноутбук"
    ask = [e for uid, e in captured if e.get("type") == "computer_request"][-1]
    assert ask["action"] == "click" and ask["deviceId"] == "dev-anna-0001"
    assert all(uid == users.ids["anna"] for uid, e in captured if e.get("type") == "computer_request")

    # ответить на чужой запрос нельзя
    captured.clear()
    t = _answer_when_asked(boris, captured, {"ok": True})
    with pytest.raises(computer.ComputerError):
        computer.WAIT_SECONDS, old = 2, computer.WAIT_SECONDS
        try:
            computer.call(users.ids["anna"], "screenshot", {})
        finally:
            computer.WAIT_SECONDS = old
    t.join()

    # «Стоп» в Shar OS — устройство сразу пропадает
    assert anna.delete("/api/computer/presence/dev-anna-0001").status_code == 200
    assert computer.devices(users.ids["anna"]) == []


def test_tools_only_for_core_runs():
    from app.modules.mcp import tools

    class Ctx:
        def __init__(self, scope):
            self.scope = scope

    tool = tools.BY_NAME["computer_click"]
    base = {"access": "create", "kinds": [], "shared": True, "folders": None, "apps": []}
    assert tools._open(Ctx({**base, "job": "42"}), tool) is True
    assert tools._open(Ctx(base), tool) is False  # личный MCP-ключ внешней программы — нет


def test_image_goes_to_agent_as_picture(monkeypatch):
    from app.modules.mcp import router, tools

    monkeypatch.setattr(tools, "run", lambda ctx, tool, args: {"done": "снимок", "__image__": "QUJD"})
    monkeypatch.setattr(router.keys, "log_call", lambda *a, **k: None)
    out = router._call_tool(type("C", (), {"me": type("M", (), {"user_id": "u"})()})(), "computer_screenshot", {})
    assert out["content"][0] == {"type": "image", "data": "QUJD", "mimeType": "image/jpeg"}
    assert "__image__" not in out["structuredContent"]
