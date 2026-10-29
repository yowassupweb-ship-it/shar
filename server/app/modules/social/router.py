"""Соцсети: сообщения и комментарии из ВКонтакте и MAX — карточками в чатах Шара, ответ — из Шара.

Цель — не держать переписку с клиентами на одном телефоне: бот компании принимает сообщения,
Шар раскладывает их по чатам менеджеров, ответ уходит от имени бота (или бизнес-аккаунта Telegram).

Устройство:
  * подключение (social_accounts) — сообщество ВКонтакте или бот MAX (Telegram поддержан, но в
    интерфейсе не предлагается): токен (шифруется, как пароли почты), секрет вебхука в адресе,
    чат Шара «по умолчанию»; у ВКонтакте в extra — id сообщества, Callback-сервера и код подтверждения;
  * источник (social_sources) — внешний чат, откуда пришло сообщение: личные боту, группа,
    комментарии канала, бизнес-аккаунт. Появляется сам с первым сообщением; для каждого можно
    выбрать свой чат Шара, иначе — чат подключения по умолчанию, а нет и его — только лента раздела;
  * диалог (social_dialogs, dialogs.py) — клиент на площадке: вся переписка с ним в одном месте,
    раздел «Соцсети → Диалоги» — все площадки в одном списке;
  * сообщение (social_items) — одно на внешнее сообщение (повтор вебхука ничего не дублирует) или
    ответ сотрудника; входящее ещё и карточкой в чате (integrations/cards.py) — уведомление со ссылкой
    на диалог.

Свой ответ можно исправить или удалить (ВКонтакте — сообщения в диалогах; MAX — сообщения и комментарии):
правка уходит на площадку, в Шаре остаётся отметка. Правки и удаления клиента приходят событиями площадки и
отмечаются так же — удалённое видно сотрудникам как удалённое.

Клиенту уходит только явный ответ — из диалога или кнопкой «Ответить клиенту» на карточке. Обычные сообщения в
чате под карточкой — внутреннее обсуждение, наружу не уходят.

Доступ к разделу — у админа и тех, кому выдан инструмент `social`. Ответить на карточку может
и участник чата, куда она пришла."""

from __future__ import annotations

import json
import logging
import secrets
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import anyio.to_thread
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse

from app.core import schema
from app.core.db import db
from app.core.security import Identity, current_identity, keys_equal
from app.modules.chats.access import participant_ids
from app.modules.chats.cache import _get_chat_cached
from app.modules.integrations.cards import post_card, update_card
from app.modules.mail.crypto import _deobfuscate_pw as _decrypt
from app.modules.mail.crypto import _obfuscate_pw as _encrypt
from app.modules.social import dialogs as D
from app.modules.social import notify as N
from app.modules.social import platforms as P
from app.modules.social import vk

router = APIRouter()
log = logging.getLogger("shar.social")

TOOL = "social"
PLATFORMS = {"vk": "ВКонтакте", "max": "MAX", "telegram": "Telegram"}
SOURCE_TYPES = {"private": "Личные сообщения", "business": "Бизнес-аккаунт", "group": "Беседа", "comments": "Комментарии"}

schema.register("social", """
CREATE TABLE IF NOT EXISTS social_accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    token_enc TEXT NOT NULL,
    secret TEXT NOT NULL,
    bot_username TEXT NOT NULL DEFAULT '',
    default_chat_id TEXT,
    status JSONB NOT NULL DEFAULT '{}'::jsonb,
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS social_sources (
    account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
    ext_chat_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    chat_type TEXT NOT NULL,
    chat_id TEXT,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, ext_chat_id)
);
CREATE TABLE IF NOT EXISTS social_items (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
    ext_chat_id TEXT NOT NULL,
    ext_message_id TEXT NOT NULL,
    business_connection_id TEXT,
    chat_id TEXT,
    message_id TEXT,
    data JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    answers JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, ext_chat_id, ext_message_id)
);
CREATE INDEX IF NOT EXISTS idx_social_items_created ON social_items (created_at DESC);
""")
schema.register("social_dialogs", D.DDL)


# ─── Доступ ──────────────────────────────────────────────────────────────────

def _has_tool(me: Identity) -> bool:
    if me.is_admin:
        return True
    user = db.get_user(me.user_id) or {}
    return TOOL in (user.get("enabled_tools") or user.get("enabledTools") or [])


def require_tool(me: Identity = Depends(current_identity)) -> Identity:
    if not _has_tool(me):
        raise HTTPException(status_code=403, detail="Нет доступа к разделу «Соцсети»")
    return me


# ─── Подключения ─────────────────────────────────────────────────────────────

