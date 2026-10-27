"""Заметки, документы, таблицы, презентации: права, поимённый доступ, ссылки без входа."""

from __future__ import annotations

import json

DOC = json.dumps({"body": {"dataStream": "Привет\r\n", "paragraphs": [{"startIndex": 6}]}})
DECK = json.dumps({"version": 1, "slides": [{"id": "s1", "elements": [{"id": "e1", "type": "text", "html": "<b>Заголовок</b> слайда"}]}]})


def _create(c, kind="note", **extra):
    r = c.post("/api/workspace/items", json={"kind": kind, **extra})
    assert r.status_code == 201, r.text
    return r.json()["item"]


def test_create_validates_and_lists(anna):
    note = _create(anna, "note", title="План", content="# Привет\nтекст заметки", meta={"color": "red", "junk": 1})
    assert note["isOwner"] and note["canEdit"] and note["meta"] == {"color": "red"}
    doc = _create(anna, "document", title="Док", content=DOC)
    assert "Привет" in anna.get(f"/api/workspace/items?kind=document&q=Привет").text
    deck = _create(anna, "presentation", title="Слайды", content=DECK)
    assert anna.get("/api/workspace/items?kind=presentation&q=слайда").json()["items"][0]["id"] == deck["id"]
    assert anna.post("/api/workspace/items", json={"kind": "document", "content": "не json"}).status_code == 400
    assert anna.post("/api/workspace/items", json={"kind": "presentation", "content": "{}"}).status_code == 400
    ids = {i["id"] for i in anna.get("/api/workspace/items").json()["items"]}
    assert {note["id"], doc["id"], deck["id"]} <= ids
    # в списке содержимого нет, в карточке — есть
    assert "content" not in anna.get("/api/workspace/items").json()["items"][0]
    assert anna.get(f"/api/workspace/items/{doc['id']}").json()["item"]["content"] == DOC


def test_private_by_default_and_named_access(anna, boris, clara, users):
    item = _create(anna, "note", title="Секрет", content="пароль")
    assert boris.get(f"/api/workspace/items/{item['id']}").status_code == 404
    assert item["id"] not in {i["id"] for i in boris.get("/api/workspace/items").json()["items"]}
    # выдаём Борису чтение
    r = anna.put(f"/api/workspace/items/{item['id']}/shares", json={"userId": users.ids["boris"], "role": "view"})
    assert r.status_code == 200 and r.json()["shares"][0]["role"] == "view"
    got = boris.get(f"/api/workspace/items/{item['id']}").json()["item"]
    assert got["role"] == "view" and not got["canEdit"] and not got["isOwner"]
    assert boris.patch(f"/api/workspace/items/{item['id']}", json={"title": "x"}).status_code == 403
    # повышаем до правки
    anna.put(f"/api/workspace/items/{item['id']}/shares", json={"userId": users.ids["boris"], "role": "edit"})
    assert boris.patch(f"/api/workspace/items/{item['id']}", json={"content": "новый"}).status_code == 200
    # Борис не может ни раздавать доступ, ни удалять, ни закреплять
    assert boris.put(f"/api/workspace/items/{item['id']}/shares", json={"userId": users.ids["clara"], "role": "view"}).status_code == 403
    assert boris.patch(f"/api/workspace/items/{item['id']}", json={"accessLevel": "all"}).status_code == 403
    assert boris.delete(f"/api/workspace/items/{item['id']}").status_code == 403
    # Клара так и не видит
    assert clara.get(f"/api/workspace/items/{item['id']}").status_code == 404
    # отзыв
    anna.put(f"/api/workspace/items/{item['id']}/shares", json={"userId": users.ids["boris"], "role": None})
    assert boris.get(f"/api/workspace/items/{item['id']}").status_code == 404


