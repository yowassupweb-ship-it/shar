"""Персистентные напоминания, уведомления и запуски агентов по расписанию."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.core.db import db


def _rpc(client, token, tool_name, /, **args):
    response = client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                             "params": {"name": tool_name, "arguments": args}},
                           headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200, response.text
    return response.json()["result"]


def test_reminder_claim_survives_process_memory():
    from app.modules.calendar.reminders import _claim

    key = f"test-{uuid.uuid4().hex}"
    try:
        assert _claim(key)
        assert not _claim(key)
    finally:
        db.conn.execute_query("DELETE FROM calendar_reminder_receipts WHERE reminder_key = %s", (key,))


def test_agent_schedule_uses_moscow_time_independent_of_host_timezone():
    from app.modules.core_agents import schedules

    local = schedules._parse_at("2026-11-03T09:00")
    assert local.utcoffset() == timedelta(hours=3)
    assert local.astimezone(timezone.utc).hour == 6
    next_run = schedules._following("09:00", [], after=datetime(2026, 11, 2, 5, 0, tzinfo=timezone.utc))
    assert next_run.astimezone(timezone.utc) == datetime(2026, 11, 2, 6, 0, tzinfo=timezone.utc)


def test_agent_schedule_dispatches_once_and_lists_events(client, admin, users):
    from app.modules.core_agents import dispatch, permissions, schedules
    from app.modules.notifications.router import create_notification

    uid = users.ids["admin"]
    token, key_id = dispatch._mcp_key(uid, "gemini", "")
    notice_id, foreign_id = f"test-{uuid.uuid4().hex}", f"test-{uuid.uuid4().hex}"
    try:
        node = admin.post("/api/core/nodes", json={"name": "scheduler-test"}).json()
        client.post("/api/core/node/poll", json={"version": "1.2.4", "clis": {"gemini": "1"}, "wait": False},
                    headers={"Authorization": f"Bearer {node['token']}"})
        db.conn.execute_query("INSERT INTO core_accounts (user_id, provider, state) VALUES (%s, 'gemini', 'ready')", (uid,))
        thread = admin.post("/api/core/threads", json={}).json()["thread"]
        permissions.set_mode(uid, "auto")

        create_notification(uid, id=notice_id, type="task_updated", message="Срок сегодня")
        create_notification(users.ids["anna"], id=foreign_id, type="task_updated", message="Чужое")
        events = _rpc(client, token, "events_list", unread_only=True)["structuredContent"]
        assert [e["id"] for e in events["events"] if e["id"].startswith("test-")] == [notice_id]

        at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        made = _rpc(client, token, "agent_schedule", prompt="Собери утреннюю сводку", thread_id=thread["id"],
                    frequency="once", at=at, provider="gemini")["structuredContent"]["created"]
        db.conn.execute_query("UPDATE core_agent_schedules SET next_run = now() - interval '1 second' WHERE id = %s", (made["id"],))
        assert schedules.deliver_due() == 1
        assert schedules.deliver_due() == 0
        jobs = db.conn.fetch_all("SELECT * FROM core_jobs WHERE kind = 'run'") or []
        assert len(jobs) == 1 and jobs[0]["payload"]["userMessageId"].startswith("sched-")
        messages = admin.get(f"/api/core/threads/{thread['id']}/messages").json()["messages"]
        assert [m["body"] for m in messages if m["role"] == "user"] == ["Собери утреннюю сводку"]
        assert messages[-1]["status"] == "queued"
        run = client.post("/api/core/node/poll", json={"version": "1.2.4", "clis": {"gemini": "1"}, "wait": False},
                          headers={"Authorization": f"Bearer {node['token']}"}).json()["jobs"][0]
        assert run["kind"] == "run" and run["prompt"] == "Собери утреннюю сводку"

        # Повтор после сбоя между постановкой задачи и завершением строки не создаёт дубль.
        db.conn.execute_query("UPDATE core_agent_schedules SET enabled = true, claimed_at = NULL WHERE id = %s",
                              (made["id"],))
        assert schedules.deliver_due() == 1
        assert len(db.conn.fetch_all("SELECT * FROM core_jobs WHERE kind = 'run'") or []) == 1
        assert len([m for m in admin.get(f"/api/core/threads/{thread['id']}/messages").json()["messages"]
                    if m["role"] == "user"]) == 1

        weekly = _rpc(client, token, "agent_schedule", prompt="Проверь события", thread_id=thread["id"],
                      frequency="weekly", time="09:30", weekdays=[0, 3], provider="gemini")["structuredContent"]["created"]
        assert weekly["weekdays"] == [0, 3] and weekly["nextRun"]
        assert not schedules.cancel(users.ids["anna"], weekly["id"])
        assert _rpc(client, token, "agent_schedule_cancel", id=weekly["id"], confirm=True)["structuredContent"]["cancelled"]
        assert weekly["id"] not in [s["id"] for s in _rpc(client, token, "agent_schedules")["structuredContent"]["schedules"]]
    finally:
        permissions.set_mode(uid, "careful")
        db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (key_id,))
        db.conn.execute_query("DELETE FROM user_notifications WHERE id = ANY(%s)", ([notice_id, foreign_id],))
        db.conn.execute_query("DELETE FROM core_agent_schedules WHERE user_id = %s", (uid,))
        db.conn.execute_query("DELETE FROM core_jobs; DELETE FROM core_accounts; DELETE FROM core_nodes;")
