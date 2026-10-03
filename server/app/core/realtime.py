from __future__ import annotations

import asyncio
import json
import logging
import os
import threading as _threading
import uuid as _uuid_mod

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)


class SseManager:
    """Manages per-user SSE queues, and mirrors every push to a Redis pub/sub
    channel so WebSocket clients (subscribed directly to Redis, see
    /api/ws/{user_id}) receive the exact same events with no duplicated
    business logic. Thread-safe: push() is called from sync routes."""

    def __init__(self):
        self._queues: dict[str, list] = {}
        self._lock = _threading.Lock()
        self._loop = None  # set in lifespan
        # Номер последнего события каждого пользователя в этом процессе. Каждое
        # событие уходит в сокеты со своим номером ("seq"), приветствие и пинг
        # несут текущий. Клиент, увидев пропуск (пришло 7 после 5, пинг
        # сообщает 9, а последним было 8), сам догружает список и ленту — так
        # потеря события на живом соединении не остаётся незамеченной.
        self._seq: dict[str, int] = {}

    def current_seq(self, user_id: str) -> int:
        with self._lock:
            return self._seq.get(str(user_id), 0)

    def _stamp(self, user_id: str, payload: str) -> str:
        """Выдать событию следующий номер пользователя. Вызывать под self._lock."""
        uid = str(user_id)
        seq = self._seq.get(uid, 0) + 1
        self._seq[uid] = seq
        if len(payload) > 2 and payload[0] == '{':
            return '{"seq": %d, %s' % (seq, payload[1:])
        return payload

    def set_loop(self, loop):
        self._loop = loop

    def subscribe(self, user_id: str):
        q = asyncio.Queue()
        with self._lock:
            self._queues.setdefault(str(user_id), []).append(q)
        return q

    def unsubscribe(self, user_id: str, q):
        with self._lock:
            lst = self._queues.get(str(user_id), [])
            if q in lst:
                lst.remove(q)
            if not lst:
                self._queues.pop(str(user_id), None)

    def push(self, user_id: str, data: dict):
        """Push event to a specific user. Delivers straight to THIS process's in-memory
        queues, and publishes ONCE to Redis (tagged with this process's id) so any
        OTHER worker process can route it to its own queues via the single
        process-wide fanout subscriber (redis_fanout_loop). No per-connection Redis
        subscription is involved — that's what previously kept one idle Redis pub/sub
        connection open PER WebSocket (hundreds of them). Safe from sync context."""
        if not self._loop:
            return
        payload = json.dumps(data, ensure_ascii=False, default=str)

        with self._lock:
            queues = list(self._queues.get(str(user_id), []))
            stamped = self._stamp(user_id, payload)
        if str(data.get("type") or "").startswith("call_"):
            logger.debug(f"[calls] push type={data.get('type')} to user={user_id}: {len(queues)} local queue(s) subscribed")
        for q in queues:
            self._loop.call_soon_threadsafe(q.put_nowait, stamped)

        async def _publish():
            try:
                await redis_client.publish(
                    f"user:{user_id}",
                    json.dumps({"o": _PROCESS_ID, "p": data}, ensure_ascii=False, default=str),
                )
            except Exception as e:
                logger.warning(f"[Redis] publish failed for user {user_id}: {e}")
        self._loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_publish()))

    def deliver_local(self, user_id: str, payload: str):
        """Inject an already-serialized payload into this process's queues — used by
        the cross-process Redis fanout for events published by OTHER workers."""
        if not self._loop:
            return
        with self._lock:
            queues = list(self._queues.get(str(user_id), []))
            stamped = self._stamp(user_id, payload)
        for q in queues:
            self._loop.call_soon_threadsafe(q.put_nowait, stamped)

    def push_to_chat(self, chat: dict, exclude_user_id: str, data: dict):
        """Push event to all chat participants except the sender."""
        raw = chat.get('participant_ids') or chat.get('participantIds') or []
        # Filter out None values that come from ARRAY_AGG LEFT JOIN when chat_participants is empty
        participant_ids = [str(uid) for uid in raw if uid is not None]
        # If ARRAY_AGG returned nothing, try the stored JSON column values
        if not participant_ids:
            stored = chat.get('participantIds') or []
            participant_ids = [str(uid) for uid in stored if uid is not None]
        targets = [uid for uid in participant_ids if uid != str(exclude_user_id)]
        if not targets or not self._loop:
            return
        # Одна сериализация и одна пачка публикаций на весь чат, а не по
        # разу на участника: в общем чате на 60 человек это 60 json.dumps и
        # 60 задач в event loop — того самого, что отдаёт кадры в сокеты.
        payload = json.dumps(data, ensure_ascii=False, default=str)
        # Номер у каждого участника свой — вклеиваем его в готовую строку, без
        # повторной сериализации.
        with self._lock:
            deliveries = []
            for uid in targets:
                stamped = self._stamp(uid, payload)
                for q in self._queues.get(uid, []):
                    deliveries.append((q, stamped))
        for q, stamped in deliveries:
            self._loop.call_soon_threadsafe(q.put_nowait, stamped)
        wrapped = json.dumps({"o": _PROCESS_ID, "p": data}, ensure_ascii=False, default=str)

        async def _publish_all():
            try:
                async with redis_client.pipeline(transaction=False) as pipe:
                    for uid in targets:
                        pipe.publish(f"user:{uid}", wrapped)
                    await pipe.execute()
            except Exception as e:
                logger.warning(f"[Redis] batch publish failed for {len(targets)} users: {e}")
        self._loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_publish_all()))


