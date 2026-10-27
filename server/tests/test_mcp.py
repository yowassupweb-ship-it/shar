"""MCP «Офиса»: личные ключи с доступом, протокол, инструменты от имени человека и только в пределах ключа."""

from __future__ import annotations

import json

from app.modules.mcp import docformat

FULL = {"access": "create", "kinds": ["note", "document", "table", "presentation"], "folders": None, "shared": True}


def _rpc(client, token, method, params=None, rpc_id=1):
    return client.post("/api/mcp", json={"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params or {}},
                       headers={"Authorization": f"Bearer {token}"})


def _call(client, token, name, **args):
    r = _rpc(client, token, "tools/call", {"name": name, "arguments": args})
    assert r.status_code == 200, r.text
    return r.json()["result"]


def _ok(client, token, name, **args):
    result = _call(client, token, name, **args)
    assert not result.get("isError"), result
    return result["structuredContent"]


def _key(user, scope=None, **extra):
    r = user.post("/api/mcp/keys", json={"name": "Claude", "scope": scope or FULL, **extra})
    assert r.status_code == 201, r.text
    return r.json()["token"], r.json()["key"]


def test_markdown_roundtrip_append_and_replace():
    snap = docformat.markdown_to_snapshot("Т", "# План\n\nТекст с **жирным** и *курсивом* и [ссылкой](https://x.ru)\n- пункт")
    body = snap["body"]
    assert body["dataStream"].endswith("\r\n") and body["dataStream"].count("\n") == 1
    md = docformat.snapshot_to_markdown(snap)
    assert md.startswith("# План") and "**жирным**" in md and "*курсивом*" in md and "[ссылкой](https://x.ru)" in md and "• пункт" in md
    docformat.append_markdown(snap, "## Итог\nготово")
    assert snap["body"]["dataStream"].endswith("готово\r\n") and snap["body"]["sectionBreaks"][0]["startIndex"] == len(snap["body"]["dataStream"]) - 1
    # точечная замена сохраняет оформление: жирное остаётся жирным, всё после — на своих местах
    assert docformat.replace_text(snap, "Текст с", "Новый длинный текст с") == 1
    md = docformat.snapshot_to_markdown(snap)
    assert "Новый длинный текст с **жирным** и *курсивом* и [ссылкой](https://x.ru)" in md and md.endswith("## Итог\nготово")
    assert docformat.replace_text(snap, "жирным", "ЖИРНЫМ") == 1 and "**ЖИРНЫМ**" in docformat.snapshot_to_markdown(snap)
    for bad in ("нет такого", "с\nпереносом"):
        try:
            docformat.replace_text(snap, bad, "x")
            raise AssertionError(bad)
        except docformat.TextNotFound:
            pass


def test_keys_are_personal_revocable_and_expire(client, anna, boris):
    token, key = _key(anna)
    assert token.startswith("shar_mcp_")
    keys = anna.get("/api/mcp/keys").json()["keys"]
    assert keys[0]["scope"]["access"] == "create" and token not in json.dumps(keys)
    assert all(k["id"] != key["id"] for k in boris.get("/api/mcp/keys").json()["keys"])
    assert boris.delete(f"/api/mcp/keys/{key['id']}").status_code == 404
    assert boris.patch(f"/api/mcp/keys/{key['id']}", json={"name": "чужой"}).status_code == 404
    # без ключа и с чужим — 401, ключ не заменяет сессию на остальном API
    assert client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    assert _rpc(client, "shar_mcp_wrong", "ping").status_code == 401
    assert client.get("/api/mcp/keys", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    assert _rpc(client, token, "ping").json()["result"] == {}
    assert anna.delete(f"/api/mcp/keys/{key['id']}").status_code == 200
    assert _rpc(client, token, "ping").status_code == 401
    # просроченный ключ не работает
    from app.core.db import db

    token, key = _key(anna, expiresInDays=30)
    assert key["expiresAt"] and _rpc(client, token, "ping").status_code == 200
    db.conn.execute_query("UPDATE mcp_keys SET expires_at = now() - interval '1 minute' WHERE id = %s", (int(key["id"]),))
    assert _rpc(client, token, "ping").status_code == 401
    assert anna.post("/api/mcp/keys", json={"name": "x", "scope": {**FULL, "kinds": []}}).status_code == 400


def test_protocol_and_tools_follow_access_level(client, anna):
    token, _ = _key(anna, {**FULL, "access": "read"})
    init = _rpc(client, token, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}).json()
    assert init["result"]["protocolVersion"] == "2025-06-18" and "только чтение" in init["result"]["instructions"]
    note = client.post("/api/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers={"Authorization": f"Bearer {token}"})
    assert note.status_code == 202
    names = {t["name"] for t in _rpc(client, token, "tools/list").json()["result"]["tools"]}
    assert names == {"list_items", "list_folders", "read_item"}
    denied = _call(client, token, "create_note", title="x", markdown="y")
    assert denied["isError"] and "не открыт" in denied["content"][0]["text"]
    assert _rpc(client, token, "nope").json()["error"]["code"] == -32601
    assert client.get("/api/mcp").status_code == 405


def test_tools_work_as_the_person(client, anna, boris):
    token, key = _key(anna)
    note = _ok(client, token, "create_note", title="Агент", markdown="Первая строка")
    _ok(client, token, "update_note", id=note["id"], markdown="Вторая строка", mode="append")
    _ok(client, token, "edit_note", id=note["id"], old_text="Вторая", new_text="Третья")
    read = _ok(client, token, "read_item", id=note["id"])
    assert read["content"] == "Первая строка\n\nТретья строка" and read["canEdit"]
    # перед правкой агента — версия с пометкой: человек может вернуть прежнее
    versions = anna.get(f"/api/workspace/items/{note['id']}/versions").json()["versions"]
    assert any("До правки агента «Claude»" in (v.get("label") or "") for v in versions)

    doc = _ok(client, token, "create_document", title="Отчёт", markdown="# Итоги\nВсё **хорошо** и спокойно")
    _ok(client, token, "edit_document", id=doc["id"], old_text="спокойно", new_text="по плану")
    _ok(client, token, "update_document", id=doc["id"], markdown="Дописано агентом")
    md = _ok(client, token, "read_item", id=doc["id"])["content"]
    assert md.startswith("# Итоги") and "**хорошо** и по плану" in md and md.endswith("Дописано агентом")
    assert "Всё хорошо и по плану" in _ok(client, token, "read_item", id=doc["id"], format="text")["content"]
    content = json.loads(anna.get(f"/api/workspace/items/{doc['id']}").json()["item"]["content"])
    assert content["documentStyle"]["pageSize"]["width"] == 794

    table = _ok(client, token, "create_table", title="Цифры", rows=[["Город", "Туры"], ["Казань", 12]])
    _ok(client, token, "update_table", id=table["id"], cells=[{"ref": "B2", "value": 15}], append_rows=[["Сочи", 7]])
    rows = _ok(client, token, "read_item", id=table["id"])["sheets"][0]["rows"]
    assert rows == [["Город", "Туры"], ["Казань", 15], ["Сочи", 7]]

    folder = _ok(client, token, "create_folder", title="От агента")
    _ok(client, token, "move_item", id=doc["id"], folder_id=folder["id"])
    listed = _ok(client, token, "list_items", folder_id=folder["id"])["items"]
    assert [i["id"] for i in listed] == [doc["id"]] and listed[0]["folder"] == "От агента"

    # чужое закрытое агенту не видно: права те же, что у человека
    secret = boris.post("/api/workspace/items", json={"kind": "note", "title": "Борис", "content": "тайна"}).json()["item"]
    denied = _call(client, token, "read_item", id=secret["id"])
    assert denied["isError"] and "не найден" in denied["content"][0]["text"]
    # журнал ключа: что агент делал
    log = anna.get(f"/api/mcp/keys/{key['id']}/log").json()["log"]
    assert {"create_note", "edit_note", "edit_document", "update_table", "read_item"} <= {e["tool"] for e in log}
    assert any(not e["ok"] for e in log if e["tool"] == "read_item")


def test_scope_folders_kinds_and_shared(client, anna, boris, users):
    open_folder = anna.post("/api/workspace/folders", json={"title": "Для агента"}).json()["folder"]
    inner = anna.post("/api/workspace/folders", json={"title": "Внутри", "parentId": open_folder["id"]}).json()["folder"]
    closed = anna.post("/api/workspace/folders", json={"title": "Личное"}).json()["folder"]

    def note(title, folder=None):
        item = anna.post("/api/workspace/items", json={"kind": "note", "title": title, "content": title}).json()["item"]
        if folder:
            anna.put(f"/api/workspace/items/{item['id']}/folder", json={"folderId": folder["id"]})
        return item

    allowed, nested, hidden, loose = note("Открытая", open_folder), note("Вложенная", inner), note("Закрытая", closed), note("Без папки")
    doc = anna.post("/api/workspace/items", json={"kind": "document", "title": "Док в папке",
                                                  "content": json.dumps(docformat.markdown_to_snapshot("", "x"))}).json()["item"]
    anna.put(f"/api/workspace/items/{doc['id']}/folder", json={"folderId": open_folder["id"]})

    token, _ = _key(anna, {"access": "create", "kinds": ["note"], "folders": [open_folder["id"]], "shared": False})
    seen = {i["id"] for i in _ok(client, token, "list_items")["items"]}
    assert {allowed["id"], nested["id"]} <= seen and not seen & {hidden["id"], loose["id"], doc["id"]}
    assert {f["id"] for f in _ok(client, token, "list_folders")["folders"]} == {open_folder["id"], inner["id"]}
    for item in (hidden, loose, doc):
        assert _call(client, token, "read_item", id=item["id"])["isError"]
    # создавать — только в открытых папках, вынести наружу нельзя, чужой вид — нельзя
    assert _call(client, token, "create_note", title="x", markdown="y")["isError"]
    made = _ok(client, token, "create_note", title="Новая", markdown="y", folder_id=inner["id"])
    assert made["folderId"] == inner["id"]
    assert _call(client, token, "move_item", id=allowed["id"])["isError"]
    assert _call(client, token, "move_item", id=allowed["id"], folder_id=closed["id"])["isError"]
    assert _call(client, token, "create_document", title="d", markdown="m", folder_id=open_folder["id"])["isError"]

    # чужое, открытое человеку: видно только при shared=true
    shared = boris.post("/api/workspace/items", json={"kind": "note", "title": "От Бориса", "content": "общее"}).json()["item"]
    boris.put(f"/api/workspace/items/{shared['id']}/shares", json={"userId": users.ids["anna"], "role": "edit"})
    everything, _ = _key(anna)
    assert shared["id"] in {i["id"] for i in _ok(client, everything, "list_items")["items"]}
    own_only, own_key = _key(anna, {**FULL, "shared": False})
    assert shared["id"] not in {i["id"] for i in _ok(client, own_only, "list_items")["items"]}
    # доступ меняется без смены ключа у агента и действует сразу
    assert anna.patch(f"/api/mcp/keys/{own_key['id']}", json={"scope": {**FULL, "shared": True}}).status_code == 200
    assert shared["id"] in {i["id"] for i in _ok(client, own_only, "list_items")["items"]}
