"""ВКонтакте: Callback API сообщества.

Ключ — ключ доступа сообщества (Управление → Работа с API → Ключи доступа) с правами «Управление
сообществом», «Сообщения сообщества», «Стена». Шар сам добавляет свой адрес Callback-сервером
и включает события; ВКонтакте сначала проверяет адрес — присылает confirmation и ждёт в ответ код
сообщества, поэтому код сохраняется до подписки (vk_prepare → запись подключения → vk_subscribe).

Что приходит: сообщения сообществу и из бесед, где оно состоит; комментарии на стене, к фото,
видео, товарам и в обсуждениях. Ответить из Шара можно на сообщения и на комментарии на стене —
остальное ВКонтакте даёт комментировать только от имени человека, там — ссылка."""

from __future__ import annotations

import secrets
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests

from app.modules.social.platforms import TIMEOUT, Incoming, PlatformError
from app.modules.social.tls import ca_bundle

VK_API = "https://api.vk.com/method/"
VK_VERSION = "5.199"
VK_EVENTS = ["message_new", "message_reply", "wall_reply_new", "photo_comment_new", "video_comment_new", "market_comment_new", "board_post_new"]

# Частые отказы ВКонтакте — по-русски и с тем, что делать.
_ERRORS = {
    5: "ВКонтакте не принял ключ доступа — создайте новый в настройках сообщества (Работа с API → Ключи доступа)",
    7: "У ключа нет нужных прав — нужны «Управление сообществом», «Сообщения сообщества» и «Стена»",
    15: "ВКонтакте запретил это действие для сообщества",
    27: "Это ключ пользователя, а нужен ключ сообщества",
    203: "Нет доступа к сообществу",
    213: "Комментарии к этой записи закрыты",
    222: "ВКонтакте не пропускает ссылки в этом ответе",
    900: "Клиент добавил сообщество в чёрный список",
    901: "Клиент не разрешил сообществу писать ему — ответить можно, когда он напишет снова",
    902: "Клиент закрыл сообщения в настройках приватности",
    917: "У сообщества нет доступа к этой беседе",
    2000: "У сообщества уже 10 Callback-серверов — удалите лишний (Работа с API → Callback API)",
}


def call(token: str, method: str, **params: Any) -> Any:
    try:
        res = requests.post(VK_API + method, data={**params, "access_token": token, "v": VK_VERSION}, timeout=TIMEOUT, verify=ca_bundle())
        data = res.json()
    except (requests.RequestException, ValueError) as e:
        raise PlatformError(f"ВКонтакте не ответил ({type(e).__name__})") from None
    if "error" in data:
        err = data["error"] or {}
        code = int(err.get("error_code") or 0)
        raise PlatformError(_ERRORS.get(code) or f"ВКонтакте: {err.get('error_msg') or code}")
    return data.get("response")


def prepare(token: str) -> Dict[str, Any]:
    """Сообщество по ключу и код подтверждения адреса."""
    got = call(token, "groups.getById")
    groups = got.get("groups") if isinstance(got, dict) else got
    group = (groups or [{}])[0] or {}
    if not group.get("id"):
        raise PlatformError("Это не ключ сообщества — создайте ключ в настройках сообщества (Работа с API → Ключи доступа)")
    code = call(token, "groups.getCallbackConfirmationCode", group_id=group["id"]) or {}
    return {"groupId": int(group["id"]), "botName": group.get("name") or "", "botUsername": group.get("screen_name") or "",
            "confirmation": str(code.get("code") or "")}


def subscribe(token: str, group_id: int, hook_url: str, secret: str) -> int:
    """Добавить (или найти уже добавленный) Callback-сервер Шара и включить события."""
    servers = (call(token, "groups.getCallbackServers", group_id=group_id) or {}).get("items") or []
    server = next((x for x in servers if x.get("url") == hook_url), None)
    if server:
        server_id = int(server["id"])
        call(token, "groups.editCallbackServer", group_id=group_id, server_id=server_id, url=hook_url, title="Shar", secret_key=secret)
    else:
        server_id = int((call(token, "groups.addCallbackServer", group_id=group_id, url=hook_url, title="Shar", secret_key=secret) or {}).get("server_id") or 0)
    call(token, "groups.setCallbackSettings", group_id=group_id, server_id=server_id, api_version=VK_VERSION, **{e: 1 for e in VK_EVENTS})
    return server_id


