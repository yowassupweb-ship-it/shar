"""Мгновенная переписка по WebSocket: отправка, «печатает», «прочитано».

Модуль самодостаточен и не импортирует main.py: всё, что ему нужно от
приложения (сохранить сообщение, разослать событие, найти чат…), передаётся
через configure(). Поэтому его можно вынести в отдельный сервис, заменив
только эти зависимости.

Протокол (кадры JSON в уже открытом сокете /api/ws/{user_id}):

  клиент → сервер
    {"type": "send",   "id": <uuid>, "chatId", "content", "replyToId"?,
                       "attachments"?, "metadata"?, "authorName"?}
    {"type": "typing", "chatId", "isTyping", "kind"?, "userName"?}
    {"type": "read",   "chatId", "lastMessageId"}

  сервер → клиент (в тот же сокет)
    {"type": "ack",  "id", "message"}         — сохранено, message — итог
    {"type": "nack", "id", "status", "error"} — не сохранено

id сообщения задаёт клиент (UUID): пузырь на экране сразу с окончательным
id, повтор той же отправки узнаётся по первичному ключу и не удваивается.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

_UUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')

FRAME_TYPES = ('send', 'typing', 'read')

# Первый кадр после подключения: клиент шлёт по сокету, только увидев его.
# Со старым сервером (без этого модуля) клиент сразу идёт по HTTP.
HELLO = {'type': 'hello', 'features': list(FRAME_TYPES)}


def valid_client_message_id(value: Optional[str]) -> Optional[str]:
    """Клиентский id принимаем только в виде UUID — иначе сервер задаст свой."""
    if value and _UUID_RE.match(str(value)):
        return str(value).lower()
    return None


class Rejected(Exception):
    """Отказ по существу (нет доступа, кривой запрос) — клиент не повторяет."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass
class Hooks:
    # Сохранить сообщение и разослать участникам; вернуть итоговое сообщение
    # (camelCase). Бросает Rejected при отказе по существу.
    send: Callable[[str, str, Dict[str, Any]], Dict[str, Any]]
    # Разослать «печатает» участникам чата.
    typing: Callable[[str, str, Dict[str, Any]], None]
    # Отметить прочитанным до сообщения.
    read: Callable[[str, str, str], None]
    # Участник ли пользователь чата.
    is_member: Callable[[str, str], bool]
    # Отправить событие всем сокетам пользователя.
    push_to_user: Callable[[str, Dict[str, Any]], None]


_hooks: Optional[Hooks] = None


def configure(hooks: Hooks) -> None:
    global _hooks
    _hooks = hooks


def handle_frame(user_id: str, frame: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Обработать кадр от пользователя. Синхронная — вызывать в пуле потоков.

    Для 'send' возвращает ack/nack для этого же сокета, для остальных — None.
    """
    if _hooks is None or not isinstance(frame, dict):
        return None
    kind = frame.get('type')
    chat_id = str(frame.get('chatId') or '')
    if kind not in FRAME_TYPES or not chat_id:
        return None

    if kind == 'typing':
        try:
            _hooks.typing(user_id, chat_id, {
                'userName': frame.get('userName') or '',
                'isTyping': frame.get('isTyping', True),
                'kind': frame.get('kind') or 'text',
            })
        except Exception as e:
            logger.debug(f"[chat_realtime] typing failed: {e}")
        return None

    if kind == 'read':
        try:
            _hooks.read(user_id, chat_id, str(frame.get('lastMessageId') or ''))
        except Exception as e:
            logger.debug(f"[chat_realtime] read failed: {e}")
        return None

    msg_id = valid_client_message_id(frame.get('id'))
    if not msg_id:
        return {'type': 'nack', 'id': frame.get('id'), 'status': 400, 'error': 'id must be a UUID'}
    try:
        if not _hooks.is_member(user_id, chat_id):
            raise Rejected(403, 'not a participant')
        payload = {
            'id': msg_id,
            'content': frame.get('content') or '',
            'authorName': frame.get('authorName'),
            'mentions': frame.get('mentions') or [],
            'replyToId': frame.get('replyToId'),
            'attachments': frame.get('attachments') or [],
            'forwardedFrom': frame.get('forwardedFrom'),
            'forwardedFromUserId': frame.get('forwardedFromUserId'),
            'forwardedFromUsername': frame.get('forwardedFromUsername'),
            'metadata': {**(frame.get('metadata') or {}), 'clientNonce': msg_id},
        }
        saved = _hooks.send(user_id, chat_id, payload)
        # Другим устройствам автора: рассылка участникам автора исключает.
        try:
            _hooks.push_to_user(user_id, {'type': 'new_message', 'chatId': chat_id, 'messageId': saved.get('id'), 'message': saved})
        except Exception:
            pass
        return {'type': 'ack', 'id': msg_id, 'message': saved}
    except Rejected as e:
        return {'type': 'nack', 'id': msg_id, 'status': e.status, 'error': e.detail}
    except Exception as e:
        logger.warning(f"[chat_realtime] send failed for {user_id}: {e}")
        return {'type': 'nack', 'id': msg_id, 'status': 500, 'error': 'server error'}
