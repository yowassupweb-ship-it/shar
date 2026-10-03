from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class CallSignalBody(BaseModel):
    # 'join' | 'leave' | 'participant_joined' | 'participant_left' | 'offer' |
    # 'answer' | 'ice-candidate'. The last three are pure WebRTC negotiation
    # relay (peer-to-peer mesh, no SFU) — the backend does zero bookkeeping for
    # them, just forwards payload to toUserIds over the WS/Redis push channel.
    type: str
    callId: str
    fromUserId: str
    fromUserName: Optional[str] = None
    chatId: str
    callType: Optional[str] = None  # 'voice' | 'video'
    isGroup: Optional[bool] = None
    toUserIds: List[str]
    payload: Optional[Dict[str, Any]] = None
    mode: Optional[str] = None  # 'ring' | 'room' — set on the join that creates the room
