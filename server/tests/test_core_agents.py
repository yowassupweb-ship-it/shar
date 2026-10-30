"""Агенты «Ядра»: нода (токен, опрос, события), ответ агента в чате, ключ MCP на запуск, инструменты календаря,
задач, файлов, памяти и навыков, расход."""

from __future__ import annotations

import json
import uuid

from app.core.db import db


def _node(admin):
    r = admin.post("/api/core/nodes", json={"name": "тест"})
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["token"].startswith("shar_node_") and "install.sh" in data["command"]
    return data["node"], data["token"]


def _poll(client, token, **body):
    return client.post("/api/core/node/poll", json={"version": "t", "clis": {"claude": "2", "codex": "1", "gemini": "1"}, "wait": False, **body},
                       headers={"Authorization": f"Bearer {token}"})


def _events(client, token, job_id, *events):
    return client.post(f"/api/core/node/jobs/{job_id}/events", json={"events": list(events)}, headers={"Authorization": f"Bearer {token}"})


def _rpc(client, token, tool_name, /, **args):
    r = client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool_name, "arguments": args}},
                    headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    return r.json()["result"]


def _cleanup():
    db.conn.execute_query("DELETE FROM core_jobs; DELETE FROM core_accounts; DELETE FROM core_nodes;")


def test_nodes_are_admin_only_and_token_guarded(client, admin, anna):
    try:
        assert anna.get("/api/core/nodes").status_code == 403
        node, token = _node(admin)
        assert _poll(client, "shar_node_wrong").status_code == 401
        r = _poll(client, token)
        assert r.status_code == 200 and r.json() == {"jobs": [], "cancel": []}
        listed = admin.get("/api/core/nodes").json()["nodes"]
        assert listed[0]["online"] and listed[0]["info"]["clis"]["claude"] == "2"
        assert "shar_node_" not in json.dumps(listed).replace(listed[0]["start"], "")
        # Новый токен — старый перестаёт работать сразу.
        fresh = admin.post(f"/api/core/nodes/{node['id']}/token").json()["token"]
        assert _poll(client, token).status_code == 401 and _poll(client, fresh).status_code == 200
        assert client.get("/api/core/node/install.sh").status_code == 200
        assert "SHAR_NODE_TOKEN" in client.get("/api/core/node/agent.mjs").text
    finally:
        _cleanup()