def _account(account_id: str) -> dict:
    row = db.conn.fetch_one("SELECT * FROM social_accounts WHERE id = %s", (account_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Подключение не найдено")
    return dict(row)


def _hook_url(request: Request, account: dict, public_url: str = "") -> str:
    base = public_url.strip().rstrip("/")
    if not base:
        proto = (request.headers.get("x-forwarded-proto") or request.url.scheme).split(",")[0].strip()
        host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc).split(",")[0].strip()
        base = f"{proto}://{host}"
    return f"{base}/api/social/hook/{account['id']}/{account['secret']}"


def _chat_ref(chat_id: Optional[str]) -> Optional[dict]:
    if not chat_id:
        return None
    chat = _get_chat_cached(chat_id)
    return {"id": chat_id, "title": (chat or {}).get("title") or (chat or {}).get("name") or "Чат недоступен"}


def _account_view(row: dict) -> dict:
    sources = db.conn.fetch_all("SELECT * FROM social_sources WHERE account_id = %s ORDER BY last_seen DESC", (row["id"],)) or []
    return {
        "id": row["id"], "platform": row["platform"], "platformLabel": PLATFORMS.get(row["platform"], row["platform"]),
        "title": row.get("title") or "", "botUsername": row.get("bot_username") or "",
        "defaultChat": _chat_ref(row.get("default_chat_id")), "status": row.get("status") or {},
        "sources": [{
            "extChatId": s["ext_chat_id"], "title": s.get("title") or "", "type": s["chat_type"], "typeLabel": SOURCE_TYPES.get(s["chat_type"], s["chat_type"]),
            "chat": _chat_ref(s.get("chat_id")), "lastSeen": s["last_seen"].isoformat() if hasattr(s.get("last_seen"), "isoformat") else None,
        } for s in sources],
    }


@router.get("/api/social/accounts")
def list_accounts(me: Identity = Depends(require_tool)):
    rows = db.conn.fetch_all("SELECT * FROM social_accounts ORDER BY created_at") or []
    return {"accounts": [_account_view(dict(r)) for r in rows]}


def _connect(account: dict, token: str, hook: str) -> Dict[str, Any]:
    if account["platform"] == "telegram":
        return P.tg_connect(token, hook, account["secret"])
    if account["platform"] == "vk":
        extra = account.get("extra") or {}
        return {"extra": {**extra, "serverId": vk.subscribe(token, int(extra["groupId"]), hook, account["secret"])}}
    return P.max_connect(token, hook)


@router.post("/api/social/accounts")
async def add_account(request: Request, body: Dict[str, Any] = Body(...), me: Identity = Depends(require_tool)):
    """Подключить бота: проверить токен, подписать на события. Неверный токен — ошибка сразу,
    а не тишина потом."""
    platform = str(body.get("platform") or "")
    token = str(body.get("token") or "").strip()
    if platform not in PLATFORMS or not token:
        raise HTTPException(status_code=400, detail="Нужны площадка и токен бота")
    account = {"id": str(uuid.uuid4()), "platform": platform, "secret": secrets.token_urlsafe(24), "extra": {}}
    hook = _hook_url(request, account, str(body.get("publicUrl") or ""))
    info: Dict[str, Any] = {}
    try:
        if platform == "vk":
            # ВКонтакте проверит адрес сразу при добавлении сервера: код подтверждения уже должен
            # лежать в базе — поэтому сначала сообщество и код, потом запись, потом подписка.
            info = await anyio.to_thread.run_sync(vk.prepare, token)
            account["extra"] = {"groupId": info["groupId"], "confirmation": info["confirmation"]}
        _insert_account(account, platform, token, str(body.get("title") or ""), info, me)
        info = {**info, **await anyio.to_thread.run_sync(_connect, account, token, hook)}
    except P.PlatformError as e:
        db.conn.execute_query("DELETE FROM social_accounts WHERE id = %s", (account["id"],))
        raise HTTPException(status_code=400, detail=str(e)) from None
    status = {"ok": True, "checkedAt": datetime.now(timezone.utc).isoformat()}
    db.conn.execute_query(
        "UPDATE social_accounts SET status = %s::jsonb, extra = %s::jsonb, bot_username = COALESCE(NULLIF(%s, ''), bot_username), "
        "title = CASE WHEN title = '' THEN %s ELSE title END WHERE id = %s",
        (json.dumps(status), json.dumps(info.get("extra") or account["extra"]), info.get("botUsername") or "",
         info.get("botName") or PLATFORMS[platform], account["id"]),
    )
    return {"account": _account_view(_account(account["id"]))}


def _insert_account(account: dict, platform: str, token: str, title: str, info: Dict[str, Any], me: Identity) -> None:
    db.conn.execute_query(
        "INSERT INTO social_accounts (id, platform, title, token_enc, secret, bot_username, status, extra, created_by) "
        "VALUES (%s,%s,%s,%s,%s,%s,'{}'::jsonb,%s::jsonb,%s)",
        (account["id"], platform, title.strip()[:120] or info.get("botName") or "", _encrypt(token), account["secret"],
         info.get("botUsername") or "", json.dumps(account["extra"]), me.user_id),
    )


@router.post("/api/social/accounts/{account_id}/check")
async def check_account(account_id: str, request: Request, body: Dict[str, Any] = Body(default={}), me: Identity = Depends(require_tool)):
    """Проверить связь и заново подписаться на события (после смены адреса сервера, сбоя)."""
    account = _account(account_id)
    hook = _hook_url(request, account, str(body.get("publicUrl") or ""))
    try:
        info = await anyio.to_thread.run_sync(_connect, account, _decrypt(account["token_enc"]), hook)
        if info.get("extra"):
            db.conn.execute_query("UPDATE social_accounts SET extra = %s::jsonb WHERE id = %s", (json.dumps(info["extra"]), account_id))
        status = {"ok": True, "checkedAt": datetime.now(timezone.utc).isoformat()}
    except P.PlatformError as e:
        status = {"ok": False, "error": str(e), "checkedAt": datetime.now(timezone.utc).isoformat()}
    db.conn.execute_query("UPDATE social_accounts SET status = %s::jsonb WHERE id = %s", (json.dumps(status, ensure_ascii=False), account_id))
    return {"account": _account_view(_account(account_id))}


@router.patch("/api/social/accounts/{account_id}")
def change_account(account_id: str, body: Dict[str, Any] = Body(...), me: Identity = Depends(require_tool)):
    account = _account(account_id)
    if "title" in body:
        db.conn.execute_query("UPDATE social_accounts SET title = %s WHERE id = %s", (str(body.get("title") or "").strip()[:120] or account["title"], account_id))
    if "defaultChatId" in body:
        chat_id = str(body.get("defaultChatId") or "") or None
        if chat_id and not _get_chat_cached(chat_id):
            raise HTTPException(status_code=400, detail="Чат не найден")
        db.conn.execute_query("UPDATE social_accounts SET default_chat_id = %s WHERE id = %s", (chat_id, account_id))
    return {"account": _account_view(_account(account_id))}


@router.put("/api/social/accounts/{account_id}/sources/{ext_chat_id}")
def route_source(account_id: str, ext_chat_id: str, body: Dict[str, Any] = Body(...), me: Identity = Depends(require_tool)):
    """Чат Шара для источника; пусто — как у подключения по умолчанию."""
    _account(account_id)
    chat_id = str(body.get("chatId") or "") or None
    if chat_id and not _get_chat_cached(chat_id):
        raise HTTPException(status_code=400, detail="Чат не найден")
    if not db.conn.fetch_one("UPDATE social_sources SET chat_id = %s WHERE account_id = %s AND ext_chat_id = %s RETURNING ext_chat_id", (chat_id, account_id, ext_chat_id)):
        raise HTTPException(status_code=404, detail="Источник не найден")
    return {"account": _account_view(_account(account_id))}


@router.delete("/api/social/accounts/{account_id}")
async def remove_account(account_id: str, request: Request, me: Identity = Depends(require_tool)):
    """Отключить бота: отписать от событий (если мессенджер доступен) и удалить подключение.
    Карточки в чатах остаются, ответить на них уже нельзя."""
    account = _account(account_id)
    token = _decrypt(account["token_enc"])
    try:
        if account["platform"] == "telegram":
            await anyio.to_thread.run_sync(P.tg_disconnect, token)
        elif account["platform"] == "vk":
            extra = account.get("extra") or {}
            if extra.get("serverId"):
                await anyio.to_thread.run_sync(vk.disconnect, token, int(extra["groupId"]), int(extra["serverId"]))
        else:
            await anyio.to_thread.run_sync(P.max_disconnect, token, _hook_url(request, account))
    except P.PlatformError as e:
        log.warning("social %s: unsubscribe failed: %s", account_id, e)
    db.conn.execute_query("DELETE FROM social_accounts WHERE id = %s", (account_id,))
    return {"ok": True}


# ─── Приём ───────────────────────────────────────────────────────────────────

def _item_id(account_id: str, inc: P.Incoming) -> str:
    # Повтор вебхука (мессенджер не дождался ответа) — тот же id: и строка, и карточка не задвоятся.
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"shar:social:{account_id}:{inc.ext_chat_id}:{inc.ext_message_id}"))


