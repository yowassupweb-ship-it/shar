"""Сквозная проверка тёплых процессов Claude: настоящая нода + локальный API + поддельный claude.

Запуск (из server/, venv-питоном): python E:/tmp/warm/warm_e2e.py
Нужны: Postgres :55432 (shar_dev), Redis :6379 и API :8100 (E:\\tmp\\api-restart.ps1).
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

os.environ.update(DB_HOST="127.0.0.1", DB_PORT="55432", DB_USER="postgres", DB_NAME="shar_dev", REDIS_URL="redis://127.0.0.1:6379/0",
                  SHAR_SECRET_KEY="dev-secret", SHAR_DATA_DIR=str(Path(os.environ.get("TEMP", "/tmp")) / "shar-data"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "server"))
import requests  # noqa: E402

BASE = "http://127.0.0.1:8100"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
KIT = str(ROOT / "server/app/modules/core_agents/kit/shar-node.mjs")
WORK = Path(os.environ.get("TEMP", "/tmp")) / "shar-warm-e2e"
WORK.mkdir(parents=True, exist_ok=True)
LOG = str(WORK / "fake.log")
# Обёртка для запуска поддельного claude как команды (Windows — .cmd, иначе — исполняемый скрипт).
WRAPPER = WORK / ("fake-claude.cmd" if os.name == "nt" else "fake-claude")
_fake = str(HERE / "fake-claude.cjs")
NL = chr(10)
if os.name == "nt":
    WRAPPER.write_text(NL.join(["@echo off", f'node "{_fake}" %*', ""]), newline=chr(13) + chr(10))
else:
    WRAPPER.write_text(NL.join(["#!/bin/sh", f'exec node "{_fake}" "$@"', ""]))
    WRAPPER.chmod(0o755)
S = requests.Session()
assert S.post(f"{BASE}/api/auth/login", json={"username": "admin", "password": "types123"}).status_code == 200
# Кука сессии помечена Secure и по http не отправляется — подставляем вручную.
S.headers["Cookie"] = "shar_session=" + S.cookies.get("shar_session")
me = S.get(f"{BASE}/api/auth/me").json()
USER = str(me.get("id") or me.get("user", {}).get("id"))

from app.modules.core_agents import store  # noqa: E402


def journal():
    try:
        return [json.loads(x) for x in open(LOG, encoding="utf-8") if x.strip()]
    except FileNotFoundError:
        return []


def start_node(token, warm, idle_ms=2500, startup_ms=1500):
    env = {**os.environ, "SHAR_URL": BASE, "SHAR_NODE_TOKEN": token, "SHAR_NODE_HOME": str(WORK / "home"),
           "CLAUDE_COMMAND": str(WRAPPER), "FAKE_CLAUDE_LOG": LOG, "FAKE_STARTUP_MS": str(startup_ms), "FAKE_TURN_MS": "250",
           "SHAR_WARM": "1" if warm else "0", "SHAR_WARM_IDLE_MS": str(idle_ms)}
    out = open(WORK / "node.log", "w", encoding="utf-8")
    return subprocess.Popen(["node", KIT], env=env, stdout=out, stderr=subprocess.STDOUT)


def ask(thread, text, model="claude", wait=True):
    t0 = time.time()
    sent = S.post(f"{BASE}/api/core/threads/{thread}/messages", json={"id": os.urandom(8).hex(), "body": text, "model": model}).json()
    reply_id = sent["reply"]["id"]
    first = done = None
    while time.time() - t0 < 40:
        msgs = S.get(f"{BASE}/api/core/threads/{thread}/messages").json()["messages"]
        m = next((x for x in msgs if x["id"] == reply_id), None)
        if m and m["body"] and first is None:
            first = time.time() - t0
        if m and m["status"] in ("done", "failed"):
            done = time.time() - t0
            return {"first": first or done, "done": done, "status": m["status"], "body": m["body"]}
        time.sleep(0.03)
    return {"first": None, "done": None, "status": "timeout", "body": ""}


def scenario(warm):
    open(LOG, "w").close()
    created = S.post(f"{BASE}/api/core/nodes", json={"name": "warm-e2e"}).json()
    node, token = created["node"], created["token"]
    proc = start_node(token, warm)
    results = {}
    try:
        for _ in range(60):  # нода на связи и подхватила настройки
            time.sleep(0.25)
            nodes = S.get(f"{BASE}/api/core/nodes").json()["nodes"]
            if any(n["id"] == node["id"] and n["online"] for n in nodes):
                break
        store.save_account(USER, "claude", state="ready", account="fake@e2e", node_id=int(node["id"]),
                           models=[{"id": "m1", "label": "M1"}, {"id": "m2", "label": "M2"}], model="m1")
        time.sleep(1.2)
        t = S.post(f"{BASE}/api/core/threads", json={}).json()["thread"]["id"]
        results["messages"] = [ask(t, f"вопрос {i}") for i in (1, 2, 3)]
        j = journal()
        results["spawns_after_3"] = sum(1 for e in j if e["ev"] == "spawn")
        results["turn_mcp_status"] = [e["mcpStatus"] for e in j if e["ev"] == "turn"]
        results["pids_after_3"] = len({e["pid"] for e in j if e["ev"] == "turn"})
        if warm:
            # смена модели → новый процесс
            before = sum(1 for e in journal() if e["ev"] == "spawn")
            r = ask(t, "вопрос про другую модель", model="claude:m2")
            results["model_change"] = {"status": r["status"], "new_spawn": sum(1 for e in journal() if e["ev"] == "spawn") - before}
            # два сообщения подряд в один чат — по очереди, один процесс
            before_pids = {e["pid"] for e in journal() if e["ev"] == "turn"}
            a = S.post(f"{BASE}/api/core/threads/{t}/messages", json={"id": os.urandom(8).hex(), "body": "подряд А", "model": "claude:m2"}).json()["reply"]["id"]
            b = S.post(f"{BASE}/api/core/threads/{t}/messages", json={"id": os.urandom(8).hex(), "body": "подряд Б", "model": "claude:m2"}).json()["reply"]["id"]
            ok = 0
            for _ in range(200):
                msgs = {x["id"]: x for x in S.get(f"{BASE}/api/core/threads/{t}/messages").json()["messages"]}
                ok = sum(1 for i in (a, b) if msgs[i]["status"] == "done")
                if ok == 2:
                    break
                time.sleep(0.05)
            results["back_to_back_done"] = ok
            # другой чат — свой процесс
            t2 = S.post(f"{BASE}/api/core/threads", json={}).json()["thread"]["id"]
            ask(t2, "другой чат")
            results["pids_two_threads"] = len({e["pid"] for e in journal() if e["ev"] == "turn"})
            # простой → процесс закрывается, ключ отозван; следующее сообщение — новый процесс с --resume
            tokens = [e["token"] for e in journal() if e["ev"] == "spawn" and e.get("token")]
            time.sleep(4.5)
            j = journal()
            results["exited_on_idle"] = sum(1 for e in j if e["ev"] == "exit")
            results["old_token_status"] = [requests.post(f"{BASE}/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers={"Authorization": f"Bearer {x}"}).status_code for x in tokens]
            r = ask(t, "после простоя")
            last = [e for e in journal() if e["ev"] == "spawn"][-1]
            results["after_idle"] = {"status": r["status"], "resume": last["resume"] or None, "t": round(r["first"], 2)}
        return results
    finally:
        proc.terminate()
        time.sleep(0.5)
        S.delete(f"{BASE}/api/core/nodes/{node['id']}")
        proc.kill()


def show(name, r):
    print(f"\n=== {name} ===")
    for i, m in enumerate(r["messages"], 1):
        print(f"  сообщение {i}: первое слово {m['first']:.2f} с, готово {m['done']:.2f} с  [{m['status']}] {m['body'][:50]}")
    for k, v in r.items():
        if k != "messages":
            print(f"  {k}: {v}")


cold = scenario(False)
show("БЕЗ тёплого процесса (SHAR_WARM=0)", cold)
warm = scenario(True)
show("С тёплым процессом", warm)

# проверки
assert cold["spawns_after_3"] == 3 and cold["pids_after_3"] == 3, "холодный режим: процесс на каждое сообщение"
assert all(m["status"] == "done" for m in cold["messages"] + warm["messages"])
assert warm["spawns_after_3"] == 1 and warm["pids_after_3"] == 1, "тёплый: один процесс на три сообщения"
assert warm["turn_mcp_status"] == [200, 200, 200], "ключ MCP работает на каждом ходу"
assert warm["model_change"]["new_spawn"] == 1 and warm["model_change"]["status"] == "done"
assert warm["back_to_back_done"] == 2
assert warm["pids_two_threads"] >= 3
assert warm["exited_on_idle"] >= 1 and all(c in (401, 403) for c in warm["old_token_status"]), "после простоя процесс закрыт, ключи отозваны"
assert warm["after_idle"]["status"] == "done" and warm["after_idle"]["resume"], "после простоя — новый процесс с --resume"
print("\nВСЕ ПРОВЕРКИ ПРОШЛИ")
print(f"  2-е и 3-е сообщения: холодный {cold['messages'][1]['first']:.2f}/{cold['messages'][2]['first']:.2f} с, тёплый {warm['messages'][1]['first']:.2f}/{warm['messages'][2]['first']:.2f} с (старт поддельного claude = 1,5 с)")
