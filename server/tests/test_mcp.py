"""MCP «Офиса»: личные ключи с доступом, протокол, инструменты от имени человека и только в пределах ключа."""

from __future__ import annotations

import json
from datetime import datetime, timezone

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


def test_grouped_text_edits_are_atomic_and_keep_document_formatting(client, anna):
    token, key = _key(anna)
    doc = _ok(client, token, "create_document", title="План", markdown="Первая **строка**\nВторая строка\nТретья строка")
    edits = [{"old_text": "Первая", "new_text": "Новая первая"}, {"old_text": "Вторая", "new_text": "Новая вторая"}]
    preview = _ok(client, token, "edit_document", id=doc["id"], replacements=edits, dry_run=True)
    assert preview["replaced"] == 2 and preview["preview"] and "Новая первая" in preview["diff"]
    assert "Новая первая" not in _ok(client, token, "read_item", id=doc["id"], format="text")["content"]
    result = _ok(client, token, "edit_document", id=doc["id"], replacements=edits)
    assert result["replaced"] == 2 and result["updatedAt"]
    assert "Новая первая **строка**" in _ok(client, token, "read_item", id=doc["id"])["content"]
    failed = _call(client, token, "edit_document", id=doc["id"], replacements=[
        {"old_text": "Новая первая", "new_text": "Испорчено"}, {"old_text": "нет такой строки", "new_text": "Ошибка"}])
    assert failed["isError"]
    assert "Испорчено" not in _ok(client, token, "read_item", id=doc["id"], format="text")["content"]

    note = _ok(client, token, "create_note", title="Заметка", markdown="Один\nДва\nТри")
    assert _ok(client, token, "edit_note", id=note["id"], replacements=[
        {"old_text": "Один", "new_text": "Первый"}, {"old_text": "Два", "new_text": "Второй"}])["replaced"] == 2
    assert _ok(client, token, "read_item", id=note["id"])["content"] == "Первый\nВторой\nТри"
    assert anna.delete(f"/api/mcp/keys/{key['id']}").status_code == 200


def test_typographic_text_matching_is_unique_and_keeps_formatting(client, anna):
    token, key = _key(anna)
    try:
        note = _ok(client, token, "create_note", title="Пробелы", markdown="Срок — 5\u00a0дней")
        assert _ok(client, token, "edit_note", id=note["id"], old_text="Срок - 5 дней", new_text="Срок — 6 дней")["replaced"] == 1
        assert _ok(client, token, "read_item", id=note["id"])["content"] == "Срок — 6 дней"
        _ok(client, token, "update_note", id=note["id"], markdown="А—Б и А–Б")
        ambiguous = _call(client, token, "edit_note", id=note["id"], old_text="А-Б", new_text="X")
        assert ambiguous["isError"] and ambiguous["error"]["code"] == "text_not_unique"

        doc = _ok(client, token, "create_document", title="План", markdown="**Срок — 5\u00a0дней** и итог")
        assert _ok(client, token, "edit_document", id=doc["id"], old_text="Срок - 5 дней", new_text="Срок — 6 дней")["replaced"] == 1
        assert "**Срок — 6 дней**" in _ok(client, token, "read_item", id=doc["id"])["content"]
    finally:
        anna.delete(f"/api/mcp/keys/{key['id']}")


def test_note_tab_read_and_edit_stay_within_selected_tab(client, anna):
    token, key = _key(anna)
    try:
        note = _ok(client, token, "create_note", title="Вкладки", markdown="Одинаковая строка\n<!-- shar-tab: План -->\nОдинаковая строка")
        shown = _ok(client, token, "read_item", id=note["id"])
        assert [tab["title"] for tab in shown["tabs"]] == ["Основная", "План"]
        tab = _ok(client, token, "read_item", id=note["id"], tab="План")
        assert tab["content"] == "Одинаковая строка" and tab["tab"] == "План"
        changed = _ok(client, token, "edit_note", id=note["id"], tab="План",
                      old_text="Одинаковая строка", new_text="Новая строка")
        assert changed["replaced"] == 1
        assert _ok(client, token, "read_item", id=note["id"])["content"] == "Одинаковая строка\n<!-- shar-tab: План -->\nНовая строка"
    finally:
        anna.delete(f"/api/mcp/keys/{key['id']}")


