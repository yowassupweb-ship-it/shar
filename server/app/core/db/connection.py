"""Подключение к PostgreSQL: по соединению на поток, повтор при обрыве, прерывание зависших запросов."""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("shar.db")

try:
    import psycopg as psycopg_module  # psycopg3 — предпочтительно
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb as Json
    PSYCOPG_VERSION = 3
    RealDictCursor = None  # type: ignore[assignment]
except ImportError:
    import psycopg2 as psycopg_module  # type: ignore[no-redef]
    from psycopg2.extras import Json, RealDictCursor  # type: ignore[no-redef]
    PSYCOPG_VERSION = 2
    dict_row = None  # type: ignore[assignment]

logger.debug("psycopg%d", PSYCOPG_VERSION)

__all__ = ["Json", "RealDictCursor", "dict_row", "PSYCOPG_VERSION", "psycopg_module", "PostgresConnection", "slugify_department"]


def slugify_department(name: Optional[str]) -> str:
    """Canonical department name -> stable id normalization.

    Used both to derive ids for the departments table and as a normalization
    fallback when comparing legacy department values stored before the
    departments table existed.
    """
    if not name:
        return ''
    return name.strip().lower().replace('ё', 'е').replace(' ', '_')


class PostgresConnection:
    """PostgreSQL connection wrapper with per-thread connections.

    Each OS thread (FastAPI ThreadPoolExecutor worker) gets its own psycopg2
    connection, so concurrent requests never share a connection and never
    serialize on the same socket.
    """

    # Circuit breaker: after a failed connect attempt, skip retries for this many seconds.
    _BACKOFF_SECONDS = 5
    _backoff_until: float = 0  # class-level, shared across all instances/threads
    _backoff_lock = threading.Lock()

    def __init__(
        self,
        host: str = os.getenv('DB_HOST', 'localhost'),
        port: int = int(os.getenv('DB_PORT', '5432')),
        database: str = os.getenv('DB_NAME', 'shar_messenger'),
        user: str = os.getenv('DB_USER', 'postgres'),
        password: str = os.getenv('DB_PASSWORD', '')
    ):
        self.host = host
        self.port = port
        self.database = database
        self.user = user
        self.password = password
        self._local = threading.local()  # per-thread state
        # Startup connection (used for DDL and initial checks)
        self.connection = None

    # A per-thread connection can go dead without ever raising: the remote end (or a
    # NAT/firewall in between) can drop the socket without a clean FIN/RST, and plain
    # TCP has no way to notice on its own until the OS's default idle timeout (hours,
    # sometimes never on Windows). Without keepalives, a query on that connection just
    # hangs forever instead of failing — the thread (and its slot in the capped
    # ThreadPoolExecutor pool) is then stuck for the life of the process, since
    # `conn.closed` still reads False. Keepalives bound that hang to ~30-40s; a
    # statement_timeout bounds the other failure mode (a query that's slow/stuck on the
    # server side) so a single bad query can't hold the thread hostage indefinitely either.
    _KEEPALIVE_PARAMS = dict(
        keepalives=1,
        keepalives_idle=15,
        keepalives_interval=5,
        keepalives_count=3,
    )
    _STATEMENT_TIMEOUT_MS = int(os.getenv('DB_STATEMENT_TIMEOUT_MS', '30000'))

    def _make_connection(self):
        """Create a brand-new psycopg2/psycopg3 connection."""
        if PSYCOPG_VERSION == 3:
            conn = psycopg_module.connect(
                host=self.host, port=self.port,
                dbname=self.database, user=self.user, password=self.password,
                autocommit=True, row_factory=dict_row,
                connect_timeout=5,
                options=f'-c statement_timeout={self._STATEMENT_TIMEOUT_MS}',
                **self._KEEPALIVE_PARAMS,
            )
        else:
            os.environ['PGPASSFILE'] = 'nul'
            os.environ['PGCLIENTENCODING'] = 'UTF8'
            keepalive_dsn = ' '.join(f'{k}={v}' for k, v in self._KEEPALIVE_PARAMS.items())
            dsn = (f"host={self.host} port={self.port} dbname={self.database} "
                   f"user={self.user} password={self.password} client_encoding=UTF8"
                   f" connect_timeout=5 {keepalive_dsn}"
                   f" options='-c statement_timeout={self._STATEMENT_TIMEOUT_MS}'")
            conn = psycopg_module.connect(dsn)
            conn.set_client_encoding('UTF8')
            conn.autocommit = True
        return conn

    def _get_thread_conn(self):
        """Return the connection for the current thread, creating one if needed."""
        conn = getattr(self._local, 'conn', None)
        if conn is None or conn.closed:
            # Circuit breaker: if a recent connect attempt failed, fail fast.
            now = time.monotonic()
            if now < PostgresConnection._backoff_until:
                remaining = PostgresConnection._backoff_until - now
                raise RuntimeError(
                    f"DB connection unavailable (retry in {remaining:.0f}s) — "
                    f"host={self.host}:{self.port}"
                )
            try:
                conn = self._make_connection()
                self._local.conn = conn
                # Reset backoff on success
                with PostgresConnection._backoff_lock:
                    PostgresConnection._backoff_until = 0
            except Exception as e:
                with PostgresConnection._backoff_lock:
                    PostgresConnection._backoff_until = time.monotonic() + PostgresConnection._BACKOFF_SECONDS
                logger.error(f"DB reconnect failed: {e}", exc_info=True)
                raise
        return conn

    def connect(self) -> bool:
        """Establish the startup connection (used for DDL)."""
        try:
            self.connection = self._make_connection()
            logger.info("Connected to PostgreSQL (psycopg%d): %s@%s:%s/%s", PSYCOPG_VERSION, self.user, self.host, self.port, self.database)
            with PostgresConnection._backoff_lock:
                PostgresConnection._backoff_until = 0
            return True
        except Exception as e:
            logger.error(f"Failed to connect to PostgreSQL: {e}", exc_info=True)
            with PostgresConnection._backoff_lock:
                PostgresConnection._backoff_until = time.monotonic() + PostgresConnection._BACKOFF_SECONDS
            return False

    def disconnect(self):
        """Close the startup connection."""
        if self.connection:
            self.connection.close()

    def is_connected(self) -> bool:
        return bool(self.connection and not self.connection.closed)

    def ensure_connection(self):
        # No-op: per-thread connections are created on demand in _get_thread_conn
        pass

    def _recover_broken_connection(self):
        """Try to clear the aborted-transaction state on the current thread's
        connection; if the connection itself is dead (e.g. the remote server
        closed it), drop it so _get_thread_conn() makes a fresh one next call.

        Without this, a thread whose connection dies (idle-timeout on the
        remote host, network blip, etc.) keeps reusing that same dead
        connection forever — every future query on that thread fails
        silently (fetch_all/fetch_one just returned []/None), which looked
        like the app randomly and permanently losing data mid-session until
        the whole process restarted.
        """
        conn = getattr(self._local, 'conn', None)
        if not conn:
            return
        # Try the Python rollback method first (works when autocommit=False).
        # In autocommit=True mode this raises ProgrammingError, so fall back
        # to issuing a ROLLBACK SQL statement, which always clears the
        # "current transaction is aborted" state in PostgreSQL.
        try:
            conn.rollback()
        except Exception:
            try:
                with conn.cursor() as cur:
                    cur.execute("ROLLBACK")
            except Exception:
                # Connection is truly broken — drop it so the next call reconnects.
                try:
                    conn.close()
                except Exception:
                    pass
                self._local.conn = None

    # Признаки того, что упало само соединение, а не запрос. Полагаться на то,
    # что _recover_broken_connection «уронит» его сам, нельзя: на уже мёртвом
    # соединении rollback() иногда проходит молча, соединение остаётся в пуле
    # потока, повтор не запускается — и запрос возвращает пустой результат.
    # Для логина это выглядело как «неверный пароль» при верном пароле.
    _CONNECTION_ERROR_MARKERS = (
        'ssl syscall error',
        'eof detected',
        'server closed the connection',
        'connection already closed',
        'consuming input failed',
        'connection is closed',
        'terminating connection',
        'bad connection',
    )

    def _is_connection_error(self, exc: Exception) -> bool:
        for cls_name in ('OperationalError', 'InterfaceError', 'AdminShutdown'):
            cls = getattr(psycopg_module, cls_name, None)
            if cls is not None and isinstance(exc, cls):
                return True
        text = str(exc).lower()
        return any(marker in text for marker in self._CONNECTION_ERROR_MARKERS)

    def _drop_thread_conn(self) -> None:
        conn = getattr(self._local, 'conn', None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        self._local.conn = None

    def _run(self, query: str, params: tuple, mode: str):
        """Выполняет запрос, переподключаясь один раз, если соединение умерло.

        Раньше при обрыве соединения (перезапуск Postgres на сервере, разрыв
        SSL, idle-timeout) запрос просто возвращал []/None/False. Для вызвавшего
        это неотличимо от «данных нет»: например, логин получал пустого
        пользователя и отвечал «неверный пароль», хотя пароль был верный.
        _recover_broken_connection уже умеет выбрасывать мёртвое соединение —
        не хватало повторной попытки на свежем.
        """
        attempts = 2
        last_error: Optional[Exception] = None
        for attempt in range(attempts):
            try:
                conn = self._get_thread_conn()
                if mode == 'exec':
                    with conn.cursor() as cursor:
                        cursor.execute(query, params or ())
                        return True
                cursor_ctx = (conn.cursor() if PSYCOPG_VERSION == 3
                              else conn.cursor(cursor_factory=RealDictCursor))
                with cursor_ctx as cursor:
                    cursor.execute(query, params or ())
                    return cursor.fetchall() if mode == 'all' else cursor.fetchone()
            except Exception as e:
                last_error = e
                if self._is_connection_error(e):
                    # Соединение мертво — выбрасываем его принудительно, чтобы
                    # _get_thread_conn на следующей попытке открыл новое.
                    self._drop_thread_conn()
                    if attempt + 1 < attempts:
                        logger.warning(f"DB connection lost, reconnecting and retrying: {e}")
                        continue
                else:
                    # Обычная ошибка запроса: чистим состояние транзакции, но
                    # повторять смысла нет — повторится и ошибка.
                    self._recover_broken_connection()
                break

        logger.error(f"Query {mode} error: {last_error}", exc_info=True)
        return False if mode == 'exec' else ([] if mode == 'all' else None)

    def execute_query(self, query: str, params: tuple = None) -> bool:
        """Execute INSERT/UPDATE/DELETE query using the calling thread's connection."""
        return self._run(query, params, 'exec')

    def fetch_all(self, query: str, params: tuple = None) -> List[Dict[str, Any]]:
        """Fetch all results using the calling thread's connection."""
        return self._run(query, params, 'all')

    def fetch_one(self, query: str, params: tuple = None) -> Optional[Dict[str, Any]]:
        """Fetch one result using the calling thread's connection."""
        return self._run(query, params, 'one')

    def execute_batch(self, query: str, data: List[tuple]) -> bool:
        """Execute batch INSERT/UPDATE/DELETE using the calling thread's connection."""
        conn = self._get_thread_conn()
        try:
            with conn.cursor() as cursor:
                for params in data:
                    cursor.execute(query, params)
                return True
        except Exception as e:
            logger.error(f"Batch execution error: {e}", exc_info=True)
            self._recover_broken_connection()
            return False
    
    def table_exists(self, table_name: str) -> bool:
        """Check if table exists in database"""
        query = """
            SELECT EXISTS(
                SELECT 1 FROM information_schema.tables 
                WHERE table_name = %s
            )
        """
        result = self.fetch_one(query, (table_name,))
        return result['exists'] if result else False
    
    def execute_sql_file(self, file_path: str) -> bool:
        """Execute SQL script from file"""
        conn = self._get_thread_conn()
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                sql_script = f.read()
            with conn.cursor() as cursor:
                cursor.execute(sql_script)
                return True
        except Exception as e:
            logger.error(f"Error executing SQL script: {e}", exc_info=True)
            return False