def test_login_run_and_reply_through_node(client, admin):
    try:
        _, token = _node(admin)
        _poll(client, token)
        # Вход в подписку: задача ноде, ссылка и код — живым состоянием карточки, потом готово.
        admin.post("/api/core/accounts/claude/login")
        job = _poll(client, token).json()["jobs"][0]
        assert job["kind"] == "login" and job["provider"] == "claude"
        _events(client, token, job["id"], {"type": "login", "state": "waiting", "url": "https://claude.ai/x", "needsCode": True})
        card = next(a for a in admin.get("/api/core/accounts").json()["accounts"] if a["provider"] == "claude")
        assert card["login"]["url"] == "https://claude.ai/x"
        admin.post("/api/core/accounts/claude/login/code", json={"code": "abcd-1234"})
        code_job = _poll(client, token).json()["jobs"][0]
        assert code_job["kind"] == "login_code" and code_job["code"] == "abcd-1234"
        _events(client, token, job["id"], {"type": "login", "state": "done", "account": "me@example.com", "models": [
            {"id": "claude-opus-5-5", "label": "Opus 5.5"}, {"id": "claude-sonnet-5-5", "label": "Sonnet 5.5"}]})
        card = next(a for a in admin.get("/api/core/accounts").json()["accounts"] if a["provider"] == "claude")
        assert card["state"] == "ready" and card["account"] == "me@example.com"
        assert card["model"] == "claude-sonnet-5-5" and [m["id"] for m in card["models"]] == ["claude-opus-5-5", "claude-sonnet-5-5"]
        assert [a["id"] for a in admin.get("/api/core/catalog").json()["agents"]] == ["claude"]

        # Сообщение → ответ в очереди → нода берёт с ключом MCP и правилами → шаги, текст, итог.
        thread = admin.post("/api/core/threads", json={}).json()["thread"]
        sent = admin.post(f"/api/core/threads/{thread['id']}/messages", json={
            "id": uuid.uuid4().hex, "body": "Что у меня завтра?", "model": "claude:claude-opus-5-5",
            "context": [{"kind": "document", "title": "План", "id": "94", "url": "/office?kind=document&id=94"}]}).json()
        assert sent["reply"]["status"] == "queued"
        run = _poll(client, token).json()["jobs"][0]
        # «Где я» — в самом сообщении хода (GPT и Gemini при продолжении сессии системную часть не получают),
        # системная часть от хода к ходу не меняется.
        assert run["kind"] == "run" and run["model"] == "claude-opus-5-5" and run["prompt"].endswith("\n\nЧто у меня завтра?")
        assert "«План» (id 94)" in run["prompt"] and "«План»" not in run["system"] and run["mcp"]["token"].startswith("shar_mcp_")
        # Ключ запуска не виден человеку в его списке ключей, но работает — с календарём и задачами.
        assert all(not k["name"].startswith("Ядро") for k in admin.get("/api/mcp/keys").json()["keys"])
        listed = client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                             headers={"Authorization": f"Bearer {run['mcp']['token']}"}).json()["result"]["tools"]
        names = {t["name"] for t in listed}
        assert {"calendar_create", "task_create", "files_list", "memory_add", "skill_write", "ask_user"} <= names

        _events(client, token, run["id"], {"type": "progress", "phase": "думает", "steps": [{"kind": "tool", "name": "calendar_list"}]})
        _events(client, token, run["id"], {"type": "session", "id": "sess-1"},
                {"type": "done", "body": "Завтра свободно.", "work": {"input_tokens": 1000, "output_tokens": 50}, "model": "claude-opus"})
        messages = admin.get(f"/api/core/threads/{thread['id']}/messages").json()["messages"]
        reply = messages[-1]
        assert reply["status"] == "done" and reply["body"] == "Завтра свободно." and reply["props"]["steps"][0]["name"] == "calendar_list"
        assert db.conn.fetch_one("SELECT sessions FROM core_threads WHERE id = %s", (thread["id"],))["sessions"] == {"claude": "sess-1"}
        # Запуск закончен — ключ отозван.
        assert client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                           headers={"Authorization": f"Bearer {run['mcp']['token']}"}).status_code == 401
        usage = admin.get("/api/core/usage").json()["usage"]
        assert usage[0]["provider"] == "claude" and usage[0]["runs"] == 1 and usage[0]["costUsd"] == 0
    finally:
        _cleanup()


def test_stop_cancels_job_and_node_learns(client, admin):
    try:
        _, token = _node(admin)
        _poll(client, token)
        db.conn.execute_query("INSERT INTO core_accounts (user_id, provider, state) VALUES (%s, 'gemini', 'ready')",
                              (admin.get("/api/auth/session").json()["user"]["id"],))
        thread = admin.post("/api/core/threads", json={}).json()["thread"]
        sent = admin.post(f"/api/core/threads/{thread['id']}/messages", json={"id": uuid.uuid4().hex, "body": "долгая задача"}).json()
        run = _poll(client, token).json()["jobs"][0]
        assert run["provider"] == "gemini" and "apiKey" in run
        admin.post(f"/api/core/messages/{sent['reply']['id']}/cancel")
        assert _poll(client, token, running=[run["id"]]).json()["cancel"] == [run["id"]]
        assert _events(client, token, run["id"], {"type": "progress", "body": "…"}).json() == {"stop": True}
    finally:
        _cleanup()


def test_no_agent_no_reply_and_offline_node_explains(admin):
    thread = admin.post("/api/core/threads", json={}).json()["thread"]
    sent = admin.post(f"/api/core/threads/{thread['id']}/messages", json={"id": uuid.uuid4().hex, "body": "привет"}).json()
    assert sent["reply"] is None
    uid = admin.get("/api/auth/session").json()["user"]["id"]
    try:
        db.conn.execute_query("INSERT INTO core_accounts (user_id, provider, state) VALUES (%s, 'gemini', 'ready')", (uid,))
        sent = admin.post(f"/api/core/threads/{thread['id']}/messages", json={"id": uuid.uuid4().hex, "body": "привет"}).json()
        assert sent["reply"]["status"] == "failed" and "не на связи" in sent["reply"]["body"]
    finally:
        _cleanup()