def disconnect(token: str, group_id: int, server_id: int) -> None:
    call(token, "groups.deleteCallbackServer", group_id=group_id, server_id=server_id)


def _person(token: str, user_id: int) -> dict:
    """В событиях ВКонтакте только id автора — имя спрашиваем отдельно (не вышло — покажем id)."""
    try:
        got = call(token, "users.get", user_ids=user_id, fields="screen_name,photo_100") or []
        return got[0] if got else {}
    except PlatformError:
        return {}


def _name(person: dict, user_id: int) -> str:
    return " ".join(x for x in (person.get("first_name"), person.get("last_name")) if x) or f"id{user_id}"


def _media(attachments: Any) -> List[str]:
    labels = {"photo": "Фото", "video": "Видео", "audio": "Аудио", "doc": "Файл", "sticker": "Стикер", "audio_message": "Голосовое",
              "wall": "Запись", "link": "Ссылка", "market": "Товар", "poll": "Опрос", "graffiti": "Граффити"}
    return [labels.get(a.get("type"), "Вложение") for a in (attachments or []) if isinstance(a, dict)]


def _best(sizes: Any) -> str:
    sizes = [x for x in (sizes or []) if isinstance(x, dict) and x.get("url")]
    return max(sizes, key=lambda x: int(x.get("width") or 0) * int(x.get("height") or 0), default={}).get("url") or ""


def _images(attachments: Any) -> List[str]:
    """Адреса картинок во вложениях: фото, стикеры, граффити, картинки-документы, фото в ссылках."""
    out: List[str] = []
    for a in attachments or []:
        if not isinstance(a, dict):
            continue
        kind = a.get("type")
        obj = a.get(kind) or {}
        url = ""
        if kind == "photo":
            url = _best(obj.get("sizes"))
        elif kind == "sticker":
            url = _best(obj.get("images"))
        elif kind == "graffiti":
            url = obj.get("url") or ""
        elif kind == "doc" and str(obj.get("ext") or "").lower() in ("jpg", "jpeg", "png", "gif", "webp"):
            url = obj.get("url") or ""
        elif kind == "link":
            url = _best((obj.get("photo") or {}).get("sizes"))
        if url.startswith("https://"):
            out.append(url)
    return out


def _post_text(token: str, owner_id: int, post_id: int) -> str:
    try:
        got = call(token, "wall.getById", posts=f"{owner_id}_{post_id}") or []
        posts = got.get("items") if isinstance(got, dict) else got
        return str((posts or [{}])[0].get("text") or "").strip()[:300]
    except PlatformError:
        return ""


# Комментарии: событие → (поле владельца, поле объекта, область, подпись источника).
_COMMENTS = {
    "wall_reply_new": ("owner_id", "post_id", "wall", "стена"),
    "photo_comment_new": ("photo_owner_id", "photo_id", "photo", "фото"),
    "video_comment_new": ("video_owner_id", "video_id", "video", "видео"),
    "market_comment_new": ("market_owner_id", "item_id", "market", "товары"),
    "board_post_new": ("topic_owner_id", "topic_id", "topic", "обсуждения"),
}


def message_incoming(msg: dict, person: dict, group_id: int, title: str = "") -> Optional[Incoming]:
    """Сообщение клиента (событие или строка истории) → входящее. Пустое — None."""
    author = int(msg.get("from_id") or 0)
    text, media = msg.get("text") or "", _media(msg.get("attachments"))
    if not text and not media:
        return None
    peer = int(msg.get("peer_id") or author)
    chat = peer >= 2_000_000_000  # беседа, а не личный диалог
    return Incoming(
        ext_chat_id=str(peer), ext_message_id=str(msg.get("id") or msg.get("conversation_message_id")),
        chat_title=(title or "Беседа ВКонтакте") if chat else _name(person, author), chat_type="group" if chat else "private",
        author_id=str(author), author_name=_name(person, author), author_username=person.get("screen_name") or "",
        author_avatar=person.get("photo_100") or "", text=text, media=media, images=_images(msg.get("attachments")),
        link=f"https://vk.com/gim{group_id}?sel={peer}" if group_id else None,
        reply={"kind": "message", "peer_id": peer},
    )