def test_access_all_modes(anna, boris):
    item = _create(anna, "table", title="Общая", content="UEsDBA==")
    anna.patch(f"/api/workspace/items/{item['id']}", json={"accessLevel": "all", "accessMode": "view"})
    got = boris.get(f"/api/workspace/items/{item['id']}").json()["item"]
    assert got["role"] == "view" and not got["canEdit"]
    assert boris.patch(f"/api/workspace/items/{item['id']}", json={"content": "UEsDBB=="}).status_code == 403
    anna.patch(f"/api/workspace/items/{item['id']}", json={"accessMode": "edit"})
    assert boris.patch(f"/api/workspace/items/{item['id']}", json={"content": "UEsDBB=="}).status_code == 200


def test_conflict_detection(anna):
    item = _create(anna, "note", content="a")
    first = anna.patch(f"/api/workspace/items/{item['id']}", json={"content": "b", "baseUpdatedAt": item["updatedAt"]})
    assert first.status_code == 200
    stale = anna.patch(f"/api/workspace/items/{item['id']}", json={"content": "c", "baseUpdatedAt": item["updatedAt"]})
    assert stale.status_code == 409
    fresh = first.json()["item"]["updatedAt"]
    assert anna.patch(f"/api/workspace/items/{item['id']}", json={"content": "c", "baseUpdatedAt": fresh}).status_code == 200


def test_links_view_and_edit(anna, boris, client):
    item = _create(anna, "document", title="По ссылке", content=DOC)
    assert boris.post(f"/api/workspace/items/{item['id']}/links", json={"mode": "view"}).status_code == 404
    view = anna.post(f"/api/workspace/items/{item['id']}/links", json={"mode": "view"}).json()["link"]
    edit = anna.post(f"/api/workspace/items/{item['id']}/links", json={"mode": "edit"}).json()["link"]
    # повторный запрос без regenerate отдаёт ту же ссылку
    assert anna.post(f"/api/workspace/items/{item['id']}/links", json={"mode": "view"}).json()["link"]["token"] == view["token"]
    # аноним открывает без входа
    opened = client.get(f"/api/share/workspace/{view['token']}")
    assert opened.status_code == 200 and opened.json()["mode"] == "view" and opened.json()["item"]["content"] == DOC
    assert client.patch(f"/api/share/workspace/{view['token']}", json={"title": "хак"}).status_code == 403
    changed = client.patch(f"/api/share/workspace/{edit['token']}", json={"title": "Правка по ссылке"})
    assert changed.status_code == 200 and changed.json()["item"]["title"] == "Правка по ссылке"
    assert client.patch(f"/api/share/workspace/{edit['token']}", json={"content": "битый"}).status_code == 400
    # по ссылке не ходят в обычный API
    assert client.get(f"/api/workspace/items/{item['id']}").status_code == 401
    # перевыпуск: старая ссылка умирает
    new = anna.post(f"/api/workspace/items/{item['id']}/links", json={"mode": "view", "regenerate": True}).json()["link"]
    assert new["token"] != view["token"]
    assert client.get(f"/api/share/workspace/{view['token']}").status_code == 404
    assert client.get(f"/api/share/workspace/{new['token']}").status_code == 200
    # отзыв
    anna.delete(f"/api/workspace/items/{item['id']}/links/edit")
    assert client.get(f"/api/share/workspace/{edit['token']}").status_code == 404
    assert client.get("/api/share/workspace/слишком-короткий").status_code == 404


def test_template_and_delete(anna, boris):
    deck = _create(anna, "presentation", title="Шаблон", content=DECK)
    anna.patch(f"/api/workspace/items/{deck['id']}", json={"isTemplate": True, "accessLevel": "all"})
    templates = boris.get("/api/workspace/items?kind=presentation&templates=1").json()["items"]
    assert [t["id"] for t in templates] == [deck["id"]]
    copy = _create(boris, "presentation", templateId=deck["id"])
    assert copy["title"] == "Шаблон" and copy["content"] == DECK and copy["isOwner"]
    assert boris.delete(f"/api/workspace/items/{deck['id']}").status_code == 403
    assert anna.delete(f"/api/workspace/items/{deck['id']}").status_code == 200
    assert anna.get(f"/api/workspace/items/{deck['id']}").status_code == 404