def test_changes_list_paginates_items_and_comments_without_leaking_private_items(client, anna, boris):
    since = datetime.now(timezone.utc).isoformat()
    token, key = _key(anna)
    other, other_key = _key(boris)
    try:
        note = _ok(client, token, "create_note", title="Лента тест", markdown="Первая версия")
        _ok(client, token, "add_comment", id=note["id"], text="Проверить абзац")
        found = []
        cursor = None
        for _ in range(5):
            page = _ok(client, token, "changes_list", since=since, cursor=cursor, limit=1)
            found.extend(e for e in page["events"] if (e.get("item") or {}).get("id") == note["id"])
            cursor = page["nextCursor"]
            if not page["hasMore"]:
                break
        assert {e["type"] for e in found} == {"item_changed", "comment"}
        private = _ok(client, other, "changes_list", since=since)
        assert all((e.get("item") or {}).get("id") != note["id"] for e in private["events"])
    finally:
        anna.delete(f"/api/mcp/keys/{key['id']}")
        boris.delete(f"/api/mcp/keys/{other_key['id']}")


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
    assert names == {"list_items", "list_folders", "read_item", "list_comments", "resolve_item", "item_versions", "diff_item", "changes_list", "capabilities", "tool_search", "batch"}
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
    # серия правок агента — одно состояние «через агента»; человек правит после — состояние агента остаётся версией
    current = anna.get(f"/api/workspace/items/{note['id']}").json()["item"]
    anna.patch(f"/api/workspace/items/{note['id']}", json={"content": current["content"] + "\nот человека", "baseUpdatedAt": current["updatedAt"]})
    history = anna.get(f"/api/workspace/items/{note['id']}/versions").json()
    assert history["current"]["savedVia"] == "" and history["versions"][0]["savedVia"] == "агент «Claude»"
    # человек написал — агент правит: перед правкой граница «До правки агента», текущее состояние — «через агента»
    own = anna.post("/api/workspace/items", json={"kind": "note", "title": "Своя", "content": "написал человек"}).json()["item"]
    _ok(client, token, "edit_note", id=own["id"], old_text="человек", new_text="человек, поправил агент")
    _ok(client, token, "edit_note", id=own["id"], old_text="поправил", new_text="дважды поправил")
    history = anna.get(f"/api/workspace/items/{own['id']}/versions").json()
    assert history["current"]["savedVia"] == "агент «Claude»"
    boundaries = [v for v in history["versions"] if v["label"] == "До правки агента «Claude»"]
    assert len(boundaries) == 1 and boundaries[0]["savedVia"] == ""
    # откат правки агента — восстановлением версии «До правки агента»
    assert anna.post(f"/api/workspace/items/{own['id']}/versions/{boundaries[0]['id']}/restore").status_code == 200
    assert anna.get(f"/api/workspace/items/{own['id']}").json()["item"]["content"] == "написал человек"

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


def test_key_in_the_address_for_clients_without_headers(client, anna):
    """ChatGPT («Без аутентификации») несёт ключ в пути: /api/mcp/<ключ>. Управление ключами остаётся под сессией."""
    token, _ = _key(anna)
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    ok = client.post(f"/api/mcp/{token}", json=body)
    assert ok.status_code == 200 and ok.json()["result"]["tools"]
    assert client.post(f"/api/mcp/{token}x", json=body).status_code == 401           # чужой ключ
    assert client.post("/api/mcp/whatever", json=body).status_code in (401, 404)     # не ключ — дальше не пускаем
    assert client.get(f"/api/mcp/{token}").status_code == 405
    assert client.get("/api/mcp/keys").status_code == 401                            # без сессии список ключей закрыт


def test_agent_comments_on_a_document(client, anna):
    token, _ = _key(anna)
    doc = _ok(client, token, "create_document", title="Для комментариев", markdown="Первый абзац")
    thread = _ok(client, token, "add_comment", id=doc["id"], text="Проверить цифры", quote="Первый абзац")
    reply = _ok(client, token, "add_comment", id=doc["id"], text="Проверил", thread_id=thread["id"])
    assert reply["threadId"] == thread["id"]
    listed = _ok(client, token, "list_comments", id=doc["id"])["threads"]
    assert listed[0]["anchor"] == {"kind": "text", "quote": "Первый абзац"} and listed[0]["replies"][0]["text"] == "Проверил"
    _ok(client, token, "resolve_comment", id=doc["id"], thread_id=thread["id"])
    assert _ok(client, token, "list_comments", id=doc["id"])["threads"] == []
    assert len(_ok(client, token, "list_comments", id=doc["id"], include_resolved=True)["threads"]) == 1
    # человек видит то же самое в Шаре
    assert anna.get(f"/api/workspace/items/{doc['id']}/comments").json()["comments"][0]["authorName"]


