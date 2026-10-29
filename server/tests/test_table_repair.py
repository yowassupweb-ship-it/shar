"""Таблица: текст ячейки «с оформлением» (rich text, `p` без `v`) не теряется при сохранении из совместной правки.

Клиент (и старые Шар OS) писал в xlsx только простое значение — такая ячейка уходила в файл пустой, и после
переоткрытия текст пропадал. Сервер вписывает его по журналу правок (table_repair.py)."""

from __future__ import annotations

import base64
import io
import json
import re
import zipfile

from app.modules.workspace.table_repair import lost_cells, repair_xlsx, rich_text

VALUES = "sheet.mutation.set-range-values"


def rich(text: str) -> dict:
    return {"p": {"body": {"dataStream": text + "\r\n", "textRuns": [{"st": 0, "ed": len(text), "ts": {"ff": "Inter", "fs": 11}}]}}, "s": "x1"}


def entry(rev: int, *ops: dict) -> dict:
    return {"rev": rev, "cid": "c", "bid": rev, "userId": "u", "ops": list(ops)}


def values(cells: dict, sheet: str = "sheet-1") -> dict:
    return {"id": VALUES, "params": {"subUnitId": sheet, "cellValue": {str(r): {str(c): v for c, v in cols.items()} for r, cols in cells.items()}}}


def rows(op: str, start: int, end: int, sheet: str = "sheet-1") -> dict:
    return {"id": f"sheet.mutation.{op}", "params": {"subUnitId": sheet, "range": {"startRow": start, "endRow": end, "startColumn": 0, "endColumn": 10}}}


def xlsx(sheet_xml: str, sheet_ids: dict | None = None) -> str:
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        "xl/workbook.xml": '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                           '<sheet name="Лист &amp; 1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": f'<worksheet><sheetData>{sheet_xml}</sheetData></worksheet>',
        "docProps/custom.xml": '<Properties xmlns:vt="x"><property name="SharSheetIds"><vt:lpwstr>'
                               + json.dumps(sheet_ids or {"Лист & 1": "sheet-1"}, ensure_ascii=False).replace("&", "&amp;").replace('"', "&quot;")
                               + "</vt:lpwstr></property></Properties>",
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
    return base64.b64encode(out.getvalue()).decode()


def sheet_of(content: str) -> str:
    return zipfile.ZipFile(io.BytesIO(base64.b64decode(content))).read("xl/worksheets/sheet1.xml").decode()


def test_rich_text_only_without_plain_value():
    assert rich_text(rich("Иваново — Шуя")) == "Иваново — Шуя"
    assert rich_text({"p": {"body": {"dataStream": "Две\rстроки\r\n"}}}) == "Две\nстроки"
    assert rich_text({**rich("x"), "v": "x"}) is None  # простое значение клиент пишет сам
    assert rich_text({**rich("x"), "f": "=A1"}) is None
    assert rich_text({"p": {"body": {"dataStream": "\r\n"}}}) is None


def test_lost_cells_follows_journal():
    marks = lost_cells([
        entry(1, values({24: {1: rich("Иваново")}, 5: {0: rich("Стёрто")}, 7: {2: rich("Перебито")}})),
        entry(2, values({7: {2: {"v": "Число", "s": "x"}}})),  # перебито простым значением
        entry(3, values({5: {0: None}})),  # очищено
        entry(4, values({24: {1: {"s": "x2"}}})),  # только оформление — текст прежний
        entry(5, rows("insert-row", 10, 11)),  # две строки выше 24-й: текст уезжает на 26
        entry(6, values({3: {3: rich("Удалится")}})),
        entry(7, rows("remove-rows", 2, 4)),  # строки 2–4 удалены: 3:3 пропадает, 26 → 23
        entry(8, values({40: {0: rich("Другой лист")}}, sheet="sheet-2")),
        entry(9, {"id": "sheet.mutation.reorder-range", "params": {"subUnitId": "sheet-2"}}),  # сортировка — не трогаем
    ])
    assert marks == {("sheet-1", 23, 1): "Иваново"}


def test_repair_fills_only_empty_cells():
    content = xlsx('<row r="25"><c r="A25" s="3" t="s"><v>0</v></c><c r="B25" s="24"/><c r="D25" s="5"><v>7</v></c></row>'
                   '<row r="30" spans="1:3"/>')
    marks = {("sheet-1", 24, 1): "Иваново <Палех> & Шуя", ("sheet-1", 24, 3): "не трогать", ("sheet-1", 24, 2): "C25 новый",
             ("sheet-1", 29, 0): "в пустой строке", ("sheet-1", 40, 4): "новая строка", ("sheet-1", 2, 0): "выше всех"}
    fixed, n = repair_xlsx(content, marks)
    xml = sheet_of(fixed)
    assert n == 5
    assert '<c r="B25" s="24" t="inlineStr"><is><t xml:space="preserve">Иваново &lt;Палех&gt; &amp; Шуя</t></is></c>' in xml
    assert '<c r="D25" s="5"><v>7</v></c>' in xml  # со значением — не трогаем
    # Новая ячейка — между B25 и D25 по порядку столбцов; новые строки — по порядку номеров.
    assert re.search(r'<c r="B25".*?</c><c r="C25" t="inlineStr">.*?</c><c r="D25"', xml)
    assert '<row r="30" spans="1:3"><c r="A30" t="inlineStr"><is><t xml:space="preserve">в пустой строке</t></is></c></row>' in xml
    assert xml.index('<row r="3">') < xml.index('<row r="25">') < xml.index('<row r="41">')
    # Повтор ничего не меняет: всё уже вписано.
    assert repair_xlsx(fixed, marks)[1] == 0


def test_repair_ignores_unknown_sheet_and_bad_content():
    content = xlsx('<row r="1"/>')
    assert repair_xlsx(content, {("sheet-9", 0, 0): "x"}) == (content, 0)
    assert repair_xlsx("not base64 zip", {("sheet-1", 0, 0): "x"}) == ("not base64 zip", 0)


def test_live_save_restores_rich_text(anna, users):
    """Целиком: правка с rich text прошла через журнал, клиент прислал файл с пустой ячейкой — в базе текст есть."""
    from tests.test_workspace import _create

    item = _create(anna, "table", title="Многодневки", content=xlsx('<row r="25"><c r="B25" s="24"/></row>'))
    url = f"/api/workspace/items/{item['id']}"
    epoch = anna.get(url).json()["item"]["live"]["epoch"]
    with anna.websocket_connect(f"/api/ws/{users.ids['anna']}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "ops", "itemId": item["id"], "epoch": epoch, "base": 0, "cid": "a", "bid": 1,
                                 "ops": [values({24: {1: rich("Иваново - Палех 3 дн. авто")}})]}))
        for _ in range(10):
            if json.loads(ws.receive_text()).get("type") == "workspace_ops":
                break
    saved = anna.patch(url, json={"content": xlsx('<row r="25"><c r="B25" s="24"/></row>'), "live": {"epoch": epoch, "rev": 1}})
    assert saved.status_code == 200, saved.text
    content = anna.get(url).json()["item"]["content"]
    assert '<c r="B25" s="24" t="inlineStr"><is><t xml:space="preserve">Иваново - Палех 3 дн. авто</t></is></c>' in sheet_of(content)
