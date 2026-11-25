"""Пуш тем, кто в сети: только на телефоны (на компьютере Шар открыт и покажет сам), остальным — на все устройства.

Раньше «в сети» исключало пуш совсем: пока Шар открыт (даже свёрнут) на компьютере, на телефон ничего не приходило.
"""

from __future__ import annotations


def test_online_user_gets_push_on_phone_only(monkeypatch):
    from app.modules.push import service, store

    subs = {
        "anna": [
            {"endpoint": "https://fcm.googleapis.com/a-desktop", "subscription": {}, "user_agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120"},
            {"endpoint": "https://web.push.apple.com/a-phone", "subscription": {}, "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)"},
        ],
        "boris": [
            {"endpoint": "https://fcm.googleapis.com/b-desktop", "subscription": {}, "user_agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120"},
            {"endpoint": "https://fcm.googleapis.com/b-phone", "subscription": {}, "user_agent": "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile"},
        ],
    }
    sent: list[str] = []
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(store, "subscriptions_of", lambda uid: subs.get(uid, []))
    monkeypatch.setattr(store, "get_prefs", lambda uid: {})
    monkeypatch.setattr(service, "_send_one", lambda item, data, tag: sent.append(item["endpoint"]) or True)

    res = service.notify(["anna", "boris"], title="Новое", body="текст", tag="chat-1", online=["anna"])

    # Анна в сети (Шар открыт на компьютере) — только телефон; Борис не в сети — оба устройства.
    assert sorted(sent) == sorted([
        "https://web.push.apple.com/a-phone",
        "https://fcm.googleapis.com/b-desktop",
        "https://fcm.googleapis.com/b-phone",
    ])
    assert res == {"sent": 3, "failed": 0}


def test_is_mobile():
    from app.modules.push.service import is_mobile

    assert is_mobile("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)")
    assert is_mobile("Mozilla/5.0 (Linux; Android 14; SM-S918B) Mobile")
    assert not is_mobile("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120")
    assert not is_mobile(None)