def test_preview_insert_versions_ranges_and_links(client, anna):
    token, _ = _key(anna)
    note = _ok(client, token, "create_note", title="Предпросмотр", markdown="Было")
    preview = _ok(client, token, "edit_note", id=note["id"], old_text="Было", new_text="Стало", dry_run=True)
    assert preview["preview"] and preview["changed"] and "-Было" in preview["diff"] and "+Стало" in preview["diff"]
    assert _ok(client, token, "read_item", id=note["id"])["content"] == "Было"
    saved = _ok(client, token, "edit_note", id=note["id"], old_text="Было", new_text="Стало")
    assert saved["updatedAt"] and saved["updatedAt"] != preview["baseUpdatedAt"]
    versions = _ok(client, token, "item_versions", id=note["id"])
    assert versions["versions"] and versions["canRestore"]
    changed = _ok(client, token, "diff_item", id=note["id"], version_id=versions["versions"][0]["id"])
    assert changed["changed"] and "+Стало" in changed["diff"]
    restoring = _ok(client, token, "restore_item_version", id=note["id"], version_id=versions["versions"][0]["id"], dry_run=True)
    assert restoring["preview"] and "+Было" in restoring["diff"]
    restored = _ok(client, token, "restore_item_version", id=note["id"], version_id=versions["versions"][0]["id"], confirm=True)
    assert restored["restored"] and _ok(client, token, "read_item", id=note["id"])["content"] == "Было"
    missing = _call(client, token, "edit_note", id=note["id"], old_text="Нет", new_text="x")
    assert missing["error"]["code"] == "text_not_found"

    doc = _ok(client, token, "create_document", title="Вставка", markdown="# Первый\nТекст **жирный**\n## Конец")
    inserted = _ok(client, token, "update_document", id=doc["id"], mode="insert", after_text="Текст жирный", markdown="## Середина\nНовый абзац")
    assert inserted["mode"] == "insert" and inserted["updatedAt"]
    markdown = _ok(client, token, "read_item", id=doc["id"])["content"]
    assert markdown.index("Текст **жирный**") < markdown.index("## Середина") < markdown.index("## Конец")
    assert "Текст **жирный**" in markdown

    table = _ok(client, token, "create_table", title="Диапазоны", sheets=[
        {"name": "Первый", "rows": [["Название", "Число"], ["А", 2], ["Б", 3]]},
        {"name": "Второй", "rows": [["Колонка"]]},
    ])
    batch = _ok(client, token, "update_table", id=table["id"], operations=[
        {"sheet": "Первый", "cells": [{"ref": "B2", "value": "=A2*2"}]},
        {"sheet": "Второй", "append_rows": [["Добавлено"]]},
    ])
    assert len(batch["operations"]) == 2 and batch["operations"][0]["cellRefs"] == ["B2"]
    page = _ok(client, token, "read_item", id=table["id"], sheet="Первый", max_rows=2)["sheets"][0]
    assert page["hasMore"] and page["nextRange"] == "A3:B3" and page["rows"][1][1] == "=A2*2"
    cells = _ok(client, token, "read_item", id=table["id"], sheet="Второй", range="A1:A2")["sheets"][0]
    assert cells["rows"] == [["Колонка"], ["Добавлено"]] and not cells["hasMore"]

    internal = _ok(client, token, "resolve_item", url=f"/office?kind=note&id={note['id']}")
    assert internal["id"] == note["id"]
    public = anna.post(f"/api/workspace/items/{note['id']}/links", json={"mode": "view"}).json()["link"]["token"]
    assert _ok(client, token, "resolve_item", url=f"https://shar.example/d/{public}")["id"] == note["id"]
    rights = _ok(client, token, "capabilities", id=note["id"])
    assert rights["item"]["canEdit"] and rights["serverTime"]
    found = _ok(client, token, "tool_search", query="версии", include_schema=True)
    assert any(t["name"] == "item_versions" and "inputSchema" in t for t in found["tools"])
    assert any(t["name"] == "read_item" for t in _ok(client, token, "tool_search", query="read table cells range")["tools"])
    assert any(t["name"] == "diff_item" for t in _ok(client, token, "tool_search", query="diff версии документа")["tools"])
    for phrase in ("таблица", "чтение таблицы диапазон ячеек", "права доступа материал"):  # падежи не должны давать пустую выдачу
        assert _ok(client, token, "tool_search", query=phrase)["tools"], phrase
    with_hint = _call(client, token, "edit_note", id=note["id"], old_text="Бло", new_text="x")["error"]["message"]
    assert "Ближайшее похожее место: «Было»" in with_hint
    assert "openNow" in rights


