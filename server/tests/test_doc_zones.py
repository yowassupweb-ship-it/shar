"""Зоны агента в документе: агент занимает кусок текста, люди его видят (REST и событие), правка подсвечивает место."""

from __future__ import annotations

import json

from app.core.db import db
from app.modules.core_agents import dispatch
from app.modules.mcp import docformat

from tests.test_core_agents import _rpc


def _doc(client_for, text: str) -> dict:
    snapshot = docformat.markdown_to_snapshot("Договор", text)
    r = client_for.post("/api/workspace/items", json={"kind": "document", "title": "Договор", "content": json.dumps(snapshot, ensure_ascii=False)})
    assert r.status_code in (200, 201), r.text
    return r.json().get("item") or r.json()


def test_agent_claims_zone_people_see_it_and_edit_lights_up(client, users, anna):
    token, key_id = dispatch._mcp_key(users.ids["anna"], "claude", "")
    try:
        item = _doc(anna, "Первый абзац про сроки.\n\nВторой абзац про оплату.")
        item_id = str(item["id"])
        assert anna.get(f"/api/workspace/items/{item_id}/zones").json()["zones"] == []

        missing = _rpc(client, token, "document_focus", id=item_id, quote="Такого текста нет")
        assert missing["isError"]

        got = _rpc(client, token, "document_focus", id=item_id, quote="Второй абзац про оплату.", note="переписываю оплату")
        assert not got.get("isError"), got
        zone = got["structuredContent"]["zone"]
        assert "переписываю оплату" in zone["label"]
        seen = anna.get(f"/api/workspace/items/{item_id}/zones").json()["zones"]
        assert [z["id"] for z in seen] == [zone["id"]] and seen[0]["quote"] == "Второй абзац про оплату."

        # повторный вызов с zone_id продлевает ту же зону, а не плодит новую
        again = _rpc(client, token, "document_focus", id=item_id, quote="Второй абзац про оплату.", zone_id=zone["id"])["structuredContent"]["zone"]
        assert again["id"] == zone["id"] and len(anna.get(f"/api/workspace/items/{item_id}/zones").json()["zones"]) == 1

        released = _rpc(client, token, "document_release", id=item_id, zone_id=zone["id"])["structuredContent"]
        assert released["released"] == 1 and anna.get(f"/api/workspace/items/{item_id}/zones").json()["zones"] == []

        # правка агента сама подсвечивает место на несколько секунд
        done = _rpc(client, token, "edit_document", id=item_id, old_text="про сроки", new_text="про новые сроки")
        assert not done.get("isError"), done
        lit = anna.get(f"/api/workspace/items/{item_id}/zones").json()["zones"]
        assert lit and lit[0]["quote"] == "про новые сроки" and "правит" in lit[0]["label"]
    finally:
        db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (key_id,))


def test_zones_are_private_to_people_who_see_the_document(users, anna, boris):
    item = _doc(anna, "Секретный текст.")
    assert boris.get(f"/api/workspace/items/{item['id']}/zones").status_code in (403, 404)
