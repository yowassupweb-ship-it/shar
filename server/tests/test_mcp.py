"""MCP «Офиса»: личные ключи, протокол, инструменты от имени человека и с его правами."""

from __future__ import annotations

import json

from app.modules.mcp import docformat


def _rpc(client, token, method, params=None, rpc_id=1):
    return client.post("/api/mcp", json={"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params or {}},
                       headers={"Authorization": f"Bearer {token}"})


def _call(client, token, name, **args):
    r = _rpc(client, token, "tools/call", {"name": name, "arguments": args})
    assert r.status_code == 200, r.text
    return r.json()["result"]


def _key(user):
    r = user.post("/api/mcp/keys", json={"name": "Claude"})
    assert r.status_code == 201, r.text
    return r.json()["token"]


def test_markdown_roundtrip_and_append():
    snap = docformat.markdown_to_snapshot("Т", "# План\n\nТекст с **жирным** и *курсивом* и [ссылкой](https://x.ru)\n- пункт")
    body = snap["body"]
    assert body["dataStream"].endswith("\r\n") and body["dataStream"].count("\n") == 1
    assert body["sectionBreaks"][0]["startIndex"] == len(body["dataStream"]) - 1
    md = docformat.snapshot_to_markdown(snap)
    assert md.startswith("# План") and "**жирным**" in md and "*курсивом*" in md and "[ссылкой](https://x.ru)" in md and "• пункт" in md
    before = len(body["dataStream"])
    docformat.append_markdown(snap, "## Итог\nготово")
    body = snap["body"]
    assert body["dataStream"].endswith("готово\r\n") and body["dataStream"].count("\n") == 1
    assert body["sectionBreaks"][0]["startIndex"] == len(body["dataStream"]) - 1 > before
    assert docformat.snapshot_to_markdown(snap).endswith("## Итог\nготово")


def test_keys_are_personal_and_revocable(client, anna, boris):
    token = _key(anna)
    assert token.startswith("shar_mcp_")
    keys = anna.get("/api/mcp/keys").json()["keys"]
    assert keys[0]["name"] == "Claude" and token not in json.dumps(keys)
    assert boris.get("/api/mcp/keys").json()["keys"] == [] or all(k["id"] != keys[0]["id"] for k in boris.get("/api/mcp/keys").json()["keys"])
    assert boris.delete(f"/api/mcp/keys/{keys[0]['id']}").status_code == 404
    # без ключа и с чужим — 401, ключ не заменяет сессию на остальном API
    assert client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    assert _rpc(client, "shar_mcp_wrong", "ping").status_code == 401
    assert client.get("/api/mcp/keys", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    assert _rpc(client, token, "ping").json()["result"] == {}
    assert anna.delete(f"/api/mcp/keys/{keys[0]['id']}").status_code == 200
    assert _rpc(client, token, "ping").status_code == 401


def test_protocol_handshake(client, anna):
    token = _key(anna)
    init = _rpc(client, token, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}).json()
    assert init["result"]["protocolVersion"] == "2025-06-18" and "tools" in init["result"]["capabilities"]
    note = client.post("/api/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers={"Authorization": f"Bearer {token}"})
    assert note.status_code == 202
    names = {t["name"] for t in _rpc(client, token, "tools/list").json()["result"]["tools"]}
    assert {"list_items", "read_item", "create_note", "update_note", "create_document", "update_document", "create_table"} <= names
    assert _rpc(client, token, "nope").json()["error"]["code"] == -32601
    assert client.get("/api/mcp").status_code == 405


def test_tools_work_as_the_person(client, anna, boris, users):
    token = _key(anna)
    note = _call(client, token, "create_note", title="Агент", markdown="Первая строка")["structuredContent"]
    _call(client, token, "update_note", id=note["id"], markdown="Вторая строка", mode="append")
    read = _call(client, token, "read_item", id=note["id"])["structuredContent"]
    assert read["content"] == "Первая строка\n\nВторая строка" and read["canEdit"]
    # правка агента — обычная правка: есть в истории версий у человека
    assert anna.get(f"/api/workspace/items/{note['id']}/versions").json()["versions"]

    doc = _call(client, token, "create_document", title="Отчёт", markdown="# Итоги\nВсё **хорошо**")["structuredContent"]
    _call(client, token, "update_document", id=doc["id"], markdown="Дописано агентом")
    md = _call(client, token, "read_item", id=doc["id"])["structuredContent"]["content"]
    assert md.startswith("# Итоги") and "**хорошо**" in md and md.endswith("Дописано агентом")
    # снимок открывается редактором: тот же формат, что у документов из интерфейса
    content = json.loads(anna.get(f"/api/workspace/items/{doc['id']}").json()["item"]["content"])
    assert content["documentStyle"]["pageSize"]["width"] == 794

    table = _call(client, token, "create_table", title="Цифры", rows=[["Город", "Туры"], ["Казань", 12]])["structuredContent"]
    sheets = _call(client, token, "read_item", id=table["id"])["structuredContent"]["sheets"]
    assert sheets[0]["rows"][:2] == [["Город", "Туры"], ["Казань", 12]]

    folder = _call(client, token, "create_folder", title="От агента")["structuredContent"]
    _call(client, token, "move_item", id=doc["id"], folder_id=folder["id"])
    listed = _call(client, token, "list_items", folder_id=folder["id"])["structuredContent"]["items"]
    assert [i["id"] for i in listed] == [doc["id"]] and listed[0]["folder"] == "От агента"

    # чужое закрытое агенту не видно: права те же, что у человека
    secret = boris.post("/api/workspace/items", json={"kind": "note", "title": "Борис", "content": "тайна"}).json()["item"]
    denied = _call(client, token, "read_item", id=secret["id"])
    assert denied["isError"] and "не найден" in denied["content"][0]["text"]
    assert secret["id"] not in {i["id"] for i in _call(client, token, "list_items")["structuredContent"]["items"]}