class FakeS3:
    """Хранилище в памяти: проверяем, что содержимое уходит в S3 и там не копится мусор."""

    enabled = True

    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def put_private(self, key, data, content_type="application/octet-stream"):
        self.objects[key] = data
        return len(data)

    def get_object(self, key):
        import io

        return {"Body": io.BytesIO(self.objects[key])} if key in self.objects else None

    def delete_object(self, key):
        return self.objects.pop(key, None) is not None

    def delete_prefix(self, prefix):
        gone = [k for k in self.objects if k.startswith(prefix)]
        for k in gone:
            del self.objects[k]
        return len(gone)


def test_content_lives_in_s3(anna, monkeypatch):
    from app.core.db import db
    from app.modules.workspace import store

    fake = FakeS3()
    monkeypatch.setattr(store, "s3_storage", fake)
    item = _create(anna, "note", title="В облаке", content="первая версия")
    assert item["content"] == "первая версия"
    row = db.conn.fetch_one("SELECT content, content_key, content_size FROM workspace_items WHERE id = %s", (int(item["id"]),))
    assert row["content"] == "" and row["content_key"].startswith(f"workspace/{item['id']}/") and row["content_size"] > 0
    assert len(fake.objects) == 1
    # правка кладёт новый объект, а прежний остаётся в истории версий (тот же объект, без копирования)
    saved = anna.patch(f"/api/workspace/items/{item['id']}", json={"content": "вторая", "baseUpdatedAt": item["updatedAt"]}).json()["item"]
    assert len(fake.objects) == 2 and anna.get(f"/api/workspace/items/{item['id']}").json()["item"]["content"] == "вторая"
    # конфликт: новый объект откатывается, прежняя версия цела
    stale = anna.patch(f"/api/workspace/items/{item['id']}", json={"content": "чужая", "baseUpdatedAt": item["updatedAt"]})
    assert stale.status_code == 409
    assert len(fake.objects) == 2 and anna.get(f"/api/workspace/items/{item['id']}").json()["item"]["content"] == "вторая"
    assert saved["sizeBytes"] > 0
    # версия читается из хранилища и возвращается; ручная версия — отдельная копия объекта
    versions = anna.get(f"/api/workspace/items/{item['id']}/versions").json()["versions"]
    assert anna.get(f"/api/workspace/items/{item['id']}/versions/{versions[0]['id']}").json()["version"]["content"] == "первая версия"
    anna.post(f"/api/workspace/items/{item['id']}/versions", json={"label": "точка"})
    assert len(fake.objects) == 3
    assert anna.post(f"/api/workspace/items/{item['id']}/versions/{versions[0]['id']}/restore").json()["item"]["content"] == "первая версия"
    assert anna.get(f"/api/workspace/items/{item['id']}").json()["item"]["content"] == "первая версия"
    anna.patch(f"/api/workspace/items/{item['id']}", json={"content": "вторая"})
    # поиск по тексту работает и с S3
    assert anna.get("/api/workspace/items?kind=note&q=вторая").json()["items"][0]["id"] == item["id"]
    # удаление чистит хранилище
    assert anna.delete(f"/api/workspace/items/{item['id']}").status_code == 200
    assert fake.objects == {}


def test_s3_failure_does_not_leave_item(anna, monkeypatch):
    from app.modules.workspace import store

    class Broken(FakeS3):
        def put_private(self, *a, **k):
            raise RuntimeError("нет сети")

    monkeypatch.setattr(store, "s3_storage", Broken())
    before = len(anna.get("/api/workspace/items?kind=note").json()["items"])
    assert anna.post("/api/workspace/items", json={"kind": "note", "content": "x"}).status_code == 502
    assert len(anna.get("/api/workspace/items?kind=note").json()["items"]) == before


