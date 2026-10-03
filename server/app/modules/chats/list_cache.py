"""Кэш списка чатов пользователя (GET /api/chats) с точной инвалидацией.

Зачем. Список чатов — самый дорогой ответ сервера (~57 КБ JSON на человека), а
старые клиенты перезапрашивают его на каждое событие сокета, причём из двух-трёх
мест сразу (сервис уведомлений, лента, мини-чат). Одно сообщение в общем чате на
44 человека давало пачку из десятков одинаковых расчётов в одну секунду; на
одном ядре сервера они выстраивались в очередь, и за ними ждала отправка самих
сообщений — «сообщение уходит не сразу».

Как. У каждого пользователя свой номер версии. Любая запись, меняющая чат или
его сообщения (db.add_message, update_chat, create_chat, delete_chat …),
повышает версию всех участников этого чата. Ответ берётся из кэша, только если
версия не изменилась с момента расчёта и он не старше MAX_AGE. Одинаковые
запросы, пришедшие одновременно, считаются один раз (single-flight): остальные
ждут готовый результат.

Модуль не импортирует main.py: участников чата он узнаёт через configure().
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, Iterable, Optional, Tuple

logger = logging.getLogger(__name__)

# Страховка на записи в обход обёрнутых методов (сырой SQL в эндпоинтах):
# дольше этого ответ не живёт в любом случае.
MAX_AGE = 20.0
# Сколько ждать чужой расчёт того же списка, прежде чем считать самим.
WAIT_OTHER = 15.0

_lock = threading.Lock()
_user_gen: Dict[str, int] = {}
_global_gen = 0
# (user_id, variant) -> (result, user_gen, global_gen, created_at)
_entries: Dict[Tuple[str, str], Tuple[Any, int, int, float]] = {}
# (user_id, variant) -> Event, пока идёт расчёт
_inflight: Dict[Tuple[str, str], threading.Event] = {}

_participants_of: Optional[Callable[[str], Iterable[str]]] = None


def configure(participants_of: Callable[[str], Iterable[str]]) -> None:
    """participants_of(chat_id) -> id участников (из кэша чатов приложения)."""
    global _participants_of
    _participants_of = participants_of


# ── Инвалидация ──────────────────────────────────────────────────────────────

def bump_users(user_ids: Iterable[Any]) -> None:
    with _lock:
        for uid in user_ids:
            if uid is None:
                continue
            key = str(uid)
            _user_gen[key] = _user_gen.get(key, 0) + 1


def bump_all() -> None:
    """Запись, по которой не понять, чьи списки затронуты, — сбрасываем всё."""
    global _global_gen
    with _lock:
        _global_gen += 1


def bump_chat(chat_id: Any, extra: Iterable[Any] = ()) -> None:
    ids = list(extra)
    if chat_id is not None and _participants_of is not None:
        try:
            ids.extend(_participants_of(str(chat_id)) or [])
        except Exception as e:  # участников не узнали — сбросим всех, но не сломаем запись
            logger.debug(f"[chat_list_cache] participants lookup failed for {chat_id}: {e}")
            bump_all()
            return
    if ids:
        bump_users(ids)
    else:
        bump_all()


def _participants_in(data: Any) -> list:
    if not isinstance(data, dict):
        return []
    return list(data.get('participant_ids') or data.get('participantIds') or [])


def wrap_db(db: Any) -> None:
    """Оборачивает методы записи db так, чтобы они сбрасывали затронутые списки.

    Версия повышается ПОСЛЕ записи: расчёт, начатый до неё, сохранится со
    старой версией и не будет выдан как свежий.
    """
    def wrap(name: str, after: Callable[..., None]) -> None:
        original = getattr(db, name, None)
        if original is None or getattr(original, '_chat_list_cache', False):
            return

        def wrapped(*args, **kwargs):
            result = original(*args, **kwargs)
            try:
                after(result, *args, **kwargs)
            except Exception as e:
                logger.debug(f"[chat_list_cache] invalidate after {name} failed: {e}")
                bump_all()
            return result

        wrapped._chat_list_cache = True  # type: ignore[attr-defined]
        setattr(db, name, wrapped)

    # update_chat(chat_id, data): новые участники тоже должны увидеть чат.
    wrap('update_chat', lambda _r, chat_id, data=None, *a, **k: bump_chat(chat_id, _participants_in(data)))
    wrap('merge_user_map', lambda _r, chat_id, *a, **k: bump_chat(chat_id))
    wrap('create_chat', lambda r, chat, *a, **k: bump_chat(None, _participants_in(chat) or _participants_in(r)))
    wrap('delete_chat', lambda _r, chat_id, *a, **k: bump_chat(chat_id))
    # Участник добавлен или удалён — его список меняется тоже (удалённого уже
    # нет в участниках чата, поэтому передаём его явно).
    wrap('add_chat_participant', lambda _r, chat_id, user_id, *a, **k: bump_chat(chat_id, [user_id]))
    wrap('remove_chat_participant', lambda _r, chat_id, user_id, *a, **k: bump_chat(chat_id, [user_id]))
    wrap('add_message', lambda _r, message, *a, **k: bump_chat((message or {}).get('chat_id') or (message or {}).get('chatId')))
    # По id сообщения чат не узнать без запроса — сбрасываем всех (правка и
    # удаление редки по сравнению с чтением списка).
    wrap('update_message', lambda *_a, **_k: bump_all())
    wrap('delete_message', lambda *_a, **_k: bump_all())


# ── Чтение ───────────────────────────────────────────────────────────────────

def get_or_compute(user_id: str, variant: str, compute: Callable[[], Any]) -> Any:
    key = (str(user_id), variant)
    while True:
        with _lock:
            gen = _user_gen.get(key[0], 0)
            ggen = _global_gen
            entry = _entries.get(key)
            if entry and entry[1] == gen and entry[2] == ggen and time.monotonic() - entry[3] < MAX_AGE:
                return entry[0]
            waiter = _inflight.get(key)
            if waiter is None:
                waiter = threading.Event()
                _inflight[key] = waiter
                mine = True
            else:
                mine = False
        if mine:
            break
        # Тот же список уже считается — ждём его вместо второго расчёта.
        if not waiter.wait(WAIT_OTHER):
            return compute()

    try:
        result = compute()
        with _lock:
            _entries[key] = (result, gen, ggen, time.monotonic())
            # Не даём кэшу расти без предела (уволенные, разовые входы).
            if len(_entries) > 2000:
                oldest = sorted(_entries.items(), key=lambda kv: kv[1][3])[:500]
                for k, _v in oldest:
                    _entries.pop(k, None)
        return result
    finally:
        with _lock:
            done = _inflight.pop(key, None)
        if done is not None:
            done.set()
