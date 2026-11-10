"""«Файлы»: замена содержимого файла с историей версий — id и ссылка остаются, прежнее можно вернуть."""

from __future__ import annotations

import uuid

from app.core.db import db
from app.core.storage import new_upload_name


def _upload(name: str = "a.txt") -> dict:
    unique = new_upload_name(name)
    return {"url": f"/api/uploads/{unique}", "s3Key": f"uploads/{unique}", "size": 5, "mimeType": "text/plain"}


def _file(owner_id: str, folder_id: str | None = None) -> dict:
    up = _upload()
    return db.create_cloud_file({"id": str(uuid.uuid4()), "name": "отчёт.txt", "folder_id": folder_id, "owner_id": owner_id,
                                 "url": up["url"], "s3_key": up["s3Key"], "size": 3, "mime_type": "text/plain", "file_type": "file"})


def test_replace_keeps_id_and_keeps_history_and_restore_swaps(users):
    anna = users._clients["anna"]
    made = _file(users.ids["anna"])
    first_url = made["url"]

    new = _upload()
    r = anna.post(f"/api/cloud/files/{made['id']}/replace", json=new)
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["id"] == made["id"] and got["url"] == new["url"] and got["name"] == "отчёт.txt"

    hist = anna.get(f"/api/cloud/files/{made['id']}/versions").json()
    assert hist["canRestore"] is True and hist["current"]["url"] == new["url"]
    assert [v["url"] for v in hist["versions"]] == [first_url]

    # вторая замена: в истории две версии, самая свежая сверху
    third = _upload()
    assert anna.post(f"/api/cloud/files/{made['id']}/replace", json=third).status_code == 200
    hist = anna.get(f"/api/cloud/files/{made['id']}/versions").json()
    assert [v["url"] for v in hist["versions"]] == [new["url"], first_url]

    # откат на самую первую: она становится текущей, а текущая уходит в историю — ничего не пропало
    back = anna.post(f"/api/cloud/files/{made['id']}/restore", json={"versionId": hist["versions"][1]["id"]})
    assert back.status_code == 200, back.text
    assert back.json()["url"] == first_url and back.json()["id"] == made["id"]
    hist = anna.get(f"/api/cloud/files/{made['id']}/versions").json()
    assert hist["current"]["url"] == first_url
    assert {v["url"] for v in hist["versions"]} == {third["url"], new["url"]}


def test_replace_needs_edit_right_and_a_real_upload_key(users):
    anna, boris = users._clients["anna"], users._clients["boris"]
    folder = anna.post("/api/cloud/folders", json={"name": "Общая"}).json()
    made = _file(users.ids["anna"], folder["id"])

    # чужой, которому ничего не открыто, файла не видит
    assert boris.post(f"/api/cloud/files/{made['id']}/replace", json=_upload()).status_code == 404

    # только просмотр — менять нельзя, историю видно, откат недоступен
    anna.put(f"/api/cloud/folders/{folder['id']}/access", json={"sharedWith": [users.ids["boris"]], "editAccess": []})
    assert boris.post(f"/api/cloud/files/{made['id']}/replace", json=_upload()).status_code == 403
    assert boris.get(f"/api/cloud/files/{made['id']}/versions").json()["canRestore"] is False

    # право правки (на папку) — можно; чужой ключ хранилища — нельзя
    anna.put(f"/api/cloud/folders/{folder['id']}/access", json={"sharedWith": [users.ids["boris"]], "editAccess": [users.ids["boris"]]})
    bad = boris.post(f"/api/cloud/files/{made['id']}/replace", json={**_upload(), "s3Key": "uploads/../secret"})
    assert bad.status_code == 400
    ok = boris.post(f"/api/cloud/files/{made['id']}/replace", json=_upload())
    assert ok.status_code == 200 and ok.json()["id"] == made["id"]
    assert boris.get(f"/api/cloud/files/{made['id']}/versions").json()["versions"][0]["byName"]


def test_zip_download_of_files_and_folders_respects_access(users):
    import io
    import zipfile

    from app.core.storage import UPLOAD_DIR

    anna, boris = users._clients["anna"], users._clients["boris"]
    folder = anna.post("/api/cloud/folders", json={"name": "Отчёты"}).json()
    sub = anna.post("/api/cloud/folders", json={"name": "Вложенная", "parentId": folder["id"]}).json()

    def put(name: str, body: bytes, folder_id):
        unique = new_upload_name(name)
        (UPLOAD_DIR / "uploads").mkdir(parents=True, exist_ok=True)
        (UPLOAD_DIR / "uploads" / unique).write_bytes(body)
        return db.create_cloud_file({"id": str(uuid.uuid4()), "name": name, "folder_id": folder_id, "owner_id": users.ids["anna"],
                                     "url": f"/api/uploads/{unique}", "s3_key": f"uploads/{unique}", "size": len(body),
                                     "mime_type": "text/plain", "file_type": "file"})

    a = put("a.txt", b"AAA", folder["id"])
    b = put("a.txt", b"BBB", sub["id"])      # одноимённый файл глубже
    loose = put("корень.txt", b"ROOT", None)

    r = anna.get("/api/cloud/zip", params={"files": loose["id"], "folders": folder["id"]})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert set(zf.namelist()) == {"корень.txt", "Отчёты/a.txt", "Отчёты/Вложенная/a.txt"}
    assert zf.read("Отчёты/a.txt") == b"AAA" and zf.read("Отчёты/Вложенная/a.txt") == b"BBB"
    assert "filename*=UTF-8''" in r.headers["content-disposition"]

    # Борису ничего не открыто: молча пропускается, а если брать нечего — 404
    assert boris.get("/api/cloud/zip", params={"files": a["id"]}).status_code == 404
    # открыли папку — вложенное тоже в архиве
    anna.put(f"/api/cloud/folders/{folder['id']}/access", json={"sharedWith": [users.ids["boris"]], "editAccess": []})
    got = boris.get("/api/cloud/zip", params={"folders": folder["id"], "files": loose["id"]})
    assert got.status_code == 200 and set(zipfile.ZipFile(io.BytesIO(got.content)).namelist()) == {"Отчёты/a.txt", "Отчёты/Вложенная/a.txt"}
    assert anna.get("/api/cloud/zip").status_code == 400