def test_long_materials_read_by_outline_and_section(client, anna):
    """Длинное не обрезается на 15 тысячах знаков, а оглавление и section дают прочитать нужный раздел, не перечитывая всё."""
    for old in anna.get("/api/mcp/keys").json().get("keys", []):  # у человека не больше 10 ключей — соседние тесты могли оставить свои
        anna.delete(f"/api/mcp/keys/{old['id']}")
    token, key = _key(anna)
    try:
        body = "# Цель\n" + "цель " * 400 + "\n## Подцель\nвложенная\n# Задачи\n" + "задача " * 3000 + "\n# Итоги\nвсё готово"
        assert len(body) > 20_000
        note = _ok(client, token, "create_note", title="Большая", markdown=body)
        full = _ok(client, token, "read_item", id=note["id"])
        assert not full.get("truncated"), "20 тысяч знаков помещаются в страницу"
        assert [h["title"] for h in full["outline"]] == ["Цель", "Подцель", "Задачи", "Итоги"]
        part = _ok(client, token, "read_item", id=note["id"], section="итоги")
        assert part["content"].startswith("# Итоги") and "всё готово" in part["content"] and "задача" not in part["content"]
        goal = _ok(client, token, "read_item", id=note["id"], section="Цель")
        assert "вложенная" not in goal["content"] or "# Задачи" not in goal["content"], "раздел заканчивается на заголовке того же уровня"
        assert _call(client, token, "read_item", id=note["id"], section="Нет такого")["isError"]
        small = _ok(client, token, "read_item", id=note["id"], max_chars=1000)
        assert small["truncated"] and small["nextOffset"] == 1000 and small["outline"]
    finally:
        anna.delete(f"/api/mcp/keys/{key['id']}")


def test_document_sections_are_edited_by_heading_and_keep_the_rest(client, anna):
    """Структурная правка без точного текста: раздел заменяется, дополняется, удаляется; остальное и оформление не трогаются."""
    token, key = _key(anna)
    try:
        md = "# План\nвводная\n# Бюджет\nстарая **цифра** 100\n## Детали\nмелочи\n# Итоги\nпока пусто"
        doc = _ok(client, token, "create_document", title="Отчёт", markdown=md)

        def text():
            return _ok(client, token, "read_item", id=doc["id"])["content"]

        _ok(client, token, "update_document", id=doc["id"], mode="replace_section", heading="бюджет", markdown="Новая цифра 250\n\nи пояснение")
        out = text()
        assert "Новая цифра 250" in out and "и пояснение" in out
        assert "старая" not in out and "мелочи" not in out, "подраздел заменяется вместе с содержимым"
        assert "# Бюджет" in out and "вводная" in out and "пока пусто" in out

        _ok(client, token, "update_document", id=doc["id"], mode="insert_after_heading", heading="Итоги", markdown="Первым пунктом")
        _ok(client, token, "update_document", id=doc["id"], mode="append_to_section", heading="План", markdown="дописано в конец плана")
        _ok(client, token, "update_document", id=doc["id"], mode="insert_before_heading", heading="Итоги", markdown="# Риски\nнет")
        out = text()
        assert out.index("вводная") < out.index("дописано в конец плана") < out.index("# Бюджет")
        assert out.index("# Риски") < out.index("# Итоги") < out.index("Первым пунктом") < out.index("пока пусто")

        _ok(client, token, "update_document", id=doc["id"], mode="delete_section", heading="Риски")
        assert "Риски" not in text() and "нет" not in text().split("# Итоги")[0].split("# Бюджет")[1]
        # правка по тексту после структурных операций работает: индексы абзацев не поехали
        assert _ok(client, token, "edit_document", id=doc["id"], old_text="Новая цифра 250", new_text="Цифра 300")["replaced"] == 1
        assert "# Итоги" in text() and "Цифра 300" in text()

        missing = _call(client, token, "update_document", id=doc["id"], mode="replace_section", heading="Нет такого", markdown="x")
        assert missing["isError"] and "Заголовки:" in json.dumps(missing, ensure_ascii=False)
        preview = _ok(client, token, "update_document", id=doc["id"], mode="delete_section", heading="Итоги", dry_run=True)
        assert "Итоги" in json.dumps(preview, ensure_ascii=False) and "# Итоги" in text(), "dry_run ничего не пишет"
    finally:
        anna.delete(f"/api/mcp/keys/{key['id']}")