def test_cloud_change_is_pushed_to_people_with_access(users, anna, boris):
    """Файл в общей папке добавили или удалили — у того, кому её открыли, приходит событие: страницу обновлять не нужно."""
    import json

    folder = anna.post("/api/cloud/folders", json={"name": "Общая"}).json()["id"]
    r = anna.put(f"/api/cloud/folders/{folder}/access", json={"sharedWith": [users.ids["boris"]], "editAccess": []})
    assert r.status_code == 200, r.text

    def drain(ws, want=1):
        seen = []
        for _ in range(12):
            ev = json.loads(ws.receive_text())
            seen.append(ev["type"])
            if ev["type"] == "cloud_changed":
                return ev, seen
        return None, seen

    with boris.websocket_connect(f"/api/ws/{users.ids['boris']}") as ws_b:
        ws_b.receive_text()
        added = anna.post("/api/cloud/files", json={"name": "отчёт.pdf", "url": "/api/uploads/x", "folderId": folder})
        assert added.status_code == 200, added.text
        event, _ = drain(ws_b)
        assert event and event["folderId"] == folder
        anna.delete(f"/api/cloud/files/{added.json()['id']}")
        event, _ = drain(ws_b)
        assert event and event["folderId"] == folder


def test_department_access_and_instant_delivery(users, admin, anna, boris, clara):
    """Материал, выданный отделу, сразу попадает в «Офис» всем его сотрудникам (и подразделов), без обновления страницы."""
    import uuid

    from app.core.db import db

    tag = uuid.uuid4().hex[:6]
    parent = admin.post("/api/departments", json={"name": f"Parent {tag}"}).json()["id"]
    child = admin.post("/api/departments", json={"name": f"Child {tag}", "parentId": parent}).json()["id"]
    db.update_user(users.ids["boris"], {"departmentIds": [parent]})
    db.update_user(users.ids["clara"], {"departmentIds": [child]})
    item = _create(anna, "document", title="Регламент", content=DOC)
    url = f"/api/workspace/items/{item['id']}"
    assert boris.get(url).status_code == 404

    def event_for(client, uid):
        with client.websocket_connect(f"/api/ws/{uid}") as ws:
            ws.receive_text()
            r = anna.put(f"{url}/shares", json={"departmentId": parent, "role": "view"})
            assert r.status_code == 200, r.text
            for _ in range(12):
                ev = json.loads(ws.receive_text())
                if ev["type"] == "workspace_changed":
                    return ev, r.json()
        return None, r.json()

    ev, body = event_for(boris, users.ids["boris"])
    assert ev and ev["reason"] == "shared" and ev["itemId"] == item["id"] and ev["kind"] == "document" and ev["title"] == "Регламент"
    assert body["departments"] == [{"departmentId": parent, "role": "view", "name": f"Parent {tag}", "members": 2}]
    assert item["id"] in {i["id"] for i in boris.get("/api/workspace/items").json()["items"]}
    got = boris.get(url).json()["item"]
    assert got["role"] == "view" and not got["canEdit"]
    # подраздел входит в отдел
    assert clara.get(url).status_code == 200
    # поимённая правка сильнее чтения отдела
    anna.put(f"{url}/shares", json={"userId": users.ids["boris"], "role": "edit"})
    assert boris.get(url).json()["item"]["canEdit"]
    anna.put(f"{url}/shares", json={"userId": users.ids["boris"], "role": None})
    assert not boris.get(url).json()["item"]["canEdit"]
    # отдел с правкой
    anna.put(f"{url}/shares", json={"departmentId": parent, "role": "edit"})
    assert boris.patch(url, json={"content": DOC}).status_code == 200
    # отдел не трогает чужих
    # убрали отдел — доступ пропал
    anna.put(f"{url}/shares", json={"departmentId": parent, "role": None})
    assert boris.get(url).status_code == 404 and clara.get(url).status_code == 404
    # ошибки ввода
    assert anna.put(f"{url}/shares", json={"role": "view"}).status_code == 400
    assert anna.put(f"{url}/shares", json={"departmentId": "нет-такого", "role": "view"}).status_code == 404
    assert boris.put(f"{url}/shares", json={"departmentId": parent, "role": "view"}).status_code == 404


