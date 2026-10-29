"""ВКонтакте, MAX и Telegram: проверка токена, подписка на события, разбор события и ответ.

Все площадки сводятся к одному виду события (Incoming) — дальше код не знает, откуда оно.

ВКонтакте — Callback API сообщества, ключ доступа сообщества (права: управление сообществом,
сообщения, стена). Шар сам добавляет свой адрес как Callback-сервер и включает нужные события.
Что приходит: сообщения сообществу и из бесед, где оно состоит; комментарии на стене, к фото,
видео, товарам и в обсуждениях. Ответить из Шара можно на сообщения и комментарии на стене —
остальное ВКонтакте даёт комментировать только от имени человека, там — ссылка. Код — vk.py.

Telegram в интерфейсе не предлагается (нужны ВКонтакте и MAX), но поддержка осталась.
Telegram — Bot API. Что видит бот:
  * личные сообщения боту;
  * группы, где он админ (без прав админа бот в группе видит только команды);
  * комментарии канала — бот админ в группе обсуждения канала: комментарий там — ответ на
    автоматическую копию поста (is_automatic_forward);
  * личные сообщения бизнес-аккаунта (Telegram Business → Чат-боты): business_message, ответ —
    от имени аккаунта, с business_connection_id.
Запросы к api.telegram.org идут через прокси из админки (telegramProxy), если он задан: с
российского сервера Telegram доступен не всегда.

MAX — Bot API (platform-api2.max.ru, токен в заголовке Authorization): сообщения боту и в чатах,
где бот добавлен (message_created), и комментарии под постами канала, где бот — администратор
с правом read_all_messages (comment_created; в канале должны быть включены комментарии).
Личные сообщения на аккаунт человека Bot API не отдаёт — только диалоги с самим ботом."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import requests

from app.core.db import db
from app.modules.social.tls import ca_bundle

log = logging.getLogger("shar.social")

TIMEOUT = 15
MAX_API = "https://platform-api2.max.ru"


class PlatformError(Exception):
    """Ошибка мессенджера, понятная человеку (показывается в интерфейсе). code — код площадки, если есть."""

    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code


@dataclass
class Incoming:
    ext_chat_id: str
    ext_message_id: str
    chat_title: str
    # private — личные боту, business — личные бизнес-аккаунта, group — группа, comments — комментарии канала
    chat_type: str
    author_id: str
    author_name: str
    author_username: str = ""
    text: str = ""
    media: List[str] = field(default_factory=list)
    link: Optional[str] = None
    context: str = ""  # пост, к которому комментарий
    business_connection_id: Optional[str] = None
    # Куда отвечать — своё у каждой площадки (ВКонтакте: диалог или комментарий на стене).
    reply: Dict[str, Any] = field(default_factory=dict)
    can_reply: bool = True
    thread: str = ""  # пост, под которым комментарий: диалог — автор под этим постом
    author_avatar: str = ""  # фото собеседника на площадке
    images: List[str] = field(default_factory=list)  # адреса картинок вложений — показываются прямо в переписке


@dataclass
class Change:
    """Сообщение на площадке изменили, удалили или восстановили (клиент — своё, сотрудник — из приложения площадки).
    in_id — как такое сообщение записано входящим (ext_message_id), out_id — как исходящим (data.sent_id)."""
    action: str  # edit | delete | restore
    ext_chat_id: str
    in_id: str
    out_id: str
    text: str = ""


# ─── Telegram ────────────────────────────────────────────────────────────────

def _tg_proxies() -> Optional[dict]:
    try:
        proxy = str((db.get_settings() or {}).get("telegramProxy") or "").strip()
    except Exception:
        proxy = ""
    if not proxy:
        return None
    url = proxy if "://" in proxy else f"socks5://{proxy}"
    return {"https": url, "http": url}


def tg_call(token: str, method: str, payload: Optional[dict] = None) -> Any:
    try:
        res = requests.post(f"https://api.telegram.org/bot{token}/{method}", json=payload or {}, timeout=TIMEOUT, proxies=_tg_proxies())
    except requests.RequestException as e:
        # Текст исключения может содержать адрес с токеном — наружу только тип.
        raise PlatformError(f"Telegram не ответил ({type(e).__name__}). Если сервер в России — задайте прокси в админке.") from None
    try:
        data = res.json()
    except ValueError:
        raise PlatformError(f"Telegram ответил {res.status_code}") from None
    if not data.get("ok"):
        raise PlatformError(_tg_error(str(data.get("description") or res.status_code)))
    return data.get("result")


# Частые отказы Telegram — по-русски и с тем, что делать.
_TG_ERRORS = [
    ("unauthorized", "Telegram не принял токен бота — проверьте его в @BotFather и подключите бота заново"),
    ("bot was blocked by the user", "Клиент заблокировал бота — ответить ему через бота нельзя"),
    ("user is deactivated", "Аккаунт клиента удалён"),
    ("bot is not a member", "Бота нет в этой группе — добавьте его обратно"),
    ("bot was kicked", "Бота удалили из группы — добавьте его обратно"),
    ("not enough rights", "У бота нет прав писать в эту группу"),
    ("business connection", "Бот отключён от бизнес-аккаунта или не может отвечать в нём (Telegram Business → Чат-боты)"),
    ("too many requests", "Telegram просит подождать — слишком много сообщений подряд"),
]


def _tg_error(description: str) -> str:
    low = description.lower()
    return next((text for key, text in _TG_ERRORS if key in low), f"Telegram: {description}")


TG_UPDATES = ["message", "business_message", "business_connection"]


def tg_connect(token: str, hook_url: str, secret: str) -> Dict[str, Any]:
    me = tg_call(token, "getMe")
    tg_call(token, "setWebhook", {"url": hook_url, "secret_token": secret, "allowed_updates": TG_UPDATES, "drop_pending_updates": False})
    return {"botUsername": me.get("username") or "", "botName": me.get("first_name") or ""}


def tg_disconnect(token: str) -> None:
    tg_call(token, "deleteWebhook")


def _tg_name(user: dict) -> str:
    name = " ".join(x for x in (user.get("first_name"), user.get("last_name")) if x).strip()
    return name or user.get("username") or str(user.get("id") or "")


def _tg_media(msg: dict) -> List[str]:
    kinds = [("photo", "Фото"), ("video", "Видео"), ("voice", "Голосовое"), ("video_note", "Кружок"), ("audio", "Аудио"),
             ("document", "Файл"), ("sticker", "Стикер"), ("animation", "GIF"), ("location", "Геопозиция"), ("contact", "Контакт")]
    return [label for key, label in kinds if msg.get(key)]


def _tg_internal(chat_id: Any) -> str:
    s = str(chat_id)
    return s[4:] if s.startswith("-100") else s.lstrip("-")


def tg_parse(update: dict) -> Optional[Incoming]:
    business = "business_message" in update
    msg = update.get("business_message") or update.get("message")
    if not isinstance(msg, dict):
        return None
    sender = msg.get("from") or {}
    chat = msg.get("chat") or {}
    if sender.get("is_bot") or msg.get("is_automatic_forward"):
        return None  # свои ответы и копии постов канала в группе обсуждения
    if business and str(sender.get("id")) != str(chat.get("id")):
        return None  # в бизнес-чате это написал сам владелец аккаунта
    text = msg.get("text") or msg.get("caption") or ""
    media = _tg_media(msg)
    if not text and not media:
        return None  # служебные: вошёл в группу, закрепил и т.п.
    mid = msg.get("message_id")
    chat_type = chat.get("type")
    root = msg.get("reply_to_message") or {}
    comment = chat_type == "supergroup" and (root.get("is_automatic_forward") or (msg.get("message_thread_id") and not msg.get("is_topic_message")))
    link, context = None, ""
    if business or chat_type == "private":
        kind = "business" if business else "private"
        title = _tg_name(sender)
        link = f"https://t.me/{sender['username']}" if sender.get("username") else None
    else:
        kind = "comments" if comment else "group"
        title = chat.get("title") or "Группа"
        thread = msg.get("message_thread_id")
        origin = root.get("forward_origin") or {}
        channel = (origin.get("chat") or root.get("sender_chat") or {}) if root.get("is_automatic_forward") else {}
        post_id = origin.get("message_id") or root.get("forward_from_message_id")
        if comment and root.get("is_automatic_forward"):
            context = (root.get("text") or root.get("caption") or "").strip()[:300]
            if channel.get("title"):
                title = channel["title"]
        if comment and channel.get("username") and post_id:
            link = f"https://t.me/{channel['username']}/{post_id}?comment={mid}"
        elif chat.get("username"):
            link = f"https://t.me/{chat['username']}/{mid}" + (f"?thread={thread}" if comment and thread else "")
        else:
            link = f"https://t.me/c/{_tg_internal(chat.get('id'))}/{mid}" + (f"?thread={thread}" if comment and thread else "")
    return Incoming(
        ext_chat_id=str(chat.get("id")), ext_message_id=str(mid), chat_title=title, chat_type=kind,
        author_id=str(sender.get("id") or ""), author_name=_tg_name(sender), author_username=sender.get("username") or "",
        text=text, media=media, link=link, context=context,
        business_connection_id=msg.get("business_connection_id") if business else None,
        thread=str(msg.get("message_thread_id") or "") if comment else "",
    )


def tg_reply(token: str, ext_chat_id: str, ext_message_id: str, text: str, business_connection_id: Optional[str]) -> str:
    payload: Dict[str, Any] = {
        "chat_id": ext_chat_id, "text": text,
        "reply_parameters": {"message_id": int(ext_message_id), "allow_sending_without_reply": True},
    }
    if business_connection_id:
        payload["business_connection_id"] = business_connection_id
    sent = tg_call(token, "sendMessage", payload)
    return str((sent or {}).get("message_id") or "")


# ─── MAX ─────────────────────────────────────────────────────────────────────

def max_call(token: str, method: str, path: str, *, params: Optional[dict] = None, body: Optional[dict] = None) -> Any:
    try:
        res = requests.request(method, MAX_API + path, params=params, json=body, headers={"Authorization": token}, timeout=TIMEOUT, verify=ca_bundle())
    except requests.RequestException as e:
        raise PlatformError(f"MAX не ответил ({type(e).__name__})") from None
    try:
        data = res.json() if res.content else {}
    except ValueError:
        data = {}
    if res.status_code >= 400:
        raise PlatformError(f"MAX: {data.get('message') or data.get('code') or res.status_code}", str(data.get("code") or ""))
    return data


# Правки и удаления — чтобы в переписке Шара было то же, что у клиента. Новые типы доходят до уже
# подключённых ботов после переподписки (refresh_subscriptions в router.py делает её сама при старте).
MAX_UPDATES = ["message_created", "comment_created", "message_edited", "message_removed", "comment_edited", "comment_removed"]


def max_connect(token: str, hook_url: str) -> Dict[str, Any]:
    me = max_call(token, "GET", "/me")
    max_call(token, "POST", "/subscriptions", body={"url": hook_url, "update_types": MAX_UPDATES})
    return {"botUsername": me.get("username") or "", "botName": me.get("name") or me.get("first_name") or ""}


def max_resubscribe(token: str, account_id: str) -> int:
    """Обновить типы событий у уже оформленной подписки этого подключения (адрес берём у MAX — он тот же)."""
    subs = (max_call(token, "GET", "/subscriptions") or {}).get("subscriptions") or []
    done = 0
    for sub in subs:
        url = str(sub.get("url") or "")
        if f"/api/social/hook/{account_id}/" in url:
            max_call(token, "POST", "/subscriptions", body={"url": url, "update_types": MAX_UPDATES})
            done += 1
    return done


def max_disconnect(token: str, hook_url: str) -> None:
    max_call(token, "DELETE", "/subscriptions", params={"url": hook_url})


def _max_name(sender: dict) -> str:
    return sender.get("name") or " ".join(x for x in (sender.get("first_name"), sender.get("last_name")) if x) or sender.get("username") or ""


def _max_avatar(sender: dict) -> str:
    url = str(sender.get("full_avatar_url") or sender.get("avatar_url") or "")
    return url if url.startswith("https://") else ""


def _max_comment(update: dict) -> Optional[Incoming]:
    """Комментарий под постом канала. Пост — recipient.post_id, сам комментарий — body.mid; диалог —
    автор под этим постом, ответ — комментарием-ответом на его последний комментарий."""
    msg = update.get("message") or {}
    sender = msg.get("sender") or {}
    if not sender or sender.get("is_bot"):
        return None  # от имени канала или бот — не входящее
    recipient = msg.get("recipient") or {}
    body = msg.get("body") or {}
    post_id, mid, text = str(recipient.get("post_id") or ""), str(body.get("mid") or ""), body.get("text") or ""
    if not post_id or not mid or not text:
        return None
    name = _max_name(sender)
    return Incoming(
        ext_chat_id=str(recipient.get("chat_id") or ""), ext_message_id=mid, chat_title="", chat_type="comments",
        author_id=str(sender.get("user_id") or ""), author_name=name or "Без имени", author_username=sender.get("username") or "",
        author_avatar=_max_avatar(sender), text=text, link=None, thread=post_id, reply={"kind": "comment", "post_id": post_id, "mid": mid},
    )


def max_parse(update: dict) -> Optional[Incoming]:
    if update.get("update_type") == "comment_created":
        return _max_comment(update)
    if update.get("update_type") != "message_created":
        return None
    msg = update.get("message") or {}
    sender = msg.get("sender") or {}
    if sender.get("is_bot"):
        return None
    recipient = msg.get("recipient") or {}
    if recipient.get("chat_type") == "channel":
        return None  # пост самого канала, а не сообщение клиента
    body = msg.get("body") or {}
    text = body.get("text") or ""
    labels = {"image": "Фото", "video": "Видео", "audio": "Аудио", "file": "Файл", "sticker": "Стикер", "location": "Геопозиция", "contact": "Контакт"}
    media = [labels.get(a.get("type"), "Вложение") for a in (body.get("attachments") or []) if isinstance(a, dict) and a.get("type") != "inline_keyboard"]
    if not text and not media:
        return None
    chat_type = recipient.get("chat_type")
    name = _max_name(sender)
    kind = "private" if chat_type == "dialog" else "group"
    return Incoming(
        ext_chat_id=str(recipient.get("chat_id") or ""), ext_message_id=str(body.get("mid") or ""),
        chat_title=name if kind == "private" else "", chat_type=kind,
        author_id=str(sender.get("user_id") or ""), author_name=name or "Без имени", author_username=sender.get("username") or "",
        author_avatar=_max_avatar(sender), text=text, media=media, link=msg.get("url") or (f"https://max.ru/{sender['username']}" if kind == "private" and sender.get("username") else None),
    )


def max_change(update: dict) -> Optional[Change]:
    """Правка или удаление сообщения или комментария. Правка приходит целым сообщением, удаление — только id."""
    kind = update.get("update_type")
    if kind in ("message_edited", "comment_edited"):
        msg = update.get("message") or {}
        body = msg.get("body") or {}
        mid = str(body.get("mid") or "")
        chat = str((msg.get("recipient") or {}).get("chat_id") or "")
        return Change("edit", chat, mid, mid, body.get("text") or "") if mid and chat else None
    if kind in ("message_removed", "comment_removed"):
        mid, chat = str(update.get("message_id") or ""), str(update.get("chat_id") or "")
        return Change("delete", chat, mid, mid) if mid and chat else None
    return None


def max_chat_title(token: str, chat_id: str) -> str:
    try:
        return str(max_call(token, "GET", f"/chats/{chat_id}").get("title") or "")
    except PlatformError:
        return ""


def max_post_text(token: str, post_id: str) -> str:
    """Текст поста — подпись к ветке комментариев (не вышло — без неё)."""
    try:
        got = max_call(token, "GET", f"/messages/{post_id}") or {}
        return str(((got.get("message") or got).get("body") or {}).get("text") or "").strip()[:300]
    except PlatformError:
        return ""


def max_reply(token: str, ext_chat_id: str, ext_message_id: str, text: str, target: Optional[Dict[str, Any]] = None) -> str:
    if (target or {}).get("kind") == "comment":
        sent = max_call(token, "POST", f"/messages/{target['post_id']}/comments",
                        body={"text": text, "link": {"type": "reply", "mid": target["mid"]}})
        return str(((sent or {}).get("message") or {}).get("body", {}).get("mid") or "")
    sent = max_call(token, "POST", "/messages", params={"chat_id": ext_chat_id},
                    body={"text": text, "link": {"type": "reply", "mid": ext_message_id}})
    return str(((sent or {}).get("message") or {}).get("body", {}).get("mid") or "")


# Отказы при правке и удалении — по-русски. MAX отвечает на них и HTTP-ошибкой, и 200 с success=false.
_MAX_CHANGE_ERRORS = {
    "comments.timeout_exceeded": "Комментарий можно изменить только в первые 26 часов после отправки",
}


def _max_change_call(token: str, method: str, path: str, params: dict, body: Optional[dict] = None) -> None:
    try:
        got = max_call(token, method, path, params=params, body=body)
    except PlatformError as e:
        raise PlatformError(_MAX_CHANGE_ERRORS.get(e.code) or str(e), e.code) from None
    if isinstance(got, dict) and got.get("success") is False:
        text = str(got.get("message") or "")
        known = next((v for k, v in _MAX_CHANGE_ERRORS.items() if k in text), "")
        if not known and "admin" in text.lower():
            known = "Боту нужны права администратора с удалением сообщений"
        raise PlatformError(known or f"MAX: {text or 'не получилось'}")


def max_edit(token: str, sent_id: str, text: str, target: Dict[str, Any]) -> None:
    """Исправить своё сообщение (в диалоге с ботом — пока ему меньше 7 дней) или комментарий (первые 26 часов).
    Вложения не трогаем: без поля attachments MAX оставляет их как были."""
    if target.get("kind") == "comment":
        _max_change_call(token, "PUT", f"/messages/{target['post_id']}/comments", {"comment_id": sent_id}, {"text": text})
        return
    body: Dict[str, Any] = {"text": text}
    if target.get("reply_mid"):
        body["link"] = {"type": "reply", "mid": target["reply_mid"]}  # иначе правка может снять цитату
    _max_change_call(token, "PUT", "/messages", {"message_id": sent_id}, body)


def max_delete(token: str, sent_id: str, target: Dict[str, Any]) -> None:
    """Удалить своё сообщение у всех. В чатах и каналах боту нужны права администратора на удаление."""
    if target.get("kind") == "comment":
        _max_change_call(token, "DELETE", f"/messages/{target['post_id']}/comments", {"comment_id": sent_id})
        return
    _max_change_call(token, "DELETE", "/messages", {"message_id": sent_id})


def max_send_files(token: str, ext_chat_id: str, ext_message_id: str, text: str, files: List[tuple],
                   target: Optional[Dict[str, Any]] = None) -> str:
    """Ответ с вложениями в MAX: файл грузится по выданному адресу, в сообщение идёт его токен.
    Только что загруженный файл MAX может ещё обрабатывать (attachment.not.ready) — повторяем."""
    import time  # noqa: PLC0415

    if (target or {}).get("kind") == "comment":
        raise PlatformError("В комментарии MAX файлы не прикрепить — только текст")
    attachments = []
    for name, data, content_type in files:
        kind = "image" if (content_type or "").startswith("image/") else "file"
        slot = max_call(token, "POST", "/uploads", params={"type": kind})
        try:
            res = requests.post(slot["url"], files={"data": (name, data, content_type or "application/octet-stream")},
                                headers={"Authorization": token}, timeout=120, verify=ca_bundle())
            up = res.json() if res.content else {}
        except (requests.RequestException, ValueError, KeyError) as e:
            raise PlatformError(f"MAX не принял файл «{name}» ({type(e).__name__})") from None
        payload = up if kind == "image" else {"token": up.get("token") or slot.get("token")}
        attachments.append({"type": kind, "payload": payload})
    body: Dict[str, Any] = {"text": text or None, "attachments": attachments, "link": {"type": "reply", "mid": ext_message_id}}
    for attempt in range(4):
        try:
            sent = max_call(token, "POST", "/messages", params={"chat_id": ext_chat_id}, body=body)
            return str(((sent or {}).get("message") or {}).get("body", {}).get("mid") or "")
        except PlatformError as e:
            if "not.ready" not in (e.code or str(e)) or attempt == 3:
                raise
            time.sleep(1 + attempt)
    return ""