def test_document_tables_are_read_as_markdown_tables():
    stream = "Начало\r\x1a\x1b\x1cИмя\r\x1d\x1cЦена\r\x1d\x0e\x1b\x1cЧай\r\x1d\x1c90\r\x1d\x0e\x0fКонец\r\n"
    snapshot = docformat.empty_snapshot("Цены")
    body = snapshot["body"]
    starts = [i for i, ch in enumerate(stream) if ch == "\r"]
    body["dataStream"] = stream
    body["paragraphs"] = [{"startIndex": i} for i in starts]
    markdown = docformat.snapshot_to_markdown(snapshot)
    assert "| Имя | Цена |" in markdown and "| --- | --- |" in markdown and "| Чай | 90 |" in markdown
    assert markdown.startswith("Начало") and markdown.endswith("Конец")
    assert "\x1a" not in markdown and "\x1d" not in markdown


def test_search_says_where_it_found_and_batch_edits_many_materials(client, anna):
    token, key = _key(anna)
    try:
        body = "# Договоры\n" + "общие слова " * 60 + "\n# Оплата\nсрок оплаты по договору — 14 дней\n# Прочее\nконец"
        note = _ok(client, token, "create_note", title="Условия", markdown=body)
        other = _ok(client, token, "create_note", title="Вторая", markdown="один\nдва")
        found = _ok(client, token, "list_items", query="договору")
        row = next(i for i in found["items"] if i["id"] == note["id"])
        assert row["matches"] and any(m["section"] in ("Договоры", "Оплата") for m in row["matches"])
        spot = next(m for m in row["matches"] if m["section"] == "Оплата")
        assert "14 дней" in spot["text"]
        part = _ok(client, token, "read_item", id=note["id"], section=spot["section"])
        assert "14 дней" in part["content"] and "конец" not in part["content"]

        both = _ok(client, token, "batch", calls=[
            {"tool": "edit_note", "arguments": {"id": note["id"], "old_text": "14 дней", "new_text": "30 дней"}},
            {"tool": "edit_note", "arguments": {"id": other["id"], "old_text": "два", "new_text": "три"}},
        ])
        assert both["done"] == 2 and not both["stopped"]
        assert "30 дней" in _ok(client, token, "read_item", id=note["id"])["content"]
        assert "три" in _ok(client, token, "read_item", id=other["id"])["content"]

        stopped = _ok(client, token, "batch", calls=[
            {"tool": "edit_note", "arguments": {"id": note["id"], "old_text": "нет такого текста", "new_text": "x"}},
            {"tool": "edit_note", "arguments": {"id": other["id"], "old_text": "три", "new_text": "четыре"}},
        ])
        assert stopped["done"] == 0 and stopped["stopped"] and stopped["results"][0]["error"]["code"] == "text_not_found"
        assert "три" in _ok(client, token, "read_item", id=other["id"])["content"], "после ошибки следующие вызовы не выполняются"

        dry = _ok(client, token, "batch", dry_run=True, calls=[{"tool": "edit_note", "arguments": {"id": other["id"], "old_text": "три", "new_text": "пять"}}])
        assert dry["done"] == 1 and "три" in _ok(client, token, "read_item", id=other["id"])["content"]
        nested = _ok(client, token, "batch", calls=[{"tool": "batch", "arguments": {"calls": []}}])
        assert nested["results"][0]["ok"] is False
    finally:
        anna.delete(f"/api/mcp/keys/{key['id']}")