def test_version_history_and_restore(anna, boris, users):
    """Правки складываются в историю: смена автора — новая версия, версию можно открыть и вернуть."""
    item = _create(anna, "note", title="Версии", content="первая редакция")
    url = f"/api/workspace/items/{item['id']}"
    assert anna.get(f"{url}/versions").json()["versions"] == []
    # правка самого владельца сразу после создания: прежнее состояние попадает в историю (первой версии ещё не было)
    anna.patch(url, json={"content": "вторая редакция"})
    versions = anna.get(f"{url}/versions").json()["versions"]
    assert len(versions) == 1 and versions[0]["savedByName"]
    # ещё одна правка того же автора через секунду — новой версии нет (слишком рано)
    anna.patch(url, json={"content": "вторая редакция, дописано"})
    assert len(anna.get(f"{url}/versions").json()["versions"]) == 1
    # другой человек правит — состояние Анны становится версией
    anna.put(f"{url}/shares", json={"userId": users.ids["boris"], "role": "edit"})
    assert boris.patch(url, json={"content": "правка Бориса"}).status_code == 200
    versions = boris.get(f"{url}/versions").json()["versions"]
    assert len(versions) == 2
    assert boris.get(f"{url}/versions").json()["current"]["savedByName"] == "Boris"
    newest = boris.get(f"{url}/versions/{versions[0]['id']}").json()["version"]
    assert newest["content"] == "вторая редакция, дописано" and newest["savedByName"] == "Anna"
    first = boris.get(f"{url}/versions/{versions[1]['id']}").json()["version"]
    assert first["content"] == "первая редакция"
    # ручная версия с подписью
    saved = anna.post(f"{url}/versions", json={"label": "Перед согласованием"})
    assert saved.status_code == 200 and saved.json()["versions"][0]["label"] == "Перед согласованием"
    # восстановление: возвращает текст и оставляет текущее состояние в истории
    before = len(anna.get(f"{url}/versions").json()["versions"])
    restored = anna.post(f"{url}/versions/{first['id']}/restore")
    assert restored.status_code == 200 and restored.json()["item"]["content"] == "первая редакция"
    after = anna.get(f"{url}/versions").json()
    assert len(after["versions"]) == before + 1 and after["versions"][0]["label"] == "Перед восстановлением"
    # читатель смотрит историю, но не восстанавливает и не сохраняет
    anna.put(f"{url}/shares", json={"userId": users.ids["boris"], "role": "view"})
    assert boris.get(f"{url}/versions").json()["canRestore"] is False
    assert boris.post(f"{url}/versions/{first['id']}/restore").status_code == 403
    assert boris.post(f"{url}/versions", json={}).status_code == 403
    # чужая версия из другого материала не открывается
    other = _create(anna, "note", content="другой")
    assert anna.get(f"/api/workspace/items/{other['id']}/versions/{first['id']}").status_code == 404