def parse(event: dict, token: str, group_name: str = "") -> Optional[Incoming]:
    kind = event.get("type")
    obj = event.get("object") or {}
    group_id = int(event.get("group_id") or 0)

    if kind == "message_new":
        msg = obj.get("message") or obj
        author = int(msg.get("from_id") or 0)
        if author <= 0:
            return None  # ответ самого сообщества
        return message_incoming(msg, _person(token, author), group_id)

    if kind not in _COMMENTS:
        return None
    owner_key, item_key, area, label = _COMMENTS[kind]
    author = int(obj.get("from_id") or 0)
    if author <= 0:
        return None
    text, media = obj.get("text") or "", _media(obj.get("attachments"))
    if not text and not media:
        return None
    owner, item, cid = int(obj.get(owner_key) or -group_id), int(obj.get(item_key) or 0), int(obj.get("id") or 0)
    links = {
        "wall": f"https://vk.com/wall{owner}_{item}?reply={cid}",
        "photo": f"https://vk.com/photo{owner}_{item}",
        "video": f"https://vk.com/video{owner}_{item}",
        "market": f"https://vk.com/market{owner}?w=product{owner}_{item}",
        "topic": f"https://vk.com/topic{owner}_{item}?post={cid}",
    }
    person = _person(token, author)
    return Incoming(
        ext_chat_id=f"{area}{owner}", ext_message_id=f"{item}_{cid}",
        chat_title=f"{group_name or 'Сообщество'} — {label}", chat_type="comments",
        author_id=str(author), author_name=_name(person, author), author_username=person.get("screen_name") or "",
        author_avatar=person.get("photo_100") or "", text=text, media=media, images=_images(obj.get("attachments")), link=links[area],
        context=_post_text(token, owner, item) if area == "wall" else "",
        reply={"kind": "wall", "owner_id": owner, "post_id": item, "comment_id": cid} if area == "wall" else {},
        can_reply=area == "wall", thread=str(item),
    )


def reply(token: str, target: Dict[str, Any], text: str) -> str:
    if target.get("kind") == "message":
        return str(call(token, "messages.send", peer_id=target["peer_id"], random_id=secrets.randbits(31), message=text) or "")
    if target.get("kind") == "wall":
        sent = call(token, "wall.createComment", owner_id=target["owner_id"], post_id=target["post_id"],
                    from_group=abs(int(target["owner_id"])), message=text, reply_to_comment=target["comment_id"])
        return str((sent or {}).get("comment_id") or "")
    raise PlatformError("На этот комментарий ВКонтакте даёт ответить только на самом сайте — откройте его по ссылке")


# ─── Вложения ────────────────────────────────────────────────────────────────
# Только в сообщения: ВКонтакте даёт ключу сообщества загружать фото и документы для диалога
# (photos.getMessagesUploadServer, docs.getMessagesUploadServer). Для комментариев на стене нужна
# загрузка от имени человека — там вложений из Шара нет.

IMAGE_TYPES = ("image/jpeg", "image/png", "image/gif", "image/webp")


def _upload(url: str, field: str, name: str, data: bytes, content_type: str) -> dict:
    try:
        res = requests.post(url, files={field: (name, data, content_type or "application/octet-stream")}, timeout=120, verify=ca_bundle())
        return res.json()
    except (requests.RequestException, ValueError) as e:
        raise PlatformError(f"ВКонтакте не принял файл «{name}» ({type(e).__name__})") from None


def upload_for_message(token: str, peer_id: int, name: str, data: bytes, content_type: str) -> str:
    """Загрузить файл для сообщения в диалог. Возвращает строку вложения для messages.send."""
    if content_type in IMAGE_TYPES:
        server = call(token, "photos.getMessagesUploadServer", peer_id=peer_id) or {}
        up = _upload(server["upload_url"], "photo", name, data, content_type)
        if not up.get("photo") or up.get("photo") == "[]":
            raise PlatformError(f"ВКонтакте не принял фото «{name}»")
        saved = (call(token, "photos.saveMessagesPhoto", photo=up["photo"], server=up["server"], hash=up["hash"]) or [{}])[0]
        key = f"_{saved['access_key']}" if saved.get("access_key") else ""
        return f"photo{saved['owner_id']}_{saved['id']}{key}"
    server = call(token, "docs.getMessagesUploadServer", type="doc", peer_id=peer_id) or {}
    up = _upload(server["upload_url"], "file", name, data, content_type)
    if not up.get("file"):
        raise PlatformError(f"ВКонтакте не принял файл «{name}»: {up.get('error_descr') or up.get('error') or 'неизвестная ошибка'}")
    saved = call(token, "docs.save", file=up["file"], title=name) or {}
    doc = saved.get("doc") or (saved[0] if isinstance(saved, list) and saved else {})
    return f"doc{doc['owner_id']}_{doc['id']}"