def _card(account: dict, inc: P.Incoming, status: str = "new", answers: Optional[list] = None) -> Dict[str, Any]:
    return {
        "kind": "social", "platform": account["platform"], "platformLabel": PLATFORMS[account["platform"]],
        "account": account.get("title") or "", "sourceTitle": inc.chat_title, "sourceType": inc.chat_type,
        "sourceLabel": SOURCE_TYPES.get(inc.chat_type, ""), "authorName": inc.author_name, "authorUsername": inc.author_username,
        "text": inc.text, "media": inc.media, "authorAvatar": inc.author_avatar, "context": inc.context, "link": inc.link,
        "canReply": inc.can_reply, "status": status, "answers": answers or [],
    }


def _summary(account: dict, inc: P.Incoming) -> str:
    """Текст для превью, поиска и пуша. Площадку не повторяем — она уже в имени автора карточки."""
    body = inc.text or ", ".join(inc.media)
    return f"{inc.author_name}: {body}"[:500]


def receive(account: dict, inc: P.Incoming) -> Optional[str]:
    """Сохранить событие, поставить карточку в чат источника. Возвращает id сообщения-карточки."""
    if account["platform"] == "max" and inc.chat_type in ("group", "comments") and not inc.chat_title:
        known = db.conn.fetch_one("SELECT title FROM social_sources WHERE account_id = %s AND ext_chat_id = %s", (account["id"], inc.ext_chat_id))
        inc.chat_title = (known or {}).get("title") or P.max_chat_title(_decrypt(account["token_enc"]), inc.ext_chat_id) or (
            "Канал MAX" if inc.chat_type == "comments" else "Чат MAX")
    if account["platform"] == "max" and inc.chat_type == "comments" and not inc.context:
        inc.context = P.max_post_text(_decrypt(account["token_enc"]), inc.thread)
    source = db.conn.fetch_one(
        "INSERT INTO social_sources (account_id, ext_chat_id, title, chat_type) VALUES (%s,%s,%s,%s) "
        "ON CONFLICT (account_id, ext_chat_id) DO UPDATE SET last_seen = now(), title = EXCLUDED.title RETURNING chat_id",
        (account["id"], inc.ext_chat_id, inc.chat_title, inc.chat_type),
    ) or {}
    item_id = _item_id(account["id"], inc)
    if db.conn.fetch_one("SELECT 1 FROM social_items WHERE id = %s", (item_id,)):
        return None  # повтор события
    chat_id = source.get("chat_id") or account.get("default_chat_id")
    if chat_id and not _get_chat_cached(chat_id):
        chat_id = None
    dialog_id = D.upsert_for_incoming(account, inc, chat_id)
    created = db.conn.fetch_one(
        "INSERT INTO social_items (id, account_id, ext_chat_id, ext_message_id, business_connection_id, data, dialog_id) "
        "VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s) ON CONFLICT DO NOTHING RETURNING id",
        (item_id, account["id"], inc.ext_chat_id, inc.ext_message_id, inc.business_connection_id, json.dumps(inc.__dict__, ensure_ascii=False), dialog_id),
    )
    if not created:
        return None
    D.notify(dialog_id)
    N.new_message(dialog_id=dialog_id, item_id=item_id, kind=inc.chat_type, platform=account["platform"],
                  platform_label=PLATFORMS[account["platform"]], client_name=inc.author_name,
                  source_title=inc.chat_title, text=inc.text or ", ".join(inc.media))
    if not chat_id:
        return None
    try:
        msg = post_card(chat_id, source=f"social-{account['platform']}", author_name=PLATFORMS[account["platform"]],
                        content=_summary(account, inc), card={**_card(account, inc), "itemId": item_id, "dialogId": dialog_id}, message_id=item_id)
    except HTTPException as e:
        log.warning("social item %s: card not posted: %s", item_id, e.detail)
        return None
    db.conn.execute_query("UPDATE social_items SET chat_id = %s, message_id = %s WHERE id = %s", (chat_id, msg["id"], item_id))
    return msg["id"]