def test_presence_and_live_content_events(anna, boris, users):
    """Кто сейчас в материале и живая рассылка правки тем, кто его смотрит."""
    import json

    item = _create(anna, "note", title="Вместе", content="a")
    url = f"/api/workspace/items/{item['id']}"
    anna.put(f"{url}/shares", json={"userId": users.ids["boris"], "role": "edit"})

    def wait_for(ws, kind, limit=14):
        for _ in range(limit):
            ev = json.loads(ws.receive_text())
            if ev["type"] == kind:
                return ev
        return None

    with boris.websocket_connect(f"/api/ws/{users.ids['boris']}") as ws_b:
        ws_b.receive_text()
        assert [v["userId"] for v in boris.post(f"{url}/presence", json={"state": "join", "editing": True}).json()["viewers"]] == [users.ids["boris"]]
        joined = anna.post(f"{url}/presence", json={"state": "join", "editing": False})
        assert {v["userId"] for v in joined.json()["viewers"]} == {users.ids["anna"], users.ids["boris"]}
        ev = wait_for(ws_b, "workspace_presence")
        assert ev and ev["itemId"] == item["id"] and {v["userId"] for v in ev["viewers"]} == {users.ids["anna"], users.ids["boris"]}
        # правка Анны доходит до Бориса сразу
        saved = anna.patch(url, json={"content": "b"}).json()["item"]
        live = wait_for(ws_b, "workspace_changed")
        assert live and live["reason"] == "content" and live["updatedAt"] == saved["updatedAt"] and live["byId"] == users.ids["anna"]
        # Анна ушла — Борис видит, что остался один
        anna.post(f"{url}/presence", json={"state": "leave"})
        ev = wait_for(ws_b, "workspace_presence")
        assert ev and [v["userId"] for v in ev["viewers"]] == [users.ids["boris"]]
    boris.post(f"{url}/presence", json={"state": "leave"})
    # читатель не отмечается как «правит»
    anna.put(f"{url}/shares", json={"userId": users.ids["boris"], "role": "view"})
    only_view = boris.post(f"{url}/presence", json={"state": "beat", "editing": True}).json()["viewers"]
    assert only_view[0]["editing"] is False
    boris.post(f"{url}/presence", json={"state": "leave"})


def test_cursor_relay_over_socket(anna, boris, clara, users):
    """Курсор коллеги: кадр cursor из сокета доходит до тех, кто в материале; посторонний не может слать."""
    import json

    item = _create(anna, "note", title="Курсоры", content="текст")
    url = f"/api/workspace/items/{item['id']}"
    anna.put(f"{url}/shares", json={"userId": users.ids["boris"], "role": "edit"})

    def wait_for(ws, kind, limit=14):
        for _ in range(limit):
            ev = json.loads(ws.receive_text())
            if ev["type"] == kind:
                return ev
        return None

    with boris.websocket_connect(f"/api/ws/{users.ids['boris']}") as ws_b, anna.websocket_connect(f"/api/ws/{users.ids['anna']}") as ws_a, \
            clara.websocket_connect(f"/api/ws/{users.ids['clara']}") as ws_c:
        assert "cursor" in json.loads(ws_a.receive_text())["features"]
        ws_b.receive_text()
        ws_c.receive_text()
        boris.post(f"{url}/presence", json={"state": "join", "editing": False})
        anna.post(f"{url}/presence", json={"state": "join", "editing": False})
        # Клара в материал не входила (и доступа нет) — её кадр отбрасывается, до Бориса доходит только Аннин.
        ws_c.send_text(json.dumps({"type": "cursor", "itemId": item["id"], "cursor": {"s": 99, "e": 99}}))
        ws_a.send_text(json.dumps({"type": "cursor", "itemId": item["id"], "cursor": {"s": 3, "e": 7, "b": 0}}))
        ev = wait_for(ws_b, "workspace_cursor")
        assert ev and ev["userId"] == users.ids["anna"] and ev["cursor"] == {"s": 3, "e": 7, "b": 0}
        # Слишком большой кадр не пересылается, null — «курсор убран».
        ws_a.send_text(json.dumps({"type": "cursor", "itemId": item["id"], "cursor": {"x": "y" * 2000}}))
        ws_a.send_text(json.dumps({"type": "cursor", "itemId": item["id"], "cursor": None}))
        ev = wait_for(ws_b, "workspace_cursor")
        assert ev and ev["cursor"] is None
    anna.post(f"{url}/presence", json={"state": "leave"})
    boris.post(f"{url}/presence", json={"state": "leave"})


