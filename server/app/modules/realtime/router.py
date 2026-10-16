from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor as _ThreadPoolExecutor

from fastapi import (
    APIRouter,
    BackgroundTasks,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from starlette.concurrency import run_in_threadpool

from app.core.realtime import sse_manager
from app.core.security import Identity, identity_of
from app.modules.calls.presence import (
    _call_presence_connect,
    _call_presence_disconnect_and_maybe_schedule,
    _call_presence_touch,
    _presence_mark,
)
from app.modules.chats.cache import _get_chat_cached
from app.modules.chats.messages import send_message
from app.modules.chats.receipts import mark_messages_as_read, send_typing_indicator
from app.modules.chats.schemas import MessageCreate
from app.modules.realtime import frames as chat_realtime

router = APIRouter()

logger = logging.getLogger(__name__)


def _run_background(bt: BackgroundTasks) -> None:
    for task in list(bt.tasks):
        try:
            task.func(*task.args, **task.kwargs)
        except Exception as e:
            logger.debug(f"background task failed: {e}")


_rt_after_ack = _ThreadPoolExecutor(max_workers=1, thread_name_prefix="rt-after-ack")


def _identity(user_id: str) -> Identity:
    """Личность владельца сокета: сессию сверили при подключении, имя и роль берём из базы."""
    ident = identity_of(str(user_id))
    if ident is None:
        raise chat_realtime.Rejected(403, "user disabled")
    return ident


def _rt_send(user_id: str, chat_id: str, payload: dict) -> dict:
    bt = BackgroundTasks()
    try:
        saved = send_message(chat_id, MessageCreate(authorId=user_id, **payload), bt, me=_identity(user_id))
    except HTTPException as e:
        raise chat_realtime.Rejected(e.status_code, str(e.detail))
    if bt.tasks:
        _rt_after_ack.submit(_run_background, bt)
    return saved


def _rt_read(user_id: str, chat_id: str, last_message_id: str) -> None:
    bt = BackgroundTasks()
    mark_messages_as_read(chat_id, {'lastMessageId': last_message_id}, bt, me=_identity(user_id))
    _run_background(bt)


def _rt_is_member(user_id: str, chat_id: str) -> bool:
    chat = _get_chat_cached(chat_id)
    if not chat:
        # «Избранное» создаётся при первой отправке — своё можно.
        return chat_id == f"favorites_{user_id}"
    ids = [str(x) for x in (chat.get('participant_ids') or chat.get('participantIds') or []) if x is not None]
    return user_id in ids


chat_realtime.configure(chat_realtime.Hooks(
    send=_rt_send,
    typing=lambda user_id, chat_id, body: send_typing_indicator(chat_id, body, me=_identity(user_id)),
    read=_rt_read,
    is_member=_rt_is_member,
    push_to_user=lambda user_id, event: sse_manager.push(user_id, event),
))


def _origin_allowed(websocket: WebSocket, settings) -> bool:
    """Заголовок Origin, если есть, должен указывать на этот же хост или в CORS_ORIGINS."""
    origin = websocket.headers.get("origin")
    if not origin:
        return True  # не браузер (Electron-прокси, curl) — куки у него и так свои
    host = websocket.headers.get("host", "")
    return origin in settings.cors_origins or origin.split("://", 1)[-1] == host


@router.websocket("/api/ws/{user_id}")
async def ws_stream(websocket: WebSocket, user_id: str):
    """WebSocket real-time endpoint. Every socket reads THIS process's in-memory
    queue; SseManager.push() delivers same-process events straight to it, and the
    single process-wide fanout subscriber (_redis_fanout_loop) injects cross-worker
    events. This replaced one Redis pub/sub connection PER socket (hundreds of idle
    Redis clients on a busy day) with exactly one for the whole process."""
    # Сокет мимо HTTP-middleware, поэтому сессию проверяем здесь, по куке рукопожатия:
    # подписаться можно только на СВОЙ поток (чужой — это чужая переписка в реальном
    # времени). Отказ — после accept: иначе браузер видит обрыв (1006) и бесконечно
    # переподключается, а по 1008 клиент перепроверит сессию и покажет вход.
    settings = websocket.app.state.settings
    if settings.enforce_auth:
        reason = None
        if not _origin_allowed(websocket, settings):
            reason = "origin"
        else:
            cookie_header = websocket.headers.get("cookie", "")
            ident = await websocket.app.state.verifier.identity(cookie_header)
            if ident is None:
                reason = "session:no-identity cookie=%s" % ("yes" if cookie_header else "none")
            elif ident.user_id != str(user_id):
                reason = "session:mismatch owner=%s" % ident.user_id
        if reason:
            await websocket.accept()
            await websocket.close(code=1008)
            logger.warning("[ws] rejected subscribe to %s (%s) ua=%s", user_id, reason, (websocket.headers.get("user-agent") or "-")[:60])
            return

    await websocket.accept()
    # Счётчик присутствия — синхронный Redis; в пуле, чтобы подключение одного
    # клиента не придерживало доставку всем остальным.
    conn_id = uuid.uuid4().hex
    connections = await run_in_threadpool(_call_presence_connect, user_id, conn_id)
    # Первый сокет человека — он «в сети»: сразу всем, кто подключён.
    if connections == 1:
        await run_in_threadpool(_presence_mark, user_id, True)
    local_queue = sse_manager.subscribe(user_id)
    local_queue.put_nowait(json.dumps({**chat_realtime.HELLO, 'seq': sse_manager.current_seq(user_id)}))
    logger.debug("ws subscribed user=%s, now %d queue(s)", user_id, len(sse_manager._queues.get(str(user_id), [])))

    async def sender():
        touched_at = time.monotonic()
        while True:
            try:
                payload = await asyncio.wait_for(local_queue.get(), timeout=20.0)
                await websocket.send_text(payload)
            except asyncio.TimeoutError:
                # Пинг несёт номер последнего события: клиент сверит его со своим.
                await websocket.send_text('{"type":"ping","seq":%d}' % sse_manager.current_seq(user_id))
            # Живой сокет продлевает аренду присутствия (см. _call_presence_touch);
            # оборвавшийся перестаёт её продлевать и сам пропадает из «в сети».
            if time.monotonic() - touched_at > 15:
                touched_at = time.monotonic()
                await run_in_threadpool(_call_presence_touch, user_id, conn_id)

    async def receiver():
        # Клиент шлёт по этому же сокету отправку сообщений, «печатает» и
        # «прочитано» — без HTTP-запроса, прокси и очереди за потоком.
        # Ответ на отправку (ack/nack) кладём в очередь этого сокета — его
        # отправит sender(), чтобы два отправителя не писали в сокет разом.
        while True:
            # Кадр может прийти и бинарным: прокси десктопа до 0.2.79 пересылал
            # текст как байты, а receive_text() на таком кадре падал и рвал сокет.
            msg = await websocket.receive()
            if msg.get('type') == 'websocket.disconnect':
                raise WebSocketDisconnect(msg.get('code') or 1000)
            raw = msg.get('text')
            if raw is None and msg.get('bytes') is not None:
                try:
                    raw = msg['bytes'].decode('utf-8')
                except Exception:
                    continue
            if not raw or raw[0] != '{':
                continue
            try:
                frame = json.loads(raw)
            except Exception:
                continue
            if not isinstance(frame, dict) or frame.get('type') not in chat_realtime.FRAME_TYPES:
                continue
            reply = await run_in_threadpool(chat_realtime.handle_frame, str(user_id), frame)
            if reply is not None:
                local_queue.put_nowait(json.dumps(reply, ensure_ascii=False))

    sender_task = asyncio.ensure_future(sender())
    receiver_task = asyncio.ensure_future(receiver())
    try:
        done, pending = await asyncio.wait(
            [sender_task, receiver_task], return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        # Cancelling a task only *schedules* the CancelledError — await the pending
        # ones so they actually unwind (and release the local queue's get()) before
        # the finally-block unsubscribe runs, rather than after this handler returns.
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            exc = task.exception()
            if exc:
                raise exc
    except WebSocketDisconnect:
        logger.debug("ws disconnect user=%s", user_id)
    except Exception as e:
        logger.warning(f"[WS] stream error for user {user_id}: {e}")
    finally:
        logger.debug("ws unsubscribing user=%s", user_id)
        sse_manager.unsubscribe(user_id, local_queue)
        await run_in_threadpool(_call_presence_disconnect_and_maybe_schedule, user_id, None, conn_id)
