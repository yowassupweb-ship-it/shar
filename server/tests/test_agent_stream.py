"""Правка открытой таблицы агентом потоком через совместную правку (workspace/agent_stream.py)."""

from __future__ import annotations

import base64
import io
import json
import zipfile

import pytest

from app.modules.workspace import agent_stream, live


@pytest.fixture()
def journal(monkeypatch):
    """Журнал совместной правки в памяти (без Redis), подписчик есть, раздача правок — в список."""
    monkeypatch.setattr(live, "_redis", lambda: None)
    live._mem.heads.clear(); live._mem.logs.clear()
    monkeypatch.setattr(live, "_subscribers", lambda item_id: {"u1"})
    pushed: list[dict] = []
    monkeypatch.setattr(live, "_push", lambda item_id, payload, *, extra: pushed.append(payload))
    monkeypatch.setattr(agent_stream.time, "sleep", lambda s: None)
    live._init("77", "base")
    return pushed


def test_cell_payload_values_formula_link():
    assert agent_stream.cell_payload(5) == {"v": 5, "t": 2, "f": None, "p": None}
    assert agent_stream.cell_payload(True)["t"] == 3
    assert agent_stream.cell_payload("=SUM(A1:A3)")["f"] == "=SUM(A1:A3)"
    assert agent_stream.cell_payload("") is None
    linked = agent_stream.cell_payload("Сайт", "https://example.com")
    assert linked["v"] == "Сайт"
    assert linked["p"]["body"]["customRanges"][0]["properties"]["url"] == "https://example.com"


def test_plan_small_by_cell_large_by_rows():
    few = [(0, c, {"v": c}) for c in range(5)]
    chunks, pause = agent_stream.plan(few)
    assert len(chunks) == 5 and all(len(ch) == 1 for ch in chunks)
    many = [(r, c, {"v": 1}) for r in range(500) for c in range(4)]
    chunks, pause = agent_stream.plan(many)
    assert len(chunks) <= 80 and sum(len(ch) for ch in chunks) == 2000
    assert agent_stream.MIN_PAUSE_S <= pause <= agent_stream.MAX_PAUSE_S
    assert pause * len(chunks) <= agent_stream.STREAM_BUDGET_S + agent_stream.MIN_PAUSE_S * len(chunks)


def test_sheet_ids_from_custom_props_or_order():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        ids = json.dumps({"Цены": "abc"}).replace('"', "&quot;")
        z.writestr("docProps/custom.xml", f'<Properties><property name="SharSheetIds" pid="2"><vt:lpwstr>{ids}</vt:lpwstr></property></Properties>')
    content = base64.b64encode(buf.getvalue()).decode()
    assert agent_stream.sheet_ids(content, ["Цены", "Лист2"]) == {"Цены": "abc", "Лист2": "sheet-2"}
    assert agent_stream.sheet_ids("", ["A", "B"]) == {"A": "sheet-1", "B": "sheet-2"}


def test_live_head_only_when_someone_has_it_open(journal, monkeypatch):
    assert agent_stream.live_head("77")
    monkeypatch.setattr(live, "_subscribers", lambda item_id: set())
    assert agent_stream.live_head("77") is None
    assert agent_stream.live_head("78") is None


def test_stream_puts_ops_in_journal_in_order_and_moves_agent_cursor(journal):
    writes = [(r, 0, agent_stream.cell_payload(f"строка {r}")) for r in range(3)]
    last = agent_stream.stream("77", "u1", "Claude", [("sheet-1", writes)])
    assert last is not None and last[1] == 3
    ops = [p for p in journal if p["type"] == "workspace_ops"]
    cursors = [p for p in journal if p["type"] == "workspace_cursor"]
    assert [p["rev"] for p in ops] == [1, 2, 3]
    assert ops[0]["ops"][0]["id"] == agent_stream.VALUES
    assert ops[0]["ops"][0]["params"] == {"subUnitId": "sheet-1", "cellValue": {"0": {"0": writes[0][2]}}}
    # Курсор агента идёт по ячейкам и убирается в конце; у него своё имя.
    assert cursors[0]["name"] == "Claude" and cursors[0]["cursor"]["r1"] == 0
    assert cursors[-1]["cursor"] is None
    # Журнал совместной правки: те же правки, что получат открывающие позже.
    entries = live._entries("77", 3, 0)
    assert [e["rev"] for e in entries] == [1, 2, 3]


