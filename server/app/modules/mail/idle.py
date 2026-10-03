"""Почта в реальном времени: сервер сам следит за ящиками.

Раньше письма забирала открытая вкладка почты — раз в 30 секунд просила сервер
сходить на IMAP, и каждый раз это было новое подключение с TLS и логином. Почта
не открыта — письма не приходили вовсе.

Здесь на каждый ящик — один поток с постоянным IMAP-соединением:
  - IDLE (Python 3.14+, imaplib.IMAP4.idle): сервер сам говорит «новое письмо»,
    письмо у нас через секунды;
  - без IDLE — то же соединение и лёгкий NOOP раз в POLL_SECONDS: сервер
    отвечает на него накопившимися новостями (EXISTS / FETCH / EXPUNGE).

Новое письмо → hooks.on_new(account) (забрать, разложить, разослать в сокет).
Флаги/удаление на другом устройстве → hooks.on_changed(account).

Модуль не импортирует main.py: всё нужное передаётся через configure(), как в
chat_realtime.py, — его можно вынести в отдельный сервис.
"""

from __future__ import annotations

import imaplib
import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

IDLE_SECONDS = 25 * 60     # RFC 2177: переоткрывать IDLE раньше 29 минут
POLL_SECONDS = 20          # запасной путь без IDLE
BACKOFF_MAX = 300
CONNECT_TIMEOUT = 30


@dataclass
class Hooks:
    # Все ящики (строки email_accounts) — для запуска при старте.
    accounts: Callable[[], List[dict]]
    # Один ящик по id — свежие настройки при каждом переподключении.
    account: Callable[[str], Optional[dict]]
    # Пароль ящика в открытом виде.
    password: Callable[[dict], str]
    # Появились новые письма во входящих.
    on_new: Callable[[dict], None]
    # Изменились флаги или письма удалены (например, прочитали на телефоне).
    on_changed: Callable[[dict], None]


_hooks: Optional[Hooks] = None
_watchers: Dict[str, '_Watcher'] = {}
_lock = threading.Lock()


def configure(hooks: Hooks) -> None:
    global _hooks
    _hooks = hooks


def enabled() -> bool:
    # Локальный бэкенд пишет в ту же базу, что и прод, — второй наблюдатель за
    # тем же ящиком не нужен. SHAR_MAIL_WATCH=0 выключает.
    return os.getenv('SHAR_MAIL_WATCH', '1').strip().lower() not in ('0', 'false', 'no')


def start_all() -> int:
    if _hooks is None or not enabled():
        return 0
    started = 0
    for acc in _hooks.accounts() or []:
        if ensure(str(acc.get('id'))):
            started += 1
    return started


def ensure(account_id: str) -> bool:
    """Запустить (или перезапустить с новыми настройками) наблюдение за ящиком."""
    if _hooks is None or not enabled() or not account_id:
        return False
    with _lock:
        old = _watchers.pop(account_id, None)
        if old:
            old.stop()
        w = _Watcher(account_id)
        _watchers[account_id] = w
    w.start()
    return True


def stop(account_id: str) -> None:
    with _lock:
        w = _watchers.pop(account_id, None)
    if w:
        w.stop()


def stop_all() -> None:
    with _lock:
        items = list(_watchers.values())
        _watchers.clear()
    for w in items:
        w.stop()


def status() -> List[dict]:
    with _lock:
        return [w.describe() for w in _watchers.values()]


def _connect(acc: dict, password: str) -> imaplib.IMAP4:
    host = acc['imap_host']
    port = int(acc.get('imap_port') or 993)
    if port == 993:
        conn = imaplib.IMAP4_SSL(host, port, timeout=CONNECT_TIMEOUT)
    else:
        conn = imaplib.IMAP4(host, port, timeout=CONNECT_TIMEOUT)
        if acc.get('use_ssl', True):
            conn.starttls()
    conn.login(acc['username'], password)
    return conn


def _keepalive(conn: imaplib.IMAP4) -> None:
    """Мёртвое соединение (сон ноутбука, NAT) без keepalive висело бы в IDLE
    вечно: ядро само проверит его через ~2 минуты тишины и оборвёт чтение."""
    import socket as _socket
    try:
        s = conn.sock
        s.setsockopt(_socket.SOL_SOCKET, _socket.SO_KEEPALIVE, 1)
        for opt, val in (('TCP_KEEPIDLE', 60), ('TCP_KEEPINTVL', 20), ('TCP_KEEPCNT', 3)):
            if hasattr(_socket, opt):
                s.setsockopt(_socket.IPPROTO_TCP, getattr(_socket, opt), val)
    except Exception:
        pass