@router.post("/api/social/hook/{account_id}/{secret}")
async def webhook(account_id: str, secret: str, request: Request):
    """События мессенджера. Секрет в адресе знает только мессенджер; чужой запрос — 404, как будто
    адреса нет. Отвечаем 200 и на то, что не разобрали: иначе мессенджер будет повторять событие."""
    row = db.conn.fetch_one("SELECT * FROM social_accounts WHERE id = %s", (account_id,))
    if not row or not keys_equal(secret, row["secret"]):
        raise HTTPException(status_code=404, detail="Not found")
    account = dict(row)
    tg_secret = request.headers.get("x-telegram-bot-api-secret-token")
    if account["platform"] == "telegram" and tg_secret is not None and not keys_equal(tg_secret, account["secret"]):
        raise HTTPException(status_code=404, detail="Not found")
    try:
        update = await request.json()
    except ValueError:
        update = {}
    update = update if isinstance(update, dict) else {}
    if account["platform"] == "vk":
        return await _vk_hook(account, update)
    change = P.max_change(update) if account["platform"] == "max" else None
    if change:
        await anyio.to_thread.run_sync(apply_change, account, change)
        return {"ok": True}
    inc = (P.tg_parse if account["platform"] == "telegram" else P.max_parse)(update)
    if inc:
        await anyio.to_thread.run_sync(receive, account, inc)
    return {"ok": True}


async def _vk_hook(account: dict, event: dict) -> PlainTextResponse:
    extra = account.get("extra") or {}
    if str(event.get("group_id") or "") != str(extra.get("groupId") or "-"):
        raise HTTPException(status_code=404, detail="Not found")
    if event.get("type") == "confirmation":
        return PlainTextResponse(str(extra.get("confirmation") or ""))
    if not keys_equal(str(event.get("secret") or ""), account["secret"]):
        raise HTTPException(status_code=404, detail="Not found")

    def handle() -> None:
        change = vk.change(event)
        if change:
            apply_change(account, change)
            return
        if event.get("type") == "message_reply":
            record_sent(account, event)
            return
        inc = vk.parse(event, _decrypt(account["token_enc"]), account.get("title") or "")
        if inc:
            receive(account, inc)

    await anyio.to_thread.run_sync(handle)
    return PlainTextResponse("ok")  # иначе ВКонтакте повторит событие


def apply_change(account: dict, change: P.Change) -> None:
    """Сообщение изменили или удалили на самой площадке: отметить в переписке и в карточке входящего в чате."""
    row = D.find_changed(account["id"], change)
    if not row or not D.mark(row, change.action, change.text, "platform"):
        return
    if row.get("direction") == "in" and row.get("message_id"):
        patch: Dict[str, Any] = {"deleted": change.action == "delete"}
        if change.action != "delete" and change.text:
            patch.update(text=change.text, edited=change.action == "edit")
        update_card(str(row["message_id"]), patch)
    if row.get("dialog_id"):
        D.notify(str(row["dialog_id"]))


def refresh_subscriptions() -> None:
    """Подписать уже подключённые сообщества и ботов на новые события (правки, удаления). Делается один раз на
    версию набора событий: отметка — в extra.events. Сбой площадки не страшен — попробуем при следующем старте."""
    version = len(vk.VK_EVENTS) * 100 + len(P.MAX_UPDATES)
    for row in db.conn.fetch_all("SELECT * FROM social_accounts WHERE platform IN ('vk', 'max')") or []:
        account = dict(row)
        extra = account.get("extra") or {}
        if extra.get("events") == version:
            continue
        token = _decrypt(account["token_enc"])
        try:
            if account["platform"] == "vk":
                if not extra.get("serverId"):
                    continue
                vk.call(token, "groups.setCallbackSettings", group_id=int(extra["groupId"]), server_id=int(extra["serverId"]),
                        api_version=vk.VK_VERSION, **{e: 1 for e in vk.VK_EVENTS})
            elif not P.max_resubscribe(token, account["id"]):
                continue
        except P.PlatformError as e:
            log.warning("social %s: events not refreshed: %s", account["id"], e)
            continue
        db.conn.execute_query("UPDATE social_accounts SET extra = extra || %s::jsonb WHERE id = %s", (json.dumps({"events": version}), account["id"]))
        log.info("social %s: subscribed to edits and deletions", account["id"])


def _default_chat(account: dict) -> Optional[str]:
    chat_id = account.get("default_chat_id")
    return chat_id if chat_id and _get_chat_cached(chat_id) else None


def record_sent(account: dict, event: dict) -> None:
    """Сообщение, отправленное от имени сообщества не из Шара (из ВКонтакте, мобильного приложения, другого
    сервиса): кладём в переписку, чтобы в диалоге была вся история. Своё, из Шара, уже записано — не задвоится."""
    token = _decrypt(account["token_enc"])
    msg = event.get("object") or {}
    msg = msg.get("message") or msg
    peer = int(msg.get("peer_id") or 0)
    if not peer:
        return
    group_id = int((account.get("extra") or {}).get("groupId") or 0)
    chat = peer >= 2_000_000_000
    person = {} if chat else vk._person(token, peer)  # noqa: SLF001
    admin = int(msg.get("admin_author_id") or 0)
    inc = vk.sent_incoming(msg, vk._person(token, admin) if admin else {}, group_id)  # noqa: SLF001
    if not inc:
        return
    dialog_id = D.ensure_private(account, str(peer), "Беседа ВКонтакте" if chat else vk._name(person, peer),  # noqa: SLF001
                                 person.get("screen_name") or "", _default_chat(account), "group" if chat else "private", person.get("photo_100") or "")
    if D.record_history(account["id"], dialog_id, inc, "out", vk.stamp(msg), inc.author_name):
        D.refresh_last(dialog_id)
        D.notify(dialog_id)


# ─── Подгрузка истории ───────────────────────────────────────────────────────

IMPORTS: Dict[str, Dict[str, Any]] = {}