def test_calendar_tasks_memory_tools(client, admin, anna, users):
    from app.modules.core_agents import dispatch

    uid = users.ids["anna"]
    token, key_id = dispatch._mcp_key(uid, "claude", "")
    try:
        made = _rpc(client, token, "calendar_create", title="Планёрка", start="2026-11-03T10:00", duration_minutes=30)["structuredContent"]["created"]
        assert made["start"].startswith("2026-11-03T10:00") and made["end"].startswith("2026-11-03T10:30") and made["mine"]
        found = _rpc(client, token, "calendar_list", **{"from": "2026-11-01", "to": "2026-11-07"})["structuredContent"]["events"]
        assert [e["title"] for e in found] == ["Планёрка"]
        _rpc(client, token, "calendar_update", id=made["id"], title="Планёрка отдела")
        assert _rpc(client, token, "calendar_delete", id=made["id"], confirm=False)["isError"]
        assert _rpc(client, token, "calendar_delete", id=made["id"], confirm=True)["structuredContent"]["deleted"]

        task = _rpc(client, token, "task_create", title="Сверить цены", text="- [ ] Карелия\n- [ ] Алтай", due_date="2026-11-04T18:00")["structuredContent"]["created"]
        assert task["assignees"] == [uid] and "Карелия" in task["text"]
        done = _rpc(client, token, "task_update", id=task["id"], done=True, status="review")["structuredContent"]
        assert done["done"] and done["status"] == "review"
        assert task["id"] in [t["id"] for t in _rpc(client, token, "tasks_list", include_done=True)["structuredContent"]["tasks"]]
        assert _rpc(client, token, "task_delete", id=task["id"], confirm=True)["structuredContent"]["deleted"]

        _rpc(client, token, "profile_note", section="Стиль", text="Любит короткие ответы")
        assert "Любит короткие ответы" in _rpc(client, token, "profile_read")["structuredContent"]["profile"]
        _rpc(client, token, "memory_add", text="Прайс Карелии лежит в папке «Цены 2027»", tags=["цены"], shared=True)
        hits = _rpc(client, token, "memory_search", query="прайс карелии")["structuredContent"]["notes"]
        assert hits and hits[0]["shared"]
        _rpc(client, token, "skill_write", name="tour-summary", description="Сводка по туру", body="1. Найти программу\n2. Цены")
        assert _rpc(client, token, "skill_read", name="tour-summary")["structuredContent"]["uses"] == 0
        assert anna.get("/api/core/memory").status_code == 403  # «Ядро» Анне не выдано — настройки закрыты
        written = _rpc(client, token, "file_write", name="итог.csv", text="тур;цена\nКарелия;100")["structuredContent"]["created"]
        assert "Карелия" in _rpc(client, token, "file_read", id=written["id"])["structuredContent"]["text"]
        assert _rpc(client, token, "file_delete", id=written["id"], confirm=True)["structuredContent"]["deleted"]
        # Общая память компании видна агенту другого сотрудника.
        other, other_id = dispatch._mcp_key(users.ids["boris"], "claude", "")
        assert _rpc(client, other, "memory_search", query="прайс")["structuredContent"]["notes"][0]["shared"]
        db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (other_id,))
    finally:
        db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (key_id,))
        db.conn.execute_query("DELETE FROM core_notes; DELETE FROM core_skills; DELETE FROM core_profiles;")


def test_personal_mcp_keys_dont_get_calendar_by_default(client, anna):
    r = anna.post("/api/mcp/keys", json={"name": "Cursor", "scope": {"access": "create"}})
    token = r.json()["token"]
    names = {t["name"] for t in client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                                            headers={"Authorization": f"Bearer {token}"}).json()["result"]["tools"]}
    assert "calendar_create" not in names and "read_item" in names
    assert _rpc(client, token, "calendar_list")["isError"]


