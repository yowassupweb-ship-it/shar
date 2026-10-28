"""Комментарии к документам и таблицам: ветки и ответы, «решено», права, привязка."""

from __future__ import annotations

import json

DOC = json.dumps({"body": {"dataStream": "Привет\r\n", "paragraphs": [{"startIndex": 6}]}})


def _doc(c):
    r = c.post("/api/workspace/items", json={"kind": "document", "title": "Док", "content": DOC})
    assert r.status_code == 201, r.text
    return r.json()["item"]


def test_thread_reply_resolve_delete(anna):
    item = _doc(anna)
    url = f"/api/workspace/items/{item['id']}/comments"
    assert anna.get(url).json() == {"comments": [], "ready": True}
    root = anna.post(url, json={"body": "  Уточнить дату  ", "anchor": {"kind": "text", "quote": "Привет"}}).json()["comment"]
    assert root["body"] == "Уточнить дату" and root["anchor"] == {"kind": "text", "quote": "Привет"} and root["parentId"] is None
    reply = anna.post(url, json={"body": "Сделано", "parentId": root["id"], "anchor": {"kind": "text", "quote": "игнор"}}).json()["comment"]
    assert reply["parentId"] == root["id"] and reply["anchor"] == {}
    # ответ на ответ — нельзя; закрывается только ветка
    assert anna.post(url, json={"body": "x", "parentId": reply["id"]}).status_code == 400
    assert anna.patch(f"{url}/{reply['id']}", json={"resolved": True}).status_code == 400
    done = anna.patch(f"{url}/{root['id']}", json={"resolved": True}).json()["comment"]
    assert done["resolved"] is True and done["resolvedByName"]
    assert anna.patch(f"{url}/{root['id']}", json={"resolved": False}).json()["comment"]["resolved"] is False
    assert [c["id"] for c in anna.get(url).json()["comments"]] == [root["id"], reply["id"]]
    assert anna.delete(f"{url}/{root['id']}").status_code == 200
    assert anna.get(url).json()["comments"] == []  # ответы уходят вместе с веткой


def test_cell_anchor_and_validation(anna):
    item = anna.post("/api/workspace/items", json={"kind": "table", "title": "Т"}).json()["item"]
    url = f"/api/workspace/items/{item['id']}/comments"
    c = anna.post(url, json={"body": "Проверить", "anchor": {"kind": "cell", "sheet": "Лист1", "cell": "b3"}}).json()["comment"]
    assert c["anchor"] == {"kind": "cell", "sheet": "Лист1", "cell": "B3"}
    assert anna.post(url, json={"body": "   "}).status_code == 400
    assert anna.post(url, json={"body": "я" * 9000}).status_code == 422


def test_permissions(anna, boris, clara, users):
    item = _doc(anna)
    url = f"/api/workspace/items/{item['id']}/comments"
    # чужой закрытый материал даже не существует
    assert boris.get(url).status_code == 404 and boris.post(url, json={"body": "привет"}).status_code == 404
    anna.put(f"/api/workspace/items/{item['id']}/shares", json={"userId": users.ids["boris"], "role": "view"})
    # «только просмотр» всё равно комментирует — как комментатор в Google Docs
    mine = boris.post(url, json={"body": "Вопрос по абзацу"}).json()["comment"]
    assert mine["authorId"] == users.ids["boris"]
    anna_c = anna.post(url, json={"body": "Ответ владельца", "parentId": mine["id"]}).json()["comment"]
    # править чужой текст нельзя, закрыть ветку — можно любому
    assert anna.patch(f"{url}/{mine['id']}", json={"body": "подмена"}).status_code == 403
    assert boris.patch(f"{url}/{anna_c['id']}", json={"body": "подмена"}).status_code == 403
    assert boris.patch(f"{url}/{mine['id']}", json={"resolved": True}).status_code == 200
    # удалить чужое — только владелец материала
    assert boris.delete(f"{url}/{anna_c['id']}").status_code == 403
    assert anna.delete(f"{url}/{mine['id']}").status_code == 200
    assert clara.get(url).status_code == 404