def _import_history(account: dict) -> None:
    state = IMPORTS[account["id"]]
    token = _decrypt(account["token_enc"])
    group_id = int((account.get("extra") or {}).get("groupId") or 0)
    default_chat = _default_chat(account)
    last_dialog = None
    try:
        for peer, title, people in vk.conversations(token):
            chat = peer >= 2_000_000_000
            person = people.get(peer) or {}
            name = (title or "Беседа ВКонтакте") if chat else vk._name(person, peer)  # noqa: SLF001
            dialog_id = D.ensure_private(account, str(peer), name, person.get("screen_name") or "", default_chat, "group" if chat else "private", person.get("photo_100") or "")
            fresh = 0
            for msg, profiles in vk.history(token, peer):
                author = int(msg.get("from_id") or 0)
                if msg.get("out") or author < 0:
                    admin = int(msg.get("admin_author_id") or 0)
                    inc = vk.sent_incoming(msg, profiles.get(admin) or {}, group_id, name)
                    direction = "out"
                else:
                    inc = vk.message_incoming(msg, profiles.get(author) or people.get(author) or {}, group_id, title)
                    direction = "in"
                if inc and D.record_history(account["id"], dialog_id, inc, direction, vk.stamp(msg), inc.author_name if direction == "out" else ""):
                    fresh += 1
            state["dialogs"] += 1
            state["messages"] += fresh
            if fresh:
                D.refresh_last(dialog_id)
                last_dialog = dialog_id
        state["state"] = "done"
    except P.PlatformError as e:
        state.update(state="error", error=str(e))
    except Exception as e:  # noqa: BLE001 — фоновая задача не должна пропасть молча
        log.exception("social import %s failed", account["id"])
        state.update(state="error", error=f"Сбой при загрузке: {type(e).__name__}")
    if last_dialog:
        D.notify(last_dialog)


@router.post("/api/social/accounts/{account_id}/import")
def start_import(account_id: str, me: Identity = Depends(require_tool)):
    """Подгрузить старую переписку сообщества (ВКонтакте) в фоне. Повторный запуск дописывает только новое."""
    account = _account(account_id)
    if account["platform"] != "vk":
        raise HTTPException(status_code=409, detail="Историю можно подгрузить только из ВКонтакте")
    if (IMPORTS.get(account_id) or {}).get("state") == "running":
        raise HTTPException(status_code=409, detail="Загрузка уже идёт")
    IMPORTS[account_id] = {"state": "running", "dialogs": 0, "messages": 0, "error": ""}
    threading.Thread(target=_import_history, args=(account,), daemon=True, name=f"social-import-{account_id}").start()
    return {"import": IMPORTS[account_id]}


@router.get("/api/social/accounts/{account_id}/import")
def import_status(account_id: str, me: Identity = Depends(require_tool)):
    return {"import": IMPORTS.get(account_id) or {"state": "idle", "dialogs": 0, "messages": 0, "error": ""}}


# ─── Лента и ответ ──────────────────────────────────────────────────────────

def _item_view(row: dict, accounts: Dict[str, dict]) -> dict:
    account = accounts.get(row["account_id"]) or {"platform": "telegram", "title": ""}
    inc = P.Incoming(**{k: v for k, v in (row.get("data") or {}).items() if k in P.Incoming.__dataclass_fields__})
    return {
        "id": row["id"], "createdAt": row["created_at"].isoformat() if hasattr(row.get("created_at"), "isoformat") else None,
        "chatId": row.get("chat_id"), "messageId": row.get("message_id"),
        **_card(account, inc, row.get("status") or "new", row.get("answers") or []),
    }


@router.get("/api/social/items")
def list_items(status: str = "", q: str = "", limit: int = 200, me: Identity = Depends(require_tool)):
    where, params = ["direction = 'in'"], []
    if status in ("new", "answered"):
        where.append("status = %s")
        params.append(status)
    if q.strip():
        where.append("data::text ILIKE %s")
        params.append(f"%{q.strip()[:100]}%")
    sql = "SELECT * FROM social_items" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY created_at DESC LIMIT %s"
    params.append(max(1, min(limit, 500)))
    accounts = {r["id"]: dict(r) for r in (db.conn.fetch_all("SELECT id, platform, title FROM social_accounts") or [])}
    counts = {r["status"]: int(r["n"]) for r in (db.conn.fetch_all("SELECT status, count(*) AS n FROM social_items GROUP BY status") or [])}
    return {"items": [_item_view(dict(r), accounts) for r in (db.conn.fetch_all(sql, tuple(params)) or [])],
            "counts": {"new": counts.get("new", 0), "answered": counts.get("answered", 0)}}


def _send(account: dict, row: dict, text: str, files: Optional[list] = None) -> str:
    token = _decrypt(account["token_enc"])
    if files:
        if account["platform"] == "vk":
            return vk.send_files(token, (row.get("data") or {}).get("reply") or {}, text, files)
        if account["platform"] == "max":
            return P.max_send_files(token, row["ext_chat_id"], row["ext_message_id"], text, files, (row.get("data") or {}).get("reply"))
        raise P.PlatformError("Файлы из Шара в эту площадку пока не отправляются")
    if account["platform"] == "vk":
        return vk.reply(token, (row.get("data") or {}).get("reply") or {}, text)
    if account["platform"] == "telegram":
        return P.tg_reply(token, row["ext_chat_id"], row["ext_message_id"], text, row.get("business_connection_id"))
    return P.max_reply(token, row["ext_chat_id"], row["ext_message_id"], text, (row.get("data") or {}).get("reply"))


MAX_FILES = 10
MAX_FILE_BYTES = 50 * 1024 * 1024


def _files(body: Dict[str, Any]) -> list:
    """Вложения ответа: файлы, уже загруженные в Шар (/api/uploads/…). Чужие адреса не берём —
    иначе сервер можно было бы попросить отдать наружу что угодно."""
    from app.modules.mail.service import _read_uploaded_file  # noqa: PLC0415 — то же хранилище загрузок

    out = []
    for att in (body.get("attachments") or [])[:MAX_FILES + 1]:
        url = str((att or {}).get("url") or "")
        if not url.startswith("/api/uploads/"):
            raise HTTPException(status_code=400, detail="Вложение должно быть загружено в Шар")
        data = _read_uploaded_file(url)
        if data is None:
            raise HTTPException(status_code=400, detail=f"Файл «{att.get('name') or url}» не найден")
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(status_code=400, detail=f"Файл «{att.get('name')}» больше 50 МБ")
        name = str(att.get("name") or url.rsplit("/", 1)[-1])[:200]
        out.append((name, data, str(att.get("type") or "application/octet-stream")))
    if len(out) > MAX_FILES:
        raise HTTPException(status_code=400, detail=f"Не больше {MAX_FILES} файлов за раз")
    return out