def test_permission_mode_is_enforced_by_server(client, admin, users):
    """«Осторожно»: удаление без согласия человека не выполняется; «Разрешить» даёт одно разрешение на этот инструмент."""
    from app.modules.core_agents import dispatch, permissions

    uid = admin.get("/api/auth/session").json()["user"]["id"]
    thread = admin.post("/api/core/threads", json={}).json()["thread"]
    from app.modules.core_chat.router import post_agent_message

    message = post_agent_message(uid, thread["id"], "Claude", status="working", props={"provider": "claude"})
    token, key_id = dispatch._mcp_key(uid, "claude", message["id"])
    try:
        task = _rpc(client, token, "task_create", title="Удалить потом")["structuredContent"]["created"]
        denied = _rpc(client, token, "task_delete", id=task["id"], confirm=True)
        assert denied["isError"] and "request_permission" in denied["content"][0]["text"]
        asked = _rpc(client, token, "request_permission", tool="task_delete", summary="Удалю задачу «Удалить потом»")["structuredContent"]
        card = admin.get(f"/api/core/threads/{thread['id']}/messages").json()["messages"][-1]
        assert card["props"]["ask"]["kind"] == "permission"
        admin.post(f"/api/core/messages/{message['id']}/answer", json={"value": "Разрешить"})
        last = admin.get(f"/api/core/threads/{thread['id']}/messages").json()["messages"]
        mine = [m for m in last if m["role"] == "user"][-1]
        assert mine["body"] == "Разрешить" and asked["approval"] in mine["props"]["agentNote"]
        assert _rpc(client, token, "task_delete", id=task["id"], confirm=True, approval_id=asked["approval"])["structuredContent"]["deleted"]
        # Разрешение — на пачку дел в ближайшие минуты: вторая задача удаляется тем же разрешением; другой инструмент — нет.
        again = _rpc(client, token, "task_create", title="Ещё одна")["structuredContent"]["created"]
        assert _rpc(client, token, "calendar_delete", id="x", confirm=True, approval_id=asked["approval"])["isError"]
        assert _rpc(client, token, "task_delete", id=again["id"], confirm=True, approval_id=asked["approval"])["structuredContent"]["deleted"]
        db.conn.execute_query("UPDATE core_approvals SET decided_at = now() - interval '1 hour' WHERE id = %s", (asked["approval"],))
        third = _rpc(client, token, "task_create", title="Третья")["structuredContent"]["created"]
        assert _rpc(client, token, "task_delete", id=third["id"], confirm=True, approval_id=asked["approval"])["isError"]
        # «Под ключ»: задача коллеге — без вопросов, удаление — всё равно с разрешением.
        permissions.set_mode(uid, "auto")
        auto_token, auto_key = dispatch._mcp_key(uid, "claude", message["id"])
        other = users.ids["anna"]
        assert _rpc(client, auto_token, "task_create", title="Коллеге", assignee_ids=[other])["structuredContent"]["created"]
        assert _rpc(client, auto_token, "task_delete", id=third["id"], confirm=True)["isError"]
        db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (auto_key,))
    finally:
        permissions.set_mode(uid, "careful")
        db.conn.execute_query("UPDATE mcp_keys SET revoked_at = now() WHERE id = %s", (key_id,))
        _cleanup()


def test_forwarded_reaches_agent_and_chats_stay_closed(client, admin):
    try:
        _, token = _node(admin)
        _poll(client, token)
        uid = admin.get("/api/auth/session").json()["user"]["id"]
        db.conn.execute_query("INSERT INTO core_accounts (user_id, provider, state) VALUES (%s, 'gemini', 'ready')", (uid,))
        thread = admin.post("/api/core/threads", json={}).json()["thread"]
        admin.post(f"/api/core/threads/{thread['id']}/messages", json={
            "id": uuid.uuid4().hex, "body": "Что решили?",
            "forwarded": [{"author": "Мария", "text": "Едем в Карелию 12-го", "at": "29 окт., 10:00", "files": []}]})
        run = _poll(client, token).json()["jobs"][0]
        assert "Мария" in run["prompt"] and "Едем в Карелию" in run["prompt"]
        opened = _rpc(client, run["mcp"]["token"], "open_in_shar", url="/chats?chat=1")
        assert opened["isError"]
        assert _rpc(client, run["mcp"]["token"], "open_in_shar", url="/office?kind=document&id=1")["structuredContent"]["opened"]
    finally:
        _cleanup()