def test_new_badge_for_shared_items(anna, boris, users):
    """Мне открыли доступ — материал «Новое» и первым в списке, пока я его не открою; свой — никогда не новый."""
    def listed(c):
        return c.get("/api/workspace/items").json()["items"]

    boris.get("/api/workspace/items")  # отсчёт «нового» начинается с первого обращения
    mine = _create(anna, "note", title="Своё", content="x")
    assert next(i for i in listed(anna) if i["id"] == mine["id"])["isNew"] is False
    shared = _create(anna, "note", title="Для Бориса", content="y")
    url = f"/api/workspace/items/{shared['id']}"
    anna.put(f"{url}/shares", json={"userId": users.ids["boris"], "role": "view"})
    items = listed(boris)
    assert items[0]["id"] == shared["id"] and items[0]["isNew"] is True
    boris.get(url)  # открыл — больше не новое
    assert next(i for i in listed(boris) if i["id"] == shared["id"])["isNew"] is False
    # Открыли всем — новое для всех, кроме владельца.
    everyone = _create(anna, "note", title="Всем", content="z")
    anna.patch(f"/api/workspace/items/{everyone['id']}", json={"accessLevel": "all"})
    assert next(i for i in listed(boris) if i["id"] == everyone["id"])["isNew"] is True
    assert next(i for i in listed(anna) if i["id"] == everyone["id"])["isNew"] is False



def test_personal_folders(anna, boris, users):
    """Папки личные: свои и чужие материалы раскладываются по своим папкам, чужие папки недоступны."""
    folder = anna.post("/api/workspace/folders", json={"title": "Проекты"}).json()["folder"]
    note = _create(anna, "note", title="В папке", content="x")
    assert anna.put(f"/api/workspace/items/{note['id']}/folder", json={"folderId": folder["id"]}).status_code == 200
    row = next(i for i in anna.get("/api/workspace/items").json()["items"] if i["id"] == note["id"])
    assert row["folderId"] == folder["id"]
    # Борис не может положить в чужую папку и не видит раскладку Анны.
    anna.put(f"/api/workspace/items/{note['id']}/shares", json={"userId": users.ids["boris"], "role": "view"})
    assert boris.put(f"/api/workspace/items/{note['id']}/folder", json={"folderId": folder["id"]}).status_code == 404
    assert next(i for i in boris.get("/api/workspace/items").json()["items"] if i["id"] == note["id"])["folderId"] is None
    assert boris.patch(f"/api/workspace/folders/{folder['id']}", json={"title": "Моё"}).status_code == 404
    # Переименование и удаление: материал остаётся, просто без папки.
    titles = [f["title"] for f in anna.patch(f"/api/workspace/folders/{folder['id']}", json={"title": "Архив"}).json()["folders"]]
    assert "Архив" in titles
    assert anna.delete(f"/api/workspace/folders/{folder['id']}").status_code == 200
    row = next(i for i in anna.get("/api/workspace/items").json()["items"] if i["id"] == note["id"])
    assert row["folderId"] is None


def test_root_order_is_personal_and_takes_items_out_of_folders(anna, boris):
    a, b, c = (_create(anna, "note", title=t) for t in ("А", "Б", "В"))
    folder = anna.post("/api/workspace/folders", json={"title": "Временная"}).json()["folder"]
    assert anna.put(f"/api/workspace/items/{c['id']}/folder", json={"folderId": folder["id"]}).status_code == 200
    # ручной порядок вне папок: В выходит из папки и встаёт первой
    assert anna.put("/api/workspace/root/order", json={"ids": [c["id"], a["id"], b["id"]]}).status_code == 200
    rows = {i["id"]: i for i in anna.get("/api/workspace/items?kind=note").json()["items"]}
    assert [rows[x["id"]]["rootPosition"] for x in (c, a, b)] == [0, 1, 2]
    assert rows[c["id"]]["folderId"] is None
    # чужое переставить нельзя, а свой порядок у каждого свой
    assert boris.put("/api/workspace/root/order", json={"ids": [a["id"]]}).status_code == 404
