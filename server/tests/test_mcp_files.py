"""Правка файлов «Файлов» агентами: форматы, права редакторов, откат версий."""

import io
import zipfile

from app.core.db import db
from app.modules.core_agents import dispatch
from app.modules.mcp import fileformats

from tests.test_core_agents import _rpc


def _docx(*paragraphs: list[str]) -> bytes:
    """Минимальный docx: каждый абзац — список кусков текста (разные run'ы, как после ручного форматирования)."""
    body = "".join("<w:p>" + "".join(f'<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{part}</w:t></w:r>' for part in runs) + "</w:p>"
                   for runs in paragraphs)
    xml = f'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr/></w:body></w:document>'
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("word/document.xml", xml)
        z.writestr("word/media/logo.png", b"\x89PNG-not-touched")
    return out.getvalue()


def _put(client, token, name, data: bytes, folder_id=None):
    import base64

    args = {"name": name, "base64": base64.b64encode(data).decode()}
    if folder_id:
        args["folder_id"] = folder_id
    return _rpc(client, token, "file_write", **args)["structuredContent"]["created"]


def _keys(client, users, who):
    token, key_id = dispatch._mcp_key(users.ids[who], "claude", "")
    return token, key_id


def test_text_keeps_encoding_newlines_and_edits_by_lines(client, users):
    token, key_id = _keys(client, users, "anna")
    try:
        made = _put(client, token, "прайс.txt", "Цена: 100\r\nТур — «Карелия»\r\nКонец".encode("cp1251"))
        read = _rpc(client, token, "file_read", id=made["id"])["structuredContent"]
        assert read["encoding"] == "cp1251" and read["newline"] == "CRLF" and read["editable"] and "\r" not in read["text"]
        done = _rpc(client, token, "file_edit", id=made["id"], base_updated_at=read["updatedAt"],
                    old_text='Тур - "Карелия"', new_text="Тур — «Алтай»")["structuredContent"]  # типографские двойники находятся
        assert done["replaced"] == 1 and done["canUndo"]
        numbered = _rpc(client, token, "file_read", id=made["id"], from_line=1, to_line=2)["structuredContent"]
        assert numbered["text"].startswith("1\tЦена: 100\n2\tТур — «Алтай»") and numbered["totalLines"] == 3
        lines = _rpc(client, token, "file_edit", id=made["id"], base_updated_at=done["updated"]["updatedAt"],
                     mode="lines", start_line=1, end_line=1, text="Цена: 120")["structuredContent"]
        # кодировка и CRLF остались прежними
        from app.modules.mcp import files

        row = db.get_cloud_file_by_id(made["id"])
        assert files._bytes(row) == "Цена: 120\r\nТур — «Алтай»\r\nКонец".encode("cp1251")
        missing = _rpc(client, token, "file_edit", id=made["id"], base_updated_at=lines["updated"]["updatedAt"], old_text="Цена:120", new_text="x")
        assert missing["isError"] and missing["error"]["code"] == "text_not_found" and "Ближайшее" in missing["error"]["message"]
    finally:
        db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (key_id,))


def test_docx_replace_across_runs_keeps_formatting_and_append(client, users):
    token, key_id = _keys(client, users, "anna")
    try:
        data = _docx(["Договор № ", "12", " от 1 января"], ["Сумма: 100 &amp; НДС"])
        made = _put(client, token, "договор.docx", data)
        read = _rpc(client, token, "file_read", id=made["id"])["structuredContent"]
        assert "Договор № 12 от 1 января" in read["text"] and "Сумма: 100 & НДС" in read["text"] and read["editable"]
        edited = _rpc(client, token, "file_edit", id=made["id"], base_updated_at=read["updatedAt"],
                      replacements=[{"old_text": "№ 12 от", "new_text": "№ 13 от"}, {"old_text": "100 & НДС", "new_text": "200 & НДС"}])["structuredContent"]
        assert edited["replaced"] == 2
        appended = _rpc(client, token, "file_edit", id=made["id"], base_updated_at=edited["updated"]["updatedAt"], mode="append", text="Подпись\nДата")["structuredContent"]
        from app.modules.mcp import files

        raw = files._bytes(db.get_cloud_file_by_id(made["id"]))
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            xml = z.read("word/document.xml").decode()
            assert z.read("word/media/logo.png") == b"\x89PNG-not-touched"
        assert xml.count("<w:b/>") == 4 and "Договор № 13 от 1 января" not in xml  # текст разбит по run'ам, жирность на месте
        assert fileformats.office_text(raw, ".docx").split("\n") == ["Договор № 13 от 1 января", "Сумма: 200 & НДС", "Подпись", "Дата"]
        assert appended["appended"] and xml.index("Подпись") > xml.index("200")
        newline = _rpc(client, token, "file_edit", id=made["id"], base_updated_at=appended["updated"]["updatedAt"], old_text="а\nб", new_text="в")
        assert newline["isError"]
    finally:
        db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (key_id,))


