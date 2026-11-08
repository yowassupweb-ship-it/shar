"""Задача, поручённая агенту: расписание из срока и повтора задачи, запуск, отчёт в задаче, закрытие разовой."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import db

MSK = timezone(timedelta(hours=3))


def _task(owner, uid, title="Снять позиции в Топвизоре", **extra) -> str:
    r = owner.post("/api/todos", json={"type": "todo", "title": title, "assignedToId": uid, "assignedToIds": [uid], "metadata": {"md": "Выгрузить позиции"}, **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _task_dict(**fields) -> dict:
    return {"id": "t", "title": "Т", **fields}


def test_next_run_follows_due_and_repeat():
    from app.modules.core_agents import task_agent as ta

    after = datetime(2026, 11, 8, 10, 0, tzinfo=MSK)  # воскресенье
    # без повтора: срок впереди — в его время; срок прошёл — запуска по расписанию нет
    assert ta.compute_next(_task_dict(due_date="2026-11-10T14:30:00"), "09:00", after) == datetime(2026, 11, 10, 14, 30, tzinfo=MSK)
    assert ta.compute_next(_task_dict(due_date="2026-11-10"), "09:00", after) == datetime(2026, 11, 10, 9, 0, tzinfo=MSK)
    assert ta.compute_next(_task_dict(due_date="2026-11-01"), "09:00", after) is None
    assert ta.compute_next(_task_dict(), "09:00", after) is None
    # повтор: ближайший по правилу, в время срока
    meta = lambda r: {"repeat": r}  # noqa: E731
    assert ta.compute_next(_task_dict(due_date="2026-11-02T08:00:00", metadata=meta("daily")), "09:00", after) == datetime(2026, 11, 9, 8, 0, tzinfo=MSK)
    assert ta.compute_next(_task_dict(due_date="2026-11-02", metadata=meta("weekdays")), "09:00", after) == datetime(2026, 11, 9, 9, 0, tzinfo=MSK)  # пн
    assert ta.compute_next(_task_dict(due_date="2026-11-04", metadata=meta("weekly")), "09:00", after) == datetime(2026, 11, 11, 9, 0, tzinfo=MSK)  # ср
    assert ta.compute_next(_task_dict(due_date="2026-11-04", metadata=meta("biweekly")), "09:00", after) == datetime(2026, 11, 18, 9, 0, tzinfo=MSK)
    assert ta.compute_next(_task_dict(due_date="2026-01-31", metadata=meta("monthly")), "09:00", datetime(2026, 2, 1, 0, 0, tzinfo=MSK)) == datetime(2026, 2, 28, 9, 0, tzinfo=MSK)
    # повтор без срока — со следующего дня в run_time
    assert ta.compute_next(_task_dict(metadata=meta("daily")), "07:15", after) == datetime(2026, 11, 9, 7, 15, tzinfo=MSK)


def _connect_agent(admin, client, uid):
    node = admin.post("/api/core/nodes", json={"name": "task-agent-test"}).json()
    client.post("/api/core/node/poll", json={"version": "1.2.4", "clis": {"gemini": "1"}, "wait": False}, headers={"Authorization": f"Bearer {node['token']}"})
    db.conn.execute_query("INSERT INTO core_accounts (user_id, provider, state) VALUES (%s, 'gemini', 'ready')", (uid,))
    return node


def _cleanup(uid):
    db.conn.execute_query("DELETE FROM task_agent; DELETE FROM task_agent_reports; DELETE FROM core_jobs; DELETE FROM core_accounts; DELETE FROM core_nodes;")
    db.conn.execute_query("DELETE FROM core_threads WHERE user_id = %s", (uid,))


def test_one_off_task_runs_reports_and_closes(client, admin, users):
    from app.modules.core_agents import node as core_node
    from app.modules.core_agents import task_agent as ta

    uid = users.ids["admin"]
    try:
        _connect_agent(admin, client, uid)
        tomorrow = (datetime.now(MSK) + timedelta(days=1)).strftime("%Y-%m-%dT10:00:00")
        task = _task(admin, uid, dueDate=tomorrow)
        got = admin.put(f"/api/todos/{task}/agent", json={"enabled": True, "provider": "gemini"})
        assert got.status_code == 200, got.text
        view = got.json()
        assert view["enabled"] and view["nextRun"].startswith(tomorrow[:10]) and "Выполнит" in view["summary"]
        assert ta.deliver_due() == 0  # срок завтра — сейчас не просыпается

        # срок наступил → ровно один запуск в чате задачи
        db.conn.execute_query("UPDATE task_agent SET next_run = now() - interval '1 second' WHERE task_id = %s", (task,))
        assert ta.deliver_due() == 1 and ta.deliver_due() == 0
        jobs = db.conn.fetch_all("SELECT * FROM core_jobs WHERE kind = 'run'") or []
        assert len(jobs) == 1 and jobs[0]["payload"]["userMessageId"].startswith("taskrun-")
        row = db.conn.fetch_one("SELECT * FROM task_agent WHERE task_id = %s", (task,))
        assert not row["enabled"] and row["next_run"] is None  # разовое: отработало — спит насовсем
        sent = admin.get(f"/api/core/threads/{row['thread_id']}/messages").json()["messages"]
        assert "Выгрузить позиции" in sent[0]["body"] and "ГОТОВО" in sent[0]["body"]

        # агент закончил → отчёт в задаче, задача закрыта
        job = dict(jobs[0])
        job["payload"] = jobs[0]["payload"]
        core_node._apply_run({**job, "id": job["id"], "message_id": job["message_id"], "user_id": uid, "provider": "gemini"},
                             [{"type": "done", "body": "ГОТОВО\nСнял 120 позиций"}])
        report = admin.get(f"/api/todos/{task}/agent").json()["reports"]
        assert len(report) == 1 and report[0]["status"] == "ok" and "120 позиций" in report[0]["text"]
        assert db.get_task(task)["is_completed"] is True
    finally:
        _cleanup(uid)


def test_repeating_task_keeps_sleeping_and_failure_is_reported(client, admin, users):
    from app.modules.core_agents import node as core_node
    from app.modules.core_agents import task_agent as ta

    uid = users.ids["admin"]
    try:
        _connect_agent(admin, client, uid)
        task = _task(admin, uid, dueDate="2026-11-02", metadata={"md": "Снять позиции", "repeat": "daily"})
        assert admin.put(f"/api/todos/{task}/agent", json={"enabled": True, "provider": "gemini", "time": "08:30"}).status_code == 200
        db.conn.execute_query("UPDATE task_agent SET next_run = now() - interval '1 second' WHERE task_id = %s", (task,))
        assert ta.deliver_due() == 1
        row = db.conn.fetch_one("SELECT * FROM task_agent WHERE task_id = %s", (task,))
        assert row["enabled"] and row["next_run"] > datetime.now(timezone.utc)  # повтор: уснул до следующего раза

        job = (db.conn.fetch_all("SELECT * FROM core_jobs WHERE kind = 'run'") or [])[0]
        core_node._apply_run({**dict(job), "user_id": uid, "provider": "gemini"}, [{"type": "done", "body": "СБОЙ: Топвизор не ответил"}])
        reports = admin.get(f"/api/todos/{task}/agent").json()["reports"]
        assert reports[0]["status"] == "failed" and "Топвизор" in reports[0]["text"]
        assert db.get_task(task)["is_completed"] is not True  # сбой и повтор — задача остаётся открытой

        # агент отключён → больше не просыпается
        off = admin.put(f"/api/todos/{task}/agent", json={"enabled": False}).json()
        assert not off["enabled"]
        db.conn.execute_query("UPDATE task_agent SET next_run = now() - interval '1 second' WHERE task_id = %s", (task,))
        assert ta.deliver_due() == 0
    finally:
        _cleanup(uid)


def test_agent_needs_connected_agent_and_owner(users, admin, anna):
    uid = users.ids["admin"]
    task = _task(admin, uid)
    r = admin.put(f"/api/todos/{task}/agent", json={"enabled": True})
    assert r.status_code == 400 and "подключите" in r.json()["detail"].lower()
    assert anna.get(f"/api/todos/{task}/agent").status_code == 403  # чужую задачу не видно