def _check_text(body: Dict[str, Any], allow_empty: bool = False) -> str:
    text = str(body.get("text") or "").strip()
    if not text and not allow_empty:
        raise HTTPException(status_code=400, detail="Пустой ответ")
    if len(text) > 4000:
        raise HTTPException(status_code=400, detail="Слишком длинный ответ — не больше 4000 знаков")
    return text


async def _answer(row: dict, text: str, me: Identity, files: Optional[list] = None) -> dict:
    """Отправить клиенту ответ на входящее сообщение row и записать его: в историю диалога, в ответы
    этого сообщения и в его карточку в чате."""
    account_row = db.conn.fetch_one("SELECT * FROM social_accounts WHERE id = %s", (row["account_id"],))
    if not account_row:
        raise HTTPException(status_code=410, detail="Подключение удалено — ответить отсюда нельзя")
    try:
        sent_id = await anyio.to_thread.run_sync(_send, dict(account_row), row, text, files or None)
    except P.PlatformError as e:
        raise HTTPException(status_code=502, detail=str(e)) from None
    out = None
    if row.get("dialog_id"):
        out = D.record_out(str(row["dialog_id"]), row["account_id"], row["ext_chat_id"], sent_id, text, me.user_id, me.display_name,
                           [n for n, _, _ in files or []], row["ext_message_id"])
    shown = text or ", ".join(n for n, _, _ in files or [])
    answer = {"by": me.user_id, "byName": me.display_name, "text": shown, "at": datetime.now(timezone.utc).isoformat()}
    answers = [*(row.get("answers") or []), answer]
    db.conn.execute_query("UPDATE social_items SET status = 'answered', answers = %s::jsonb WHERE id = %s", (json.dumps(answers, ensure_ascii=False), row["id"]))
    if row.get("message_id"):
        update_card(str(row["message_id"]), {"status": "answered", "answers": answers})
    if row.get("dialog_id"):
        D.notify(str(row["dialog_id"]))
    return {"ok": True, "answers": answers, "message": out}


