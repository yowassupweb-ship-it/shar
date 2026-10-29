"""Статистика разделов: посылки складываются по дням, мусор отбрасывается, отчёт — только админу."""

from __future__ import annotations


def test_beats_aggregate_and_report_is_admin_only(admin, anna, boris, users):
    assert anna.post("/api/usage/beat", json={"items": [{"section": "office", "visits": 1, "seconds": 30}, {"section": "chats", "visits": 2, "seconds": 10}]}).status_code == 200
    # Тело как text/plain (sendBeacon) и мусор: чужой раздел, огромные секунды обрезаются, отрицательные — ноль.
    assert anna.post("/api/usage/beat", content='{"items":[{"section":"office","visits":0,"seconds":99999},{"section":"../x","visits":5,"seconds":5},{"section":"mail","visits":-3,"seconds":-1}]}',
                     headers={"Content-Type": "text/plain"}).status_code == 200
    boris.post("/api/usage/beat", json={"items": [{"section": "office", "visits": 1, "seconds": 12}]})
    assert anna.get("/api/admin/usage").status_code == 403
    report = admin.get("/api/admin/usage?days=7").json()
    office = next(s for s in report["sections"] if s["section"] == "office")
    assert office["users"] >= 2 and office["visits"] >= 2
    anna_row = next(u for u in report["users"] if u["userId"] == users.ids["anna"])
    assert anna_row["sections"]["office"]["seconds"] == 30 + 900 and anna_row["sections"]["chats"]["visits"] == 2
    assert "mail" not in anna_row["sections"] and all(s["section"] != "../x" for s in report["sections"])
    assert anna_row["name"] and report["daily"][-1]["users"] >= 2
