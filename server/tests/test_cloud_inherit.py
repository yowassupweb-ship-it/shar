"""«Файлы»: доступ к папке распространяется на все вложенные папки и файлы в них — и на созданные позже."""

from __future__ import annotations

import uuid

from app.core.db import db


def _file(owner_id: str, folder_id: str, name: str) -> dict:
    return db.create_cloud_file({"id": str(uuid.uuid4()), "name": name, "folder_id": folder_id, "owner_id": owner_id,
                                 "url": f"/api/uploads/{uuid.uuid4().hex}.txt", "s3_key": None, "size": 3, "mime_type": "text/plain", "file_type": "file"})


def test_folder_access_reaches_nested_folders_and_files(users):
    anna, boris, clara = users._clients["anna"], users._clients["boris"], users._clients["clara"]
    owner = users.ids["anna"]
    root = anna.post("/api/cloud/folders", json={"name": "Корень"}).json()
    child = anna.post("/api/cloud/folders", json={"name": "Вложенная", "parentId": root["id"]}).json()
    deep = anna.post("/api/cloud/folders", json={"name": "Ещё глубже", "parentId": child["id"]}).json()
    note = _file(owner, deep["id"], "глубокий-файл.txt")
    top = _file(owner, root["id"], "верхний-файл.txt")

    # до выдачи доступа ничего не видно
    assert not any(f["id"] == child["id"] for f in boris.get("/api/cloud/folders", params={"parentId": root["id"]}).json())
    assert boris.get(f"/api/cloud/folders/{child['id']}").status_code == 404

    assert anna.put(f"/api/cloud/folders/{root['id']}/access", json={"sharedWith": [users.ids["boris"]], "editAccess": []}).status_code == 200

    # подпапки на любую глубину
    assert [f["id"] for f in boris.get("/api/cloud/folders", params={"parentId": root["id"]}).json()] == [child["id"]]
    assert [f["id"] for f in boris.get("/api/cloud/folders", params={"parentId": child["id"]}).json()] == [deep["id"]]
    # файлы во вложенных папках
    assert [f["id"] for f in boris.get("/api/cloud/files", params={"folderId": deep["id"]}).json()] == [note["id"]]
    assert [f["id"] for f in boris.get("/api/cloud/files", params={"folderId": root["id"]}).json()] == [top["id"]]
    # переход по ссылке на вложенную папку и файл
    assert boris.get(f"/api/cloud/folders/{deep['id']}").status_code == 200
    assert boris.get(f"/api/cloud/files/{note['id']}").status_code == 200
    # поиск и списки «все файлы»
    assert note["id"] in {f["id"] for f in boris.get("/api/cloud/files", params={"allFiles": "true"}).json()}
    assert note["id"] in {f["id"] for f in boris.get("/api/search", params={"q": "глубокий"}).json().get("files", [])}

    # созданное позже наследует доступ само
    later = anna.post("/api/cloud/folders", json={"name": "Позже", "parentId": deep["id"]}).json()
    assert [f["id"] for f in boris.get("/api/cloud/folders", params={"parentId": deep["id"]}).json()] == [later["id"]]

    # посторонний по-прежнему ничего не видит
    assert clara.get("/api/cloud/folders", params={"parentId": root["id"]}).json() == []
    assert clara.get("/api/cloud/files", params={"folderId": deep["id"]}).json() == []
    assert clara.get(f"/api/cloud/files/{note['id']}").status_code == 404

    # доступ снят — вложенное снова закрыто
    anna.put(f"/api/cloud/folders/{root['id']}/access", json={"sharedWith": [], "editAccess": []})
    assert boris.get("/api/cloud/folders", params={"parentId": root["id"]}).json() == []
    assert boris.get("/api/cloud/files", params={"folderId": deep["id"]}).json() == []


def test_folder_kinds_and_image_dims(users, tmp_path, monkeypatch):
    """Верхний фильтр «Фото / Видео / Документы»: папка знает, что в ней (с вложенными); разрешение фото считается по заголовку."""
    import io

    from PIL import Image

    from app.core.storage import UPLOAD_DIR

    anna = users._clients["anna"]
    owner = users.ids["anna"]
    root = anna.post("/api/cloud/folders", json={"name": "Смешанная"}).json()
    sub = anna.post("/api/cloud/folders", json={"name": "Глубже", "parentId": root["id"]}).json()
    empty = anna.post("/api/cloud/folders", json={"name": "Пустая"}).json()
    _file(owner, sub["id"], "отчёт.pdf")
    key = f"{uuid.uuid4().hex}.png"
    (UPLOAD_DIR / 'uploads').mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    Image.new("RGB", (40, 30), (1, 2, 3)).save(buf, "PNG")
    (UPLOAD_DIR / 'uploads' / key).write_bytes(buf.getvalue())
    photo = db.create_cloud_file({"id": str(uuid.uuid4()), "name": "фото.png", "folder_id": sub["id"], "owner_id": owner, "url": f"/api/uploads/{key}",
                                  "s3_key": f"uploads/{key}", "size": len(buf.getvalue()), "mime_type": "image/png", "file_type": "image"})

    by_name = {f["name"]: f for f in anna.get("/api/cloud/folders").json()}
    assert by_name["Смешанная"]["kinds"] == {"image": 1, "doc": 1}, "вложенные папки считаются"
    assert by_name["Пустая"]["kinds"] == {} and empty["id"] == by_name["Пустая"]["id"]

    got = anna.post("/api/cloud/files/dims", json={"ids": [photo["id"]]}).json()["dims"]
    assert got == {photo["id"]: [40, 30]}
    # запомнилось у файла: второй раз файл уже не читается
    (UPLOAD_DIR / 'uploads' / key).unlink()
    assert anna.post("/api/cloud/files/dims", json={"ids": [photo["id"]]}).json()["dims"] == {photo["id"]: [40, 30]}
    # чужой файл размера не отдаёт
    assert users._clients["clara"].post("/api/cloud/files/dims", json={"ids": [photo["id"]]}).json()["dims"] == {}