@router.post("/api/social/items/{item_id}/reply")
async def reply(item_id: str, body: Dict[str, Any] = Body(...), me: Identity = Depends(current_identity)):
    """Ответ на карточку в чате. Отвечать может участник этого чата или тот, у кого есть раздел."""
    text = _check_text(body)
    row = db.conn.fetch_one("SELECT * FROM social_items WHERE id = %s AND direction = 'in'", (item_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    row = dict(row)
    chat = _get_chat_cached(str(row["chat_id"])) if row.get("chat_id") else None
    if not (chat and me.user_id in participant_ids(chat)) and not _has_tool(me):
        raise HTTPException(status_code=403, detail="Нет доступа")
    return await _answer(row, text, me)


# ─── Диалоги ─────────────────────────────────────────────────────────────────

def _accounts() -> Dict[str, dict]:
    return {r["id"]: dict(r) for r in (db.conn.fetch_all("SELECT id, platform, title FROM social_accounts") or [])}


@router.get("/api/social/dialogs")
def list_dialogs(kind: str = "", filter: str = "", platform: str = "", q: str = "", limit: int = 300, me: Identity = Depends(require_tool)):
    """Диалоги всех площадок, свежие сверху. kind=comments — комментарии, kind=dialogs — личные и беседы
    (в разделе это две вкладки); filter=waiting — только ждущие ответа."""
    where, params = [], []
    if kind == "comments":
        where.append("d.kind = 'comments'")
    elif kind == "dialogs":
        where.append("d.kind <> 'comments'")
    if filter == "waiting":
        where.append("d.last_dir = 'in' AND d.handled_at IS NULL")
    if platform in PLATFORMS:
        where.append("a.platform = %s")
        params.append(platform)
    if q.strip():
        where.append("(d.title ILIKE %s OR d.client_username ILIKE %s OR d.last_text ILIKE %s OR d.source_title ILIKE %s)")
        params += [f"%{q.strip()[:100]}%"] * 4
    sql = ("SELECT d.* FROM social_dialogs d JOIN social_accounts a ON a.id = d.account_id"
           + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY d.last_at DESC LIMIT %s")
    params.append(max(1, min(limit, 1000)))
    accounts = _accounts()
    waiting = db.conn.fetch_one(
        "SELECT count(*) FILTER (WHERE kind <> 'comments') AS dialogs, count(*) FILTER (WHERE kind = 'comments') AS comments "
        "FROM social_dialogs WHERE " + D.WAITING_SQL) or {}
    return {"dialogs": [D.view(dict(r), PLATFORMS, accounts.get(r["account_id"], {})) for r in (db.conn.fetch_all(sql, tuple(params)) or [])],
            "waiting": {"dialogs": int(waiting.get("dialogs") or 0), "comments": int(waiting.get("comments") or 0)}}


def _dialog(dialog_id: str) -> dict:
    row = db.conn.fetch_one("SELECT * FROM social_dialogs WHERE id = %s", (dialog_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Диалог не найден")
    return dict(row)


@router.get("/api/social/dialogs/{dialog_id}")
def get_dialog(dialog_id: str, me: Identity = Depends(require_tool)):
    row = _dialog(dialog_id)
    accounts = _accounts()
    items = db.conn.fetch_all(
        "SELECT * FROM (SELECT * FROM social_items WHERE dialog_id = %s ORDER BY created_at DESC LIMIT 300) t ORDER BY created_at",
        (dialog_id,),
    ) or []
    users = {str(u["id"]): u for u in (db.get_users(include_disabled=True) or []) if u.get("id")}
    account = accounts.get(row["account_id"], {})
    messages = [_message_view(dict(it), users, row, account, me) for it in items]
    last_in = next((m for m in reversed(messages) if m["direction"] == "in" and not m["deleted"]), None)
    return {"dialog": D.view(row, PLATFORMS, account), "messages": messages,
            "canReply": bool(last_in and last_in["canReply"] and row["account_id"] in accounts),
            # Автору комментария во ВКонтакте сообщество может написать в личные (если он не закрыл сообщения).
            "canPrivate": bool(row["kind"] == "comments" and account.get("platform") == "vk" and last_in)}


def _change_target(account: dict, dialog: dict, item: dict) -> Optional[dict]:
    """Куда на площадке уходит правка или удаление ответа; None — площадка этого не даёт."""
    sent = str((item.get("data") or {}).get("sent_id") or "")
    if item.get("direction") != "out" or not sent or sent == "0":
        return None
    if account.get("platform") == "vk":
        # Комментарии сообщества правит и удаляет только человек (ключ пользователя), не ключ сообщества.
        peer = str(item.get("ext_chat_id") or "")
        return {"kind": "message", "peer_id": int(peer)} if dialog.get("kind") != "comments" and peer.lstrip("-").isdigit() else None
    if account.get("platform") == "max":
        if dialog.get("kind") == "comments":
            parts = str(dialog.get("dialog_key") or "").split(":")  # чат:пост:автор (dialogs.dialog_key)
            return {"kind": "comment", "post_id": parts[1]} if len(parts) == 3 and parts[1] else None
        return {"kind": "message", "reply_mid": (item.get("data") or {}).get("reply_to") or ""}
    return None


def _may_change(me: Identity, item: dict) -> bool:
    """Свой ответ — автору; админу — любой ответ от имени сообщества (и отправленный не из Шара)."""
    return item.get("direction") == "out" and (me.is_admin or str(item.get("author_user_id") or "") == me.user_id)


def _message_view(it: dict, users: Dict[str, dict], dialog: dict, account: dict, me: Identity) -> dict:
    data = it.get("data") or {}
    out = it.get("direction") == "out"
    author = users.get(str(it.get("author_user_id") or "")) if out else None
    deleted = bool(data.get("deleted_at"))
    changeable = not deleted and _may_change(me, it) and _change_target(account, dialog, it) is not None
    return {
        "id": it["id"], "direction": it.get("direction") or "in",
        "text": data.get("text") or "", "media": data.get("media") or [], "images": data.get("images") or [], "link": data.get("link"),
        "context": data.get("context") or "", "canReply": data.get("can_reply", True),
        "authorName": ((author or {}).get("name") or data.get("author_name") or "") if out else (data.get("author_name") or ""),
        "authorUserId": it.get("author_user_id"),
        "at": it["created_at"].isoformat() if hasattr(it.get("created_at"), "isoformat") else None,
        "edited": bool(data.get("edited_at")), "deleted": deleted,
        # Сообщение с файлами не правим: ВКонтакте при правке без вложений снимает их.
        "canEdit": changeable and not data.get("media"), "canDelete": changeable,
    }


def _own_item(item_id: str, me: Identity) -> tuple:
    """Ответ, который человек может исправить или удалить, с подключением, диалогом и адресом на площадке."""
    row = db.conn.fetch_one("SELECT * FROM social_items WHERE id = %s", (item_id,))
    if not row or not row.get("dialog_id"):
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    item = dict(row)
    if not _may_change(me, item):
        raise HTTPException(status_code=403, detail="Исправить или удалить можно только свой ответ")
    if (item.get("data") or {}).get("deleted_at"):
        raise HTTPException(status_code=409, detail="Сообщение уже удалено")
    account_row = db.conn.fetch_one("SELECT * FROM social_accounts WHERE id = %s", (item["account_id"],))
    if not account_row:
        raise HTTPException(status_code=410, detail="Подключение удалено — изменить сообщение отсюда нельзя")
    account, dialog = dict(account_row), _dialog(str(item["dialog_id"]))
    target = _change_target(account, dialog, item)
    if target is None:
        raise HTTPException(status_code=409, detail="Это сообщение площадка не даёт изменить из Шара — только в её приложении")
    return item, account, dialog, target


def _changed_view(item_id: str, dialog: dict, account: dict, me: Identity) -> dict:
    row = dict(db.conn.fetch_one("SELECT * FROM social_items WHERE id = %s", (item_id,)) or {})
    users = {str(u["id"]): u for u in (db.get_users(include_disabled=True) or []) if u.get("id")}
    return _message_view(row, users, dialog, account, me)


@router.patch("/api/social/messages/{item_id}")
async def edit_message(item_id: str, body: Dict[str, Any] = Body(...), me: Identity = Depends(require_tool)):
    """Исправить свой ответ клиенту: новый текст уходит на площадку, в переписке — отметка «изменено»."""
    text = _check_text(body)
    item, account, dialog, target = _own_item(item_id, me)
    if (item.get("data") or {}).get("media"):
        raise HTTPException(status_code=409, detail="Сообщение с файлами не исправить — удалите его и отправьте заново")
    sent = str(item["data"]["sent_id"])
    token = _decrypt(account["token_enc"])
    try:
        if account["platform"] == "vk":
            await anyio.to_thread.run_sync(vk.edit_message, token, target["peer_id"], sent, text)
        else:
            await anyio.to_thread.run_sync(P.max_edit, token, sent, text, target)
    except P.PlatformError as e:
        raise HTTPException(status_code=502, detail=str(e)) from None
    D.mark(item, "edit", text)
    D.notify(str(item["dialog_id"]))
    return {"message": _changed_view(item_id, dialog, account, me)}


@router.delete("/api/social/messages/{item_id}")
async def delete_message(item_id: str, me: Identity = Depends(require_tool)):
    """Удалить свой ответ у клиента. В Шаре он остаётся отметкой «удалено» — история не теряется."""
    item, account, dialog, target = _own_item(item_id, me)
    sent = str(item["data"]["sent_id"])
    token = _decrypt(account["token_enc"])
    try:
        if account["platform"] == "vk":
            await anyio.to_thread.run_sync(vk.delete_message, token, sent)
        else:
            await anyio.to_thread.run_sync(P.max_delete, token, sent, target)
    except P.PlatformError as e:
        raise HTTPException(status_code=502, detail=str(e)) from None
    D.mark(item, "delete", by=me.user_id)
    D.notify(str(item["dialog_id"]))
    return {"message": _changed_view(item_id, dialog, account, me)}


@router.post("/api/social/dialogs/{dialog_id}/messages")
async def send_to_dialog(dialog_id: str, body: Dict[str, Any] = Body(...), me: Identity = Depends(require_tool)):
    """Написать клиенту в диалоге: ответом на его последнее сообщение (в комментариях — на последний
    комментарий; в личных и беседах — просто в этот чат)."""
    files = _files(body)
    text = _check_text(body, allow_empty=bool(files))
    _dialog(dialog_id)
    row = db.conn.fetch_one(
        "SELECT * FROM social_items WHERE dialog_id = %s AND direction = 'in' AND data->>'deleted_at' IS NULL "
        "ORDER BY created_at DESC LIMIT 1", (dialog_id,))
    if not row:
        raise HTTPException(status_code=409, detail="В диалоге нет сообщений клиента")
    if not (row.get("data") or {}).get("can_reply", True):
        raise HTTPException(status_code=409, detail="На этот комментарий площадка даёт ответить только на самом сайте")
    return await _answer(dict(row), text, me, files)


@router.post("/api/social/dialogs/{dialog_id}/handled")
def mark_handled(dialog_id: str, body: Dict[str, Any] = Body(...), me: Identity = Depends(require_tool)):
    """Отметить диалог «ответ дан» (или снять отметку): ответили не из Шара — диалог перестаёт «ждать ответа»."""
    _dialog(dialog_id)
    D.set_handled(dialog_id, bool(body.get("handled", True)), me.user_id)
    D.notify(dialog_id)
    row = _dialog(dialog_id)
    return {"dialog": D.view(row, PLATFORMS, _accounts().get(row["account_id"], {}))}


@router.post("/api/social/dialogs/{dialog_id}/private")
async def write_private(dialog_id: str, body: Dict[str, Any] = Body(...), me: Identity = Depends(require_tool)):
    """Написать автору комментария в личные сообщения от имени сообщества (ВКонтакте). Переписка
    ложится в личный диалог с ним (вкладка «Диалоги»), а комментарий считается отвеченным."""
    files = _files(body)
    text = _check_text(body, allow_empty=bool(files))
    dialog = _dialog(dialog_id)
    account_row = db.conn.fetch_one("SELECT * FROM social_accounts WHERE id = %s", (dialog["account_id"],))
    if not account_row or account_row["platform"] != "vk" or dialog["kind"] != "comments":
        raise HTTPException(status_code=409, detail="В личные можно написать автору комментария во ВКонтакте")
    account = dict(account_row)
    last = db.conn.fetch_one("SELECT data FROM social_items WHERE dialog_id = %s AND direction = 'in' ORDER BY created_at DESC LIMIT 1", (dialog_id,))
    author_id = str(((last or {}).get("data") or {}).get("author_id") or "")
    if not author_id.isdigit():
        raise HTTPException(status_code=409, detail="Не знаю, кому писать — у комментария нет автора")
    target = {"kind": "message", "peer_id": int(author_id)}
    token = _decrypt(account["token_enc"])
    try:
        sent_id = await anyio.to_thread.run_sync(lambda: vk.send_files(token, target, text, files) if files else vk.reply(token, target, text))
    except P.PlatformError as e:
        raise HTTPException(status_code=502, detail=str(e)) from None
    chat_id = dialog.get("chat_id") or account.get("default_chat_id")
    if chat_id and not _get_chat_cached(chat_id):
        chat_id = None
    private_id = D.ensure_private(account, author_id, dialog.get("client_name") or dialog.get("title") or f"id{author_id}",
                                  dialog.get("client_username") or "", chat_id)
    D.record_out(private_id, account["id"], author_id, sent_id, text, me.user_id, me.display_name, [n for n, _, _ in files])
    D.set_handled(dialog_id, True, me.user_id)
    D.notify(private_id)
    D.notify(dialog_id)
    return {"ok": True, "dialogId": private_id}


# ─── Уведомления ─────────────────────────────────────────────────────────────

@router.get("/api/social/notify")
def get_notify(me: Identity = Depends(require_tool)):
    """Настройки уведомлений модуля и люди, из которых можно выбирать (у кого есть доступ)."""
    people = sorted(({"id": str(u["id"]), "name": u.get("name") or u.get("username") or str(u["id"]),
                      "admin": u.get("role") == "admin"} for u in N.with_access()), key=lambda x: x["name"].lower())
    return {"settings": N.load(), "people": people}


@router.put("/api/social/notify")
def put_notify(body: Dict[str, Any] = Body(...), me: Identity = Depends(require_tool)):
    return {"settings": N.save(body)}


@router.get("/api/social/waiting")
def waiting_count(me: Identity = Depends(current_identity)):
    """Сколько диалогов ждут ответа — для значка непрочитанных на логотипе. Считаются только вкладки,
    уведомления которых положены этому человеку; без доступа к модулю — ноль."""
    if not _has_tool(me):
        return {"dialogs": 0, "comments": 0, "total": 0}
    mine = {kind: me.user_id in N.recipients(kind) for kind in ("dialogs", "comments")}
    row = db.conn.fetch_one(
        "SELECT count(*) FILTER (WHERE kind <> 'comments') AS dialogs, count(*) FILTER (WHERE kind = 'comments') AS comments "
        "FROM social_dialogs WHERE " + D.WAITING_SQL) or {}
    counts = {k: int(row.get(k) or 0) if mine[k] else 0 for k in ("dialogs", "comments")}
    return {**counts, "total": counts["dialogs"] + counts["comments"]}
