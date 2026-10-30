"""«Скрыть от агента»: материалы и папки «Офиса», файлы и папки «Файлов», которых агенты человека не должны видеть.

Человек отмечает это в правом меню материала, папки или файла. Правило держит сервер (MCP — mcp/tools.py Access и
mcp/files.py): скрытое для агента «не найдено» — его нет ни в списках, ни в поиске, ни по прямому id; скрытая папка
закрывает всё, что в ней лежит. Касается любых агентов человека: и «Ядра», и личных ключей MCP.

  GET /api/core/hidden                         {office_item: [...], office_folder: [...], file: [...], cloud_folder: [...]}
  PUT /api/core/hidden                         {kind, id, hidden}
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import schema
from app.core.db import db
from app.core.security import Identity, current_identity

router = APIRouter()

KINDS = ("office_item", "office_folder", "file", "cloud_folder")

schema.register("core_hidden", """
CREATE TABLE IF NOT EXISTS core_hidden (
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind, item_id)
);
""")


def _ready() -> bool:
    from app.modules.workspace import store  # поздний импорт: workspace тянет S3

    return store.table_ready("core_hidden")


def hidden_ids(user_id: str) -> dict[str, set[str]]:
    """Что человек скрыл от агентов — по видам. Без таблицы (прод ещё без схемы) — ничего не скрыто."""
    out: dict[str, set[str]] = {k: set() for k in KINDS}
    if not _ready():
        return out
    for row in db.conn.fetch_all("SELECT kind, item_id FROM core_hidden WHERE user_id = %s", (user_id,)) or []:
        out.setdefault(row["kind"], set()).add(str(row["item_id"]))
    return out


def cloud_hidden(user_id: str, folder_id: str | None, hidden: dict[str, set[str]] | None = None) -> bool:
    """Лежит ли папка «Файлов» (или она сама) в скрытой — по цепочке родителей."""
    hidden = hidden if hidden is not None else hidden_ids(user_id)
    folders = hidden["cloud_folder"]
    seen: set[str] = set()
    fid = folder_id
    for _ in range(32):
        if not fid or fid in seen:
            return False
        if fid in folders:
            return True
        seen.add(fid)
        row = db.get_cloud_folder_by_id(fid)
        fid = (row or {}).get("parent_id")
    return False


class HiddenBody(BaseModel):
    kind: Literal["office_item", "office_folder", "file", "cloud_folder"]
    id: str = Field(min_length=1, max_length=80)
    hidden: bool


@router.get("/api/core/hidden")
def get_hidden(me: Identity = Depends(current_identity)):
    return {k: sorted(v) for k, v in hidden_ids(me.user_id).items()}


@router.put("/api/core/hidden")
def put_hidden(body: HiddenBody, me: Identity = Depends(current_identity)):
    if not _ready():
        raise HTTPException(status_code=503, detail="Скрытие от агента ещё не включено на сервере: нужна схема (выкладка с -Schema)")
    if body.hidden:
        db.conn.execute_query("INSERT INTO core_hidden (user_id, kind, item_id) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                              (me.user_id, body.kind, body.id))
    else:
        db.conn.execute_query("DELETE FROM core_hidden WHERE user_id = %s AND kind = %s AND item_id = %s", (me.user_id, body.kind, body.id))
    return {k: sorted(v) for k, v in hidden_ids(me.user_id).items()}
