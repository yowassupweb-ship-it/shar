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
