"""Доступ к событию календаря: по людям, по отделам, право правки участникам, выход из события."""

from __future__ import annotations

import uuid


def _event(**extra):
    return {"id": uuid.uuid4().hex, "title": "Планёрка", "type": "personal", "startDateTime": "2031-03-10T10:00:00",
            "endDateTime": "2031-03-10T11:00:00", "startDate": "2031-03-10T10:00:00", "endDate": "2031-03-10T11:00:00",
            "participants": [], "sharedWithAll": False, **extra}


def _list(client, uid):
    r = client.get("/api/events", params={"startDate": "2031-03-01", "endDate": "2031-03-31", "userId": uid, "personal": "true"})
    assert r.status_code == 200, r.text
    return {e["id"]: e for e in r.json()["events"]}


def _dept(admin, name, parent=None):
    r = admin.post("/api/departments", json={"name": f"{name}-{uuid.uuid4().hex[:4]}", **({"parentId": parent} if parent else {})})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_event_shared_with_department_reaches_members_and_subdepartments(users, admin, anna, boris, clara):
    from app.core.db import db

    parent = _dept(admin, "Продажи")
    child = _dept(admin, "Продажи-юг", parent)
    other = _dept(admin, "Бухгалтерия")
    db.update_user(users.ids["boris"], {"departmentIds": [child]})
    db.update_user(users.ids["clara"], {"departmentIds": [other]})

    ev = _event(sharedDepartments=[parent])
    assert anna.post("/api/events", json=ev).status_code == 200

    assert ev["id"] in _list(anna, users.ids["anna"])
    assert ev["id"] in _list(boris, users.ids["boris"]), "подотдел видит событие, выданное родительскому отделу"
    assert ev["id"] not in _list(clara, users.ids["clara"]), "чужой отдел не видит"
    assert boris.get(f"/api/events/{ev['id']}").status_code == 200
    assert clara.get(f"/api/events/{ev['id']}").status_code == 404


def test_participants_edit_only_when_allowed_and_never_reshare(users, anna, boris, clara):
    ev = _event(participants=[users.ids["boris"]])
    assert anna.post("/api/events", json=ev).status_code == 200

    # по умолчанию участник только смотрит
    assert boris.put(f"/api/events/{ev['id']}", json={"title": "Моё"}).status_code == 403

    assert anna.put(f"/api/events/{ev['id']}", json={"participantsCanEdit": True}).status_code == 200
    r = boris.put(f"/api/events/{ev['id']}", json={"title": "Правка Бориса", "participants": [users.ids["clara"]], "sharedWithAll": True})
    assert r.status_code == 200, r.text
    after = anna.get(f"/api/events/{ev['id']}").json()
    assert after["title"] == "Правка Бориса"
    # доступ участник менять не может: список людей и «все» остались прежними
    assert after["participants"] == [users.ids["boris"]]
    assert not after.get("sharedWithAll")
    # удалять по-прежнему только автор
    assert boris.delete(f"/api/events/{ev['id']}").status_code == 403
    # посторонний не правит, даже если право открыто
    assert clara.put(f"/api/events/{ev['id']}", json={"title": "Чужая"}).status_code in (403, 404)


def test_participant_can_leave_event(users, anna, boris):
    ev = _event(participants=[users.ids["boris"]])
    assert anna.post("/api/events", json=ev).status_code == 200
    assert ev["id"] in _list(boris, users.ids["boris"])

    assert boris.post(f"/api/events/{ev['id']}/leave").status_code == 200
    assert ev["id"] not in _list(boris, users.ids["boris"])
    assert ev["id"] in _list(anna, users.ids["anna"])
    # повторно уже не участник
    assert boris.post(f"/api/events/{ev['id']}/leave").status_code == 404


def test_reminder_recipients_include_department_members(users, admin):
    from app.core.db import db
    from app.modules.calendar.reminders import _event_recipients

    dept = _dept(admin, "Склад")
    db.update_user(users.ids["clara"], {"departmentIds": [dept]})
    got = _event_recipients({"user_id": users.ids["anna"], "metadata": {"sharedDepartments": [dept]}})
    assert users.ids["clara"] in got and users.ids["anna"] in got