class _Watcher(threading.Thread):
    def __init__(self, account_id: str):
        super().__init__(name=f"mail-watch-{account_id[:8]}", daemon=True)
        self.account_id = account_id
        self._stop = threading.Event()
        self._conn: Optional[imaplib.IMAP4] = None
        self.mode = 'starting'
        self.last_event_at = 0.0
        self.last_error = ''
        self._exists = 0  # писем во входящих — новость только в росте числа

    def describe(self) -> dict:
        return {
            'accountId': self.account_id, 'mode': self.mode, 'alive': self.is_alive(),
            'lastEventAgo': round(time.time() - self.last_event_at) if self.last_event_at else None,
            'lastError': self.last_error,
        }

    def stop(self) -> None:
        self._stop.set()
        conn = self._conn
        if conn is not None:
            # Разбудить поток, висящий в чтении сокета.
            try:
                conn.shutdown()
            except Exception:
                pass

    def run(self) -> None:
        backoff = 5
        while not self._stop.is_set():
            try:
                self._session()
                backoff = 5
            except Exception as e:
                if self._stop.is_set():
                    break
                self.last_error = str(e)[:200]
                self.mode = 'reconnecting'
                logger.warning(f"[mail-watch] {self.account_id}: {e}; повтор через {backoff} с")
                self._stop.wait(backoff)
                backoff = min(backoff * 2, BACKOFF_MAX)
            finally:
                conn, self._conn = self._conn, None
                if conn is not None:
                    try:
                        conn.logout()
                    except Exception:
                        pass
        self.mode = 'stopped'

    def _fire(self, kind: str, acc: dict) -> None:
        self.last_event_at = time.time()
        try:
            (_hooks.on_new if kind == 'new' else _hooks.on_changed)(acc)
        except Exception as e:
            logger.warning(f"[mail-watch] {self.account_id}: обработка '{kind}' упала: {e}")

    def _session(self) -> None:
        acc = _hooks.account(self.account_id)
        if not acc:
            self._stop.set()
            return
        conn = _connect(acc, _hooks.password(acc))
        self._conn = conn
        typ, data = conn.select('INBOX', readonly=True)
        try:
            self._exists = int((data or [b'0'])[0] or 0)
        except (TypeError, ValueError):
            self._exists = 0
        conn.untagged_responses.clear()
        # После (пере)подключения — один раз догнать всё, что пришло без нас.
        self._fire('new', acc)
        self._fire('changed', acc)
        has_idle = 'IDLE' in conn.capabilities
        if has_idle and hasattr(conn, 'idle'):
            wait, self.mode = self._wait_idle, 'idle'
        elif has_idle:
            # Python до 3.14 (на проде 3.12): своя реализация IDLE.
            _keepalive(conn)
            wait, self.mode = self._wait_idle_manual, 'idle'
        else:
            wait, self.mode = self._wait_poll, 'poll'
        while not self._stop.is_set():
            kinds = wait(conn)
            if 'new' in kinds:
                self._fire('new', acc)
            if 'changed' in kinds:
                self._fire('changed', acc)

    def _wait_idle(self, conn: imaplib.IMAP4) -> set:
        kinds: set = set()
        with conn.idle(duration=IDLE_SECONDS) as idler:
            for typ, _data in idler:
                t = (typ or '').upper() if isinstance(typ, str) else str(typ).upper()
                if t == 'EXISTS':
                    kinds.add('new')
                elif t in ('EXPUNGE', 'FETCH', 'VANISHED'):
                    kinds.add('changed')
                if kinds:
                    # Короткая пачка следом (несколько писем разом) — одной обработкой.
                    break
        return kinds

    def _wait_idle_manual(self, conn: imaplib.IMAP4) -> set:
        """IDLE (RFC 2177) на imaplib без .idle(): команда IDLE, затем блокирующее
        чтение строк до новости; DONE — по новости или по таймеру (25 мин).
        Чтение без таймаута: таймаут посреди чтения ломает буфер сокета, а мёртвое
        соединение и так оборвёт keepalive ядра (_keepalive)."""
        tag = conn._new_tag()
        conn.send(tag + b' IDLE\r\n')
        conn.sock.settimeout(CONNECT_TIMEOUT)
        first = conn._get_line()
        if not first.startswith(b'+'):
            raise ConnectionError(f'IDLE rejected: {first[:80]!r}')
        conn.sock.settimeout(None)
        done = threading.Event()

        def send_done() -> None:
            if not done.is_set():
                done.set()
                try:
                    conn.send(b'DONE\r\n')
                except Exception:
                    pass

        timer = threading.Timer(IDLE_SECONDS, send_done)
        timer.daemon = True
        timer.start()
        kinds: set = set()
        try:
            while True:
                line = conn._get_line()
                if line.startswith(tag):
                    break  # ответ на DONE — IDLE завершён
                up = line.upper()
                if up.endswith(b' EXISTS'):
                    try:
                        count = int(up.split()[1])
                    except (IndexError, ValueError):
                        count = self._exists + 1
                    if count > self._exists:
                        kinds.add('new')
                    self._exists = count
                elif up.endswith(b' EXPUNGE') or b' FETCH ' in up or up.startswith(b'* VANISHED'):
                    kinds.add('changed')
                    if up.endswith(b' EXPUNGE'):
                        self._exists = max(0, self._exists - 1)
                if kinds:
                    send_done()
        finally:
            timer.cancel()
            conn.sock.settimeout(CONNECT_TIMEOUT)
        return kinds

    def _wait_poll(self, conn: imaplib.IMAP4) -> set:
        if self._stop.wait(POLL_SECONDS):
            return set()
        typ, _ = conn.noop()
        if typ != 'OK':
            raise ConnectionError('NOOP failed')
        kinds: set = set()
        # EXISTS приходит и без новых писем — новость только в росте числа.
        exists = conn.untagged_responses.pop('EXISTS', None)
        if exists:
            try:
                count = int(exists[-1])
            except (TypeError, ValueError):
                count = self._exists
            if count > self._exists:
                kinds.add('new')
            elif count < self._exists:
                kinds.add('changed')
            self._exists = count
        for key in ('EXPUNGE', 'FETCH'):
            if conn.untagged_responses.pop(key, None):
                kinds.add('changed')
        conn.untagged_responses.pop('RECENT', None)
        return kinds
