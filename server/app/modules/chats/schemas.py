from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class ChatCreate(BaseModel):
    participantIds: List[str]
    title: Optional[str] = None
    isGroup: bool = False
    creatorId: Optional[str] = None
    todoId: Optional[str] = None  # Связь с задачей
    isRequest: Optional[bool] = None  # Чат-заявка: свой текст системного сообщения постит клиент


class MessageCreate(BaseModel):
    # id может задать клиент (UUID): пузырь на экране сразу получает
    # окончательный id, а повтор той же отправки узнаётся по первичному ключу.
    id: Optional[str] = None
    authorId: str
    content: str
    authorName: Optional[str] = None
    mentions: Optional[List[str]] = []
    replyToId: Optional[str] = None
    attachments: Optional[List[Dict[str, Any]]] = []
    forwardedFrom: Optional[str] = None
    forwardedFromUserId: Optional[str] = None
    forwardedFromUsername: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