def send_files(token: str, target: Dict[str, Any], text: str, files: List[tuple]) -> str:
    """Ответ с вложениями (только в диалог). files — [(имя, байты, тип)]."""
    if target.get("kind") != "message":
        raise PlatformError("В комментарии ВКонтакте файлы из Шара не отправить — только текст")
    attachments = [upload_for_message(token, int(target["peer_id"]), n, d, t) for n, d, t in files]
    params: Dict[str, Any] = {"peer_id": target["peer_id"], "random_id": secrets.randbits(31), "attachment": ",".join(attachments)}
    if text:
        params["message"] = text
    return str(call(token, "messages.send", **params) or "")


# ─── История ─────────────────────────────────────────────────────────────────
# Callback API присылает только новое. Старые диалоги Шар забирает сам: messages.getConversations
# (все диалоги сообщества) и messages.getHistory (переписка с каждым). Комментарии ВКонтакте
# сообществу задним числом не отдаёт — они приходят только по мере появления.

def _pages(token: str, method: str, limit: int, **params: Any):
    """Постранично (по 200) до конца или до limit записей."""
    offset = 0
    while offset < limit:
        got = call(token, method, count=200, offset=offset, **params) or {}
        items = got.get("items") or []
        yield got, items
        if len(items) < 200:
            return
        offset += 200
        time.sleep(0.1)  # лимит ВКонтакте — 20 запросов в секунду у сообщества, не торопимся


def conversations(token: str, limit: int = 5000):
    """Диалоги сообщества: (peer_id, название беседы, профили). Только личные и беседы."""
    for got, items in _pages(token, "messages.getConversations", limit, extended=1, fields="screen_name,photo_100", filter="all"):
        people = {int(p["id"]): p for p in (got.get("profiles") or []) if p.get("id")}
        for it in items:
            conv = it.get("conversation") or {}
            peer = conv.get("peer") or {}
            if peer.get("type") not in ("user", "chat"):
                continue
            yield int(peer["id"]), ((conv.get("chat_settings") or {}).get("title") or ""), people


def history(token: str, peer_id: int, limit: int = 3000):
    """Переписка с собеседником от старых к новым: (сообщение, профили)."""
    rows: List[tuple] = []
    for got, items in _pages(token, "messages.getHistory", limit, peer_id=peer_id, extended=1, fields="screen_name,photo_100"):
        people = {int(p["id"]): p for p in (got.get("profiles") or []) if p.get("id")}
        rows += [(m, people) for m in items]
    return sorted(rows, key=lambda r: (int(r[0].get("date") or 0), int(r[0].get("id") or 0)))


def sent_incoming(msg: dict, person: dict, group_id: int, title: str = "") -> Optional[Incoming]:
    """Сообщение, отправленное от имени сообщества не из Шара (из ВКонтакте, другим сервисом)."""
    peer = int(msg.get("peer_id") or 0)
    text, media = msg.get("text") or "", _media(msg.get("attachments"))
    if not peer or (not text and not media):
        return None
    admin = int(msg.get("admin_author_id") or 0)
    return Incoming(
        ext_chat_id=str(peer), ext_message_id=str(msg.get("id") or msg.get("conversation_message_id")),
        chat_title=title, chat_type="group" if peer >= 2_000_000_000 else "private",
        author_id=str(admin or msg.get("from_id") or ""), author_name=_name(person, admin) if admin else "Сообщество",
        text=text, media=media, images=_images(msg.get("attachments")),
        link=f"https://vk.com/gim{group_id}?sel={peer}" if group_id else None, reply={"kind": "message", "peer_id": peer},
    )


def stamp(msg: dict) -> datetime:
    return datetime.fromtimestamp(int(msg.get("date") or time.time()), tz=timezone.utc)