def test_image_generate_attaches_to_answer_and_lands_in_agent_files(client, admin, monkeypatch):
    """Картинка: Gemini по ключу человека (Google подменён), файл — в загрузки, к ответу агента и в «Файлы → Агенты»."""
    import base64

    from app.modules.core_agents import images, store

    class Res:
        def __init__(self, data, status=200):
            self._data, self.status_code, self.text = data, status, ""

        def json(self):
            return self._data

        def raise_for_status(self):
            pass

    png = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()
    monkeypatch.setattr(images.requests, "get", lambda *a, **k: Res({"models": [
        {"name": "models/gemini-2.5-flash-image", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/gemini-3-flash-image-preview", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/gemini-3-pro", "supportedGenerationMethods": ["generateContent"]}]}))
    sent_to: list[str] = []

    def post(url, **kwargs):
        sent_to.append(url)
        return Res({"candidates": [{"content": {"parts": [{"text": "Готово"}, {"inlineData": {"mimeType": "image/png", "data": png}}]}}],
                    "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 1290}})

    monkeypatch.setattr(images.requests, "post", post)
    images._models.clear()
    try:
        node, token = _node(admin)
        _poll(client, token)
        uid = admin.get("/api/auth/session").json()["user"]["id"]
        thread = admin.post("/api/core/threads", json={}).json()["thread"]
        # Без ключа Gemini — понятная ошибка, что подключить.
        db.conn.execute_query("INSERT INTO core_accounts (user_id, provider, state, node_id) VALUES (%s, 'claude', 'ready', %s)", (uid, int(node["id"])))
        sent = admin.post(f"/api/core/threads/{thread['id']}/messages", json={"id": uuid.uuid4().hex, "body": "Нарисуй Кострому"}).json()
        run = _poll(client, token).json()["jobs"][0]
        no_key = _rpc(client, run["mcp"]["token"], "image_generate", prompt="Кострома на закате")
        assert no_key["isError"] and "Gemini" in json.dumps(no_key, ensure_ascii=False)

        db.conn.execute_query("INSERT INTO core_accounts (user_id, provider, state, secret_enc) VALUES (%s, 'gemini', 'ready', %s)",
                              (uid, store.seal("AIza-test")))
        made = _rpc(client, run["mcp"]["token"], "image_generate", prompt="Кострома на закате", aspect="16:9")
        assert not made.get("isError"), made
        image = made["structuredContent"]["image"]
        assert image["url"].startswith("/api/uploads/") and image["model"] == "gemini-3-flash-image-preview"
        assert "gemini-3-flash-image-preview:generateContent" in sent_to[-1]

        reply = db.conn.fetch_one("SELECT props FROM core_messages WHERE id = %s", (sent["reply"]["id"],))
        assert reply["props"]["attachments"][0]["url"] == image["url"]
        chats = admin.get("/api/core/files/chats").json()
        assert chats and chats[0]["chatId"] == thread["id"] and chats[0]["count"] == 1
        files = admin.get("/api/core/files", params={"threadId": thread["id"]}).json()
        assert files[0]["url"] == image["url"] and files[0]["fileType"] == "image" and files[0]["authorName"] == "Claude"
    finally:
        _cleanup()


def test_company_passport_and_search(admin):
    """Паспорт компании — в начале каждого запуска; справочник не забивает «свежее»; поиск — с начала слова."""
    from app.modules.core_agents import memory

    uid = admin.get("/api/auth/session").json()["user"]["id"]
    try:
        memory.add_note(uid, "Юридические данные\n\nИНН 7708596369", ["о компании", "реквизиты"], "тест", shared=True)
        memory.add_note(uid, "Длинные маршруты по Карелии", ["о компании"], "тест", shared=True)
        memory.add_note(uid, "Паспорт компании\n\nТуроператор с 1995 года", ["о компании", "паспорт"], "тест", shared=True)
        memory.add_note(uid, "Свежая договорённость про отчёты", [], "тест", shared=True)
        ctx = memory.prompt_context(uid)
        assert "## О компании" in ctx and "Туроператор с 1995 года" in ctx
        fresh = ctx.split("## Свежее", 1)[1] if "## Свежее" in ctx else ""
        assert "Свежая договорённость" in fresh and "ИНН" not in fresh
        found = [n["text"] for n in memory.search_notes(uid, "ИНН")]
        assert len(found) == 1 and found[0].startswith("Юридические данные")  # «инн» не находит «длинные»
    finally:
        db.conn.execute_query("DELETE FROM core_notes WHERE actor = 'тест'")