sse_manager = SseManager()


_PROCESS_ID = _uuid_mod.uuid4().hex


async def redis_fanout_loop():
    """ONE Redis pub/sub connection for the whole process (was one per WebSocket).

    Subscribes to `user:*` and injects events published by OTHER worker processes
    into this process's in-memory queues, so cross-worker realtime still works with a
    single Redis connection. Skips this process's own publishes (origin tag `o`).
    On a single-worker deployment (prod) it's essentially idle — same-process delivery
    already happens directly in push() — but it keeps multi-worker correctness."""
    while True:
        pubsub = None
        try:
            pubsub = redis_client.pubsub()
            await pubsub.psubscribe("user:*")
            async for message in pubsub.listen():
                if not message or message.get("type") != "pmessage":
                    continue
                channel = message.get("channel")
                if isinstance(channel, bytes):
                    channel = channel.decode("utf-8", "replace")
                raw = message.get("data")
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", "replace")
                try:
                    wrapper = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(wrapper, dict) or wrapper.get("o") == _PROCESS_ID:
                    continue  # our own publish — already delivered to local queues
                inner = wrapper.get("p")
                if inner is None:
                    continue
                user_id = str(channel).split("user:", 1)[-1]
                sse_manager.deliver_local(user_id, json.dumps(inner, ensure_ascii=False))
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"[Redis fanout] subscriber error, retrying in 2s: {e}")
            await asyncio.sleep(2)
        finally:
            try:
                if pubsub is not None:
                    await pubsub.aclose()
            except Exception:
                pass


# max_connections bounds the pool so concurrent publish() bursts (e.g.
# push_to_chat fanning out to every group participant at once) are forced to
# reuse connections instead of growing the pool without limit — found 169
# stale, single-use, never-reused Redis connections built up in production
# from this being unbounded (redis-py's pool never proactively closes idle
# connections once created).
#
# That earlier fix (capped at 50) created a new problem: every open /api/ws/
# {user_id} connection holds ONE dedicated pubsub connection for its entire
# lifetime (a subscribed connection can't be reused for other commands until
# unsubscribed), on top of whatever regular publish()/get() traffic is using
# the same pool. On-device logs showed "[WS] Redis unavailable ... Too many
# connections" recurring every few minutes in production with only ~50
# concurrent WS sessions (a handful of staff, each on phone + desktop) — the
# pool was simply too small for real concurrent usage, not actually leaking.
# Confirmed via `redis-cli info clients`: the Redis *server's own* maxclients
# is 10000 with only ~51 connected at the time — nowhere near its real
# capacity, all the way from this client-side cap alone. Raised with plenty
# of headroom for legitimate concurrent WS sessions while still bounded
# (not reverting to unbounded, which is what caused the original 169-leak).
redis_client = aioredis.from_url(
    os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0"), decode_responses=True, max_connections=300,
)
