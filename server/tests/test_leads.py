"""Заявки: приём по ключу, карточка в выбранный чат, повтор без дубля, права, «Беру»."""

from __future__ import annotations

import uuid

import pytest

KEY = {"X-Shar-Api-Key": "int-key"}


def lead_payload(**over):
    body = {
        "id": f"20261023101500000-{uuid.uuid4().hex[:6]}", "kind": "callback", "site": "corp",
        "fields": {"name": "Ольга", "phone": "+7 (916) 000-00-00", "count": "25", "comment": "Школьная группа"},
        "tour": {"id": "3102", "title": "Волгоград — город-герой"}, "page": "/tour/3102-volgograd", "pageName": "Страница тура",
        "createdAt": "2026-10-23T10:15:00.000Z",
    }
    body.update(over)
    return body


@pytest.fixture()
def lead_chat(users, admin):
    r = admin.post("/api/chats", json={"participantIds": [users.ids["anna"], users.ids["boris"]], "isGroup": True, "title": "Заявки"})
    assert r.status_code == 200, r.text
    chat_id = r.json()["id"]
    r = admin.put("/api/leads/settings", json={"routes": {"corp": chat_id, "school": None}})
    assert r.status_code == 200, r.text
    return chat_id


def chat_cards(client_, chat_id):
    msgs = client_.get(f"/api/chats/{chat_id}/messages").json()
    msgs = msgs.get("messages", msgs) if isinstance(msgs, dict) else msgs
    return [m for m in msgs if (m.get("metadata") or {}).get("card")]


def test_lead_reaches_chat_once(client, users, anna, lead_chat):
    body = lead_payload()
    assert client.post("/api/integrations/leads", json=body).status_code == 401
    assert client.post("/api/integrations/leads", json=body, headers={"X-Shar-Api-Key": "wrong"}).status_code == 401
    assert client.post("/api/integrations/leads", json={**body, "kind": "spam"}, headers=KEY).status_code == 400

    r = client.post("/api/integrations/leads", json=body, headers=KEY)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "id": body["id"], "duplicate": False, "chat": True}
    # Сайт повторил отправку (не дождался ответа) — вторая карточка не появляется.
    r = client.post("/api/integrations/leads", json=body, headers=KEY)
    assert r.status_code == 200 and r.json()["duplicate"] is True

    cards = [m for m in chat_cards(anna, lead_chat) if m["metadata"]["card"]["leadId"] == body["id"]]
    assert len(cards) == 1
    card = cards[0]["metadata"]["card"]
    assert card["kind"] == "lead" and card["status"] == "new" and card["phone"] == "+7 (916) 000-00-00"
    assert {"label": "Волгоград — город-герой (№ 3102)", "url": "https://corp.vs-travel.ru/tour/3102"} in card["links"]
    assert cards[0]["authorName"] == "Заявки"
    assert "Ольга" in cards[0]["content"]


def test_access_and_take(client, users, anna, boris, clara, admin, lead_chat):
    body = lead_payload()
    assert client.post("/api/integrations/leads", json=body, headers=KEY).status_code == 200

    # Приложение — только админу и тем, кому выдан инструмент.
    assert clara.get("/api/leads").status_code == 403
    assert anna.get("/api/leads").status_code == 403
    assert any(lead["id"] == body["id"] for lead in admin.get("/api/leads").json()["leads"])
    assert anna.put("/api/leads/settings", json={"routes": {}}).status_code == 403

    # Не участник чата и без инструмента — не может менять заявку; участник чата — может.
    assert clara.patch(f"/api/leads/{body['id']}", json={"take": True}).status_code == 403
    r = boris.patch(f"/api/leads/{body['id']}", json={"take": True})
    assert r.status_code == 200, r.text
    assert r.json()["lead"]["status"] == "work" and r.json()["lead"]["assigneeId"] == users.ids["boris"]
    card = next(m for m in chat_cards(anna, lead_chat) if m["metadata"]["card"]["leadId"] == body["id"])["metadata"]["card"]
    assert card["status"] == "work" and card["assigneeId"] == users.ids["boris"]

    from app.core.db import db

    db.update_user(users.ids["clara"], {"enabledTools": ["site-leads"]})
    r = clara.get("/api/leads?status=work")
    assert r.status_code == 200
    assert [lead["id"] for lead in r.json()["leads"] if lead["id"] == body["id"]] == [body["id"]]
    r = clara.patch(f"/api/leads/{body['id']}", json={"status": "done"})
    assert r.status_code == 200 and r.json()["lead"]["status"] == "done"
    db.update_user(users.ids["clara"], {"enabledTools": []})


def test_site_without_chat_still_stored(client, admin, lead_chat):
    body = lead_payload(site="school", kind="question", fields={"question": "Есть места на 3 ноября?", "contact": "olga@mail.ru"}, tour=None)
    r = client.post("/api/integrations/leads", json=body, headers=KEY)
    assert r.status_code == 200 and r.json()["chat"] is False
    found = [lead for lead in admin.get("/api/leads?site=school").json()["leads"] if lead["id"] == body["id"]]
    assert found and found[0]["kindLabel"] == "Вопрос" and found[0]["chatId"] is None


def test_waiting_counts_for_involved(client, users, admin, anna, clara, lead_chat):
    before_admin = admin.get("/api/leads/waiting").json()["total"]
    before_anna = anna.get("/api/leads/waiting").json()["total"]
    body = lead_payload()
    assert client.post("/api/integrations/leads", json=body, headers=KEY).status_code == 200
    # Админ (приложение) и Анна (участник чата заявок) видят единичку; Клара к заявкам не причастна.
    assert admin.get("/api/leads/waiting").json()["total"] == before_admin + 1
    assert anna.get("/api/leads/waiting").json()["total"] == before_anna + 1
    assert clara.get("/api/leads/waiting").json()["total"] == 0
    assert anna.patch(f"/api/leads/{body['id']}", json={"take": True}).status_code == 200
    assert anna.get("/api/leads/waiting").json()["total"] == before_anna


def test_nav_tools_saved_by_user(users, anna):
    r = anna.put(f"/api/users/{users.ids['anna']}", json={"navTools": ["site-leads", "social"]})
    assert r.status_code == 200, r.text
    got = anna.get(f"/api/users/{users.ids['anna']}").json()
    assert got.get("navTools") == ["site-leads", "social"]