def test_xlsx_cells_and_pptx_text(client, users):
    import openpyxl

    token, key_id = _keys(client, users, "anna")
    try:
        book = openpyxl.Workbook()
        book.active.title = "Цены"
        book.active.append(["Тур", "Цена"])
        book.active.append(["Карелия", 100])
        buf = io.BytesIO()
        book.save(buf)
        made = _put(client, token, "цены.xlsx", buf.getvalue())
        read = _rpc(client, token, "file_read", id=made["id"])["structuredContent"]
        assert "Карелия\t100" in read["text"] and "mode=cells" in read["editWith"]
        edited = _rpc(client, token, "file_edit", id=made["id"], base_updated_at=read["updatedAt"], cells=[{"sheet": "Цены", "ref": "B2", "value": 150}],
                      append_rows=[{"sheet": "Цены", "rows": [["Алтай", 200]]}])["structuredContent"]
        assert edited["changed"] == 2
        assert "Карелия\t150" in _rpc(client, token, "file_read", id=made["id"])["structuredContent"]["text"]
        bad_sheet = _rpc(client, token, "file_edit", id=made["id"], base_updated_at=edited["updated"]["updatedAt"], cells=[{"sheet": "Нет", "ref": "A1", "value": 1}])
        assert bad_sheet["isError"] and "Цены" in bad_sheet["error"]["message"]

        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as z:
            z.writestr("ppt/slides/slide1.xml", '<p:sld xmlns:a="a"><a:p><a:r><a:t>Привет, </a:t></a:r><a:r><a:t>Карелия</a:t></a:r></a:p></p:sld>')
        slide = _put(client, token, "слайды.pptx", out.getvalue())
        slide_read = _rpc(client, token, "file_read", id=slide["id"])["structuredContent"]
        assert "Привет, Карелия" in slide_read["text"]
        done = _rpc(client, token, "file_edit", id=slide["id"], base_updated_at=slide_read["updatedAt"], old_text="Привет, Каре", new_text="Здравствуй, Каре")["structuredContent"]
        assert done["replaced"] == 1
    finally:
        db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (key_id,))


def test_shared_folder_files_are_readable_and_editable_only_with_edit_access(client, users, anna):
    owner, owner_key = _keys(client, users, "anna")
    editor, editor_key = _keys(client, users, "boris")
    try:
        folder = anna.post("/api/cloud/folders", json={"name": "Общая"}).json()
        made = _put(client, owner, "заметка.txt", b"one", folder["id"])
        # файл лежит в общей папке, но сам ни с кем не расшарен: раньше file_read отвечал «не найден»
        anna.put(f"/api/cloud/folders/{folder['id']}/access", json={"sharedWith": [users.ids["boris"]], "editAccess": []})
        read = _rpc(client, editor, "file_read", id=made["id"])["structuredContent"]
        assert read["text"] == "one" and read["rights"] == "view" and not read["canEdit"]
        denied = _rpc(client, editor, "file_edit", id=made["id"], base_updated_at=read["updatedAt"], old_text="one", new_text="two")
        assert denied["isError"] and denied["error"]["code"] == "permission_denied"

        anna.put(f"/api/cloud/folders/{folder['id']}/access", json={"sharedWith": [users.ids["boris"]], "editAccess": [users.ids["boris"]]})
        ok = _rpc(client, editor, "file_edit", id=made["id"], base_updated_at=read["updatedAt"], old_text="one", new_text="two")["structuredContent"]
        assert ok["updated"]["id"] == made["id"] and ok["updated"]["mine"] is False
        assert _rpc(client, owner, "file_read", id=made["id"])["structuredContent"]["text"] == "two"

        # откат: версию оставил редактор, вернуть может любой с правом правки
        versions = _rpc(client, owner, "file_versions", id=made["id"])["structuredContent"]["versions"]
        assert len(versions) == 1 and versions[0]["id"]
        current = _rpc(client, owner, "file_read", id=made["id"])["structuredContent"]["updatedAt"]
        preview = _rpc(client, owner, "file_restore_version", id=made["id"], version_id=versions[0]["id"], dry_run=True)["structuredContent"]
        assert "-two" in preview["diff"] and "+one" in preview["diff"]
        restored = _rpc(client, owner, "file_restore_version", id=made["id"], version_id=versions[0]["id"], base_updated_at=current)["structuredContent"]
        assert restored["restored"] == versions[0]["id"]
        assert _rpc(client, owner, "file_read", id=made["id"])["structuredContent"]["text"] == "one"
        assert len(_rpc(client, owner, "file_versions", id=made["id"])["structuredContent"]["versions"]) == 2
    finally:
        for key in (owner_key, editor_key):
            db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (key,))


def test_unknown_extension_text_is_editable_but_binary_is_not(client, users):
    token, key_id = _keys(client, users, "anna")
    try:
        text = _put(client, token, "настройки.cfgx", "режим=быстрый\n".encode())
        read = _rpc(client, token, "file_read", id=text["id"])["structuredContent"]
        assert read["editable"] and read["text"].startswith("режим")
        binary = _put(client, token, "данные.bin", b"\x00\x01\x02\xff")
        info = _rpc(client, token, "file_read", id=binary["id"])
        assert info["isError"] or info["structuredContent"]["editable"] is False
        blocked = _rpc(client, token, "file_edit", id=binary["id"], base_updated_at="2026-01-01T00:00:00", old_text="a", new_text="b")
        assert blocked["isError"]
    finally:
        db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (key_id,))
