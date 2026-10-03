"""Тесты ходят в настоящие Postgres и Redis (по умолчанию локальные).

  SHAR_TEST_DB_HOST / _PORT / _USER / _PASSWORD — подключение к Postgres (создаётся база shar_test);
  REDIS_URL — Redis (используем базу 15, чтобы не задеть рабочие данные).
Нет сервисов — тесты пропускаются, а не падают."""

from __future__ import annotations

import os
import tempfile
import uuid

import pytest

_TMP = tempfile.mkdtemp(prefix="shar-test-")
os.environ.setdefault("DB_HOST", os.getenv("SHAR_TEST_DB_HOST", "/tmp" if os.path.exists("/tmp/.s.PGSQL.5432") else "localhost"))
os.environ.setdefault("DB_PORT", os.getenv("SHAR_TEST_DB_PORT", "5432"))
os.environ.setdefault("DB_USER", os.getenv("SHAR_TEST_DB_USER", "postgres"))
os.environ.setdefault("DB_PASSWORD", os.getenv("SHAR_TEST_DB_PASSWORD", ""))
os.environ["DB_NAME"] = "shar_test"
os.environ.setdefault("REDIS_URL", "redis://127.0.0.1:6379/15")
os.environ["SHAR_DATA_DIR"] = _TMP
os.environ["SHAR_MAIL_WATCH"] = "0"
os.environ["SHAR_SECRET_KEY"] = "test-secret"
os.environ["SHAR_INTEGRATION_API_KEY"] = "int-key"
os.environ["SHAR_INTERNAL_PUSH_KEY"] = "push-key"
os.environ["SHAR_ADMIN_ACTIONS"] = '{"echo": ["echo", "hello"]}'


def _ensure_database() -> bool:
    try:
        import psycopg2

        conn = psycopg2.connect(host=os.environ["DB_HOST"], port=os.environ["DB_PORT"], user=os.environ["DB_USER"],
                                password=os.environ["DB_PASSWORD"] or None, dbname="postgres", connect_timeout=3)
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM pg_database WHERE datname = 'shar_test'")
        if not cur.fetchone():
            cur.execute("CREATE DATABASE shar_test")
        conn.close()
        import redis

        redis.Redis.from_url(os.environ["REDIS_URL"], socket_connect_timeout=1).ping()
        return True
    except Exception:
        return False


HAVE_SERVICES = _ensure_database()
pytestmark = pytest.mark.skipif(not HAVE_SERVICES, reason="нужны Postgres и Redis")


def pytest_collection_modifyitems(config, items):
    if not HAVE_SERVICES:
        skip = pytest.mark.skip(reason="нужны Postgres и Redis")
        for item in items:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def app():
    from app.main import create_app

    return create_app()


@pytest.fixture(scope="session")
def client(app):
    import redis
    from fastapi.testclient import TestClient

    redis.Redis.from_url(os.environ["REDIS_URL"]).flushdb()
    with TestClient(app, base_url="https://testserver") as c:
        yield c


class UserClient:
    """Вошедший пользователь поверх ОДНОГО TestClient: у каждого своя кука, но общий цикл
    событий и пул потоков (отдельный TestClient на пользователя плодит потоки и
    соединения с базой)."""

    def __init__(self, base):
        self._base, self.cookies = base, {}

    def request(self, method, url, **kw):
        self._base.cookies.clear()
        for k, v in self.cookies.items():
            self._base.cookies.set(k, v)
        r = self._base.request(method, url, **kw)
        for k, v in self._base.cookies.items():
            self.cookies[k] = v
        self._base.cookies.clear()  # общий jar не должен «протекать» к анониму
        if r.status_code == 200 and url.endswith("/api/auth/logout"):
            self.cookies.clear()
        return r

    def get(self, url, **kw):
        return self.request("GET", url, **kw)

    def post(self, url, **kw):
        return self.request("POST", url, **kw)

    def put(self, url, **kw):
        return self.request("PUT", url, **kw)

    def patch(self, url, **kw):
        return self.request("PATCH", url, **kw)

    def delete(self, url, **kw):
        return self.request("DELETE", url, **kw)

    def websocket_connect(self, url, **kw):
        self._base.cookies.clear()
        for k, v in self.cookies.items():
            self._base.cookies.set(k, v)
        return self._base.websocket_connect(url, **kw)


class Users:
    """Фабрика пользователей и вошедших клиентов."""

    def __init__(self, base):
        self._base, self._clients, self.ids = base, {}, {}

    def create(self, name: str, role: str = "user", password: str = "secret-pass", **extra):
        from app.core.db import db

        uid = f"{name}-{uuid.uuid4().hex[:6]}"
        db.add_user({"id": uid, "name": name.title(), "username": uid, "email": f"{uid}@test.local", "password": password, "role": role, **extra})
        self.ids[name] = uid
        return uid

    def login(self, name: str, password: str = "secret-pass"):
        c = UserClient(self._base)
        r = c.post("/api/auth/login", json={"username": self.ids[name], "password": password})
        assert r.status_code == 200, r.text
        self._clients[name] = c
        return c


@pytest.fixture(scope="session")
def users(app, client):
    u = Users(client)
    u.create("admin", role="admin")
    u.create("anna")
    u.create("boris")
    u.create("clara")
    for n in ("admin", "anna", "boris", "clara"):
        u.login(n)
    yield u


@pytest.fixture()
def admin(users):
    return users._clients["admin"]


@pytest.fixture()
def anna(users):
    return users._clients["anna"]


@pytest.fixture()
def boris(users):
    return users._clients["boris"]


@pytest.fixture()
def clara(users):
    return users._clients["clara"]


@pytest.fixture(autouse=True)
def _anonymous_by_default(request):
    """`client` — аноним: куки пользователей хранятся в UserClient и подставляются на время запроса."""
    if "client" in request.fixturenames:
        request.getfixturevalue("client").cookies.clear()