def test_stream_waits_out_concurrent_human_edit(journal):
    # Человек успел записать правку раньше агента — агент берёт новую версию и кладёт свою следом.
    head = live._head("77")
    status, _ = live._submit("77", head["epoch"], head["rev"], "human", 1, ',"cid":"human","bid":1,"userId":"u1","ops":[]}')
    assert status == "ok"
    last = agent_stream.stream("77", "u1", "Claude", [("sheet-1", [(0, 0, {"v": 1, "t": 2})])])
    assert last is not None and last[1] == 2


def test_stream_returns_none_without_journal(journal):
    live._mem.heads.clear()
    assert agent_stream.stream("77", "u1", "Claude", [("sheet-1", [(0, 0, {"v": 1})])]) is None


def test_update_table_streams_into_open_table_without_rewriting_file(anna, client, monkeypatch):
    """Таблица открыта — правка агента идёт в журнал совместной правки (у открывших — на глазах), файл не
    перезаписывается и открытые редакторы не перечитываются (поколение журнала то же)."""
    from tests.test_mcp import _key, _ok

    token, _ = _key(anna)
    table = _ok(client, token, "create_table", title="Поток", rows=[["Город", "Туры"], ["Казань", 12]])
    opened = anna.get(f"/api/workspace/items/{table['id']}").json()
    epoch = opened["item"]["live"]["epoch"]
    pushed: list[dict] = []
    monkeypatch.setattr(live, "_subscribers", lambda item_id: {"someone"})
    monkeypatch.setattr(live, "_push", lambda item_id, payload, *, extra: pushed.append(payload))
    monkeypatch.setattr(agent_stream.time, "sleep", lambda s: None)
    monkeypatch.setattr(agent_stream, "SAVE_WAIT_S", 0.05)

    res = _ok(client, token, "update_table", id=table["id"], cells=[{"ref": "B2", "value": 15}], append_rows=[["Сочи", 7]])
    assert res["live"] is True and res["cellRefs"] == ["B2"]
    ops = [p for p in pushed if p["type"] == "workspace_ops"]
    written = {}
    for p in ops:
        assert p["epoch"] == epoch
        for op in p["ops"]:
            for r, row in op["params"]["cellValue"].items():
                for c, cell in row.items():
                    written[(int(r), int(c))] = cell["v"]
    assert written == {(1, 1): 15, (2, 0): "Сочи", (2, 1): 7}
    # Файл не трогали: его сохранит открытый редактор; поколение журнала прежнее.
    assert live._head(str(table["id"]))["epoch"] == epoch
    assert [p for p in pushed if p["type"] == "workspace_cursor"][-1]["cursor"] is None


def test_file_path_keeps_editor_parts():
    """Агент пишет закрытую таблицу через openpyxl — части своего редактора (диаграммы и правила в extras.json,
    номера листов) возвращаются в файл, а не пропадают."""
    from openpyxl import Workbook

    from app.modules.mcp import tools

    book = Workbook(); book.active["A1"] = "x"
    plain = io.BytesIO(); book.save(plain)
    with zipfile.ZipFile(io.BytesIO(plain.getvalue())) as z:
        files = {n: z.read(n) for n in z.namelist()}
    files["xl/shar/extras.json"] = b'{"Sheet":{"objects":[{"id":"ch1","kind":"chart"}]}}'
    orig = io.BytesIO()
    with zipfile.ZipFile(orig, "w") as z:
        for n, d in files.items():
            z.writestr(n, d)
    kept = tools._keep_editor_parts(base64.b64encode(orig.getvalue()).decode(), plain.getvalue())
    with zipfile.ZipFile(io.BytesIO(kept)) as z:
        assert json.loads(z.read("xl/shar/extras.json"))["Sheet"]["objects"][0]["kind"] == "chart"
        assert 'Extension="json"' in z.read("[Content_Types].xml").decode()
