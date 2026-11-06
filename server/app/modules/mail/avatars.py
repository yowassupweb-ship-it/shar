"""Аватарки отправителей в почте.

Другие почтовые клиенты показывают у письма не буквы, а лицо отправителя: фото из Gravatar, логотип
компании (BIMI — его компания публикует в DNS) или значок её сайта. Шар до сих пор рисовал только буквы,
потому что у чужого адреса нет «своей» фотографии в Шаре.

Здесь та же лесенка, но только по публичным правилам, без чужих внутренностей:
  1. Gravatar — по хешу адреса (https://docs.gravatar.com/api/avatars/);
  2. BIMI — запись default._bimi.<домен> (через DNS-over-HTTPS Cloudflare), в ней ссылка на SVG-логотип;
  3. значок сайта домена (apple-touch-icon / icon / favicon.ico) — для корпоративных адресов, не для
     публичных почтовых сервисов: gmail.com не должен получать логотип Gmail.

Всё скачивается сервером (браузер не раскрывает адрес читателя посторонним сайтам), каждый адрес проверяется
как публичный (см. og.router — защита от SSRF), результат пережимается в маленький PNG и кэшируется
в памяти и на диске. Нет лица — 204, клиент рисует буквы.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import re
import threading
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

from fastapi import APIRouter, Depends, Response
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.core.ratelimit import limiter
from app.core.security import Identity, current_identity
from app.modules.og.router import _og_fetch_is_safe_url

router = APIRouter()
log = logging.getLogger("shar.mail.avatars")

_SIZE = 96
_HIT_TTL = 7 * 86400.0
_MISS_TTL = 12 * 3600.0
_MAX_IMAGE = 512 * 1024
_MAX_PAGE = 256 * 1024
_MAX_SVG = 64 * 1024
_CACHE_DIR: Path = settings.data_dir / "mail-avatars"

# Публичные почтовые сервисы: их значок — это значок сервиса, а не отправителя.
_FREE_MAIL = {
    "gmail.com", "googlemail.com", "mail.ru", "inbox.ru", "list.ru", "bk.ru", "internet.ru", "yandex.ru", "yandex.com", "ya.ru",
    "yandex.by", "yandex.kz", "ukr.net", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
    "yahoo.com", "yahoo.ru", "aol.com", "proton.me", "protonmail.com", "pm.me", "rambler.ru", "bigmir.net", "tut.by", "gmx.com",
    "gmx.de", "web.de", "zoho.com", "fastmail.com", "tutanota.com", "hey.com", "qq.com", "163.com", "126.com",
}

_EMAIL = re.compile(r"^[^@\s<>\"']{1,64}@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$")

# (истекает, (байты, mime) или None) — в памяти; на диске живут только найденные лица.
_mem: dict[str, tuple[float, tuple[bytes, str] | None]] = {}
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_net = threading.BoundedSemaphore(8)


def _key_lock(key: str) -> threading.Lock:
    with _locks_guard:
        if len(_locks) > 4000:
            _locks.clear()
        return _locks.setdefault(key, threading.Lock())


def _disk_path(key: str, ext: str) -> Path:
    return _CACHE_DIR / f"{hashlib.sha1(key.encode()).hexdigest()}.{ext}"


def _cache_get(key: str) -> tuple[bool, tuple[bytes, str] | None]:
    """(известно ли, значение). Память, потом диск; промахи помним только в памяти."""
    hit = _mem.get(key)
    now = time.time()
    if hit and hit[0] > now:
        return True, hit[1]
    for ext, mime in (("png", "image/png"), ("svg", "image/svg+xml")):
        path = _disk_path(key, ext)
        try:
            if path.exists() and now - path.stat().st_mtime < _HIT_TTL:
                value = (path.read_bytes(), mime)
                _mem[key] = (now + _HIT_TTL, value)
                return True, value
        except OSError:
            pass
    return False, None


def _cache_put(key: str, value: tuple[bytes, str] | None) -> None:
    if len(_mem) > 3000:
        _mem.clear()
    _mem[key] = (time.time() + (_HIT_TTL if value else _MISS_TTL), value)
    if value:
        try:
            _CACHE_DIR.mkdir(parents=True, exist_ok=True)
            _disk_path(key, "svg" if value[1] == "image/svg+xml" else "png").write_bytes(value[0])
        except OSError as exc:
            log.debug("mail avatar: disk cache failed: %s", exc)


def _get(url: str, limit: int, accept: str = "*/*") -> tuple[bytes, str] | None:
    """Скачать публичный адрес: вручную по переходам, каждый — с проверкой «не внутренняя сеть»; тело — не больше limit."""
    import requests

    current = url
    for _ in range(4):
        if not _og_fetch_is_safe_url(current):
            return None
        try:
            with _net:
                resp = requests.get(current, timeout=6, stream=True, allow_redirects=False,
                                    headers={"User-Agent": "Mozilla/5.0 (compatible; SharMail/1.0)", "Accept": accept})
                if resp.is_redirect or resp.is_permanent_redirect:
                    nxt = resp.headers.get("Location")
                    resp.close()
                    if not nxt:
                        return None
                    current = urljoin(current, nxt)
                    continue
                if resp.status_code != 200:
                    resp.close()
                    return None
                raw = b""
                for chunk in resp.iter_content(16384):
                    raw += chunk
                    if len(raw) > limit:
                        resp.close()
                        return None
                kind = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                resp.close()
                return raw, kind
        except Exception as exc:  # сеть и чужие сайты — штатно ненадёжны
            log.debug("mail avatar: fetch %s failed: %s", current, exc)
            return None
    return None


def _to_png(raw: bytes) -> tuple[bytes, str] | None:
    """Любую картинку — в квадратный PNG 96×96 по центру (Pillow заодно отсекает не-картинки)."""
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(raw))
        if hasattr(img, "n_frames") and getattr(img, "n_frames", 1) > 1 and img.format == "ICO":
            # В .ico несколько размеров — берём самый большой.
            sizes = sorted(img.info.get("sizes") or [], key=lambda s: s[0] * s[1])
            if sizes:
                img.size = sizes[-1]
        img = img.convert("RGBA")
        if min(img.size) < 24:
            return None
        img.thumbnail((_SIZE, _SIZE))
        canvas = Image.new("RGBA", (_SIZE, _SIZE), (0, 0, 0, 0))
        canvas.paste(img, ((_SIZE - img.width) // 2, (_SIZE - img.height) // 2), img)
        out = io.BytesIO()
        canvas.save(out, "PNG", optimize=True)
        return out.getvalue(), "image/png"
    except Exception:
        return None


def _safe_svg(raw: bytes) -> tuple[bytes, str] | None:
    """SVG-логотип BIMI. В <img> скрипты не исполняются, но отдаём только чистую разметку без скриптов и внешних ссылок."""
    if len(raw) > _MAX_SVG:
        return None
    text = raw.decode("utf-8", "ignore")
    head = text.lstrip()[:200].lower()
    if not (head.startswith("<svg") or head.startswith("<?xml")):
        return None
    low = text.lower()
    if any(bad in low for bad in ("<script", "<foreignobject", "javascript:", " onload=", " onerror=", "<iframe", "<image", "xlink:href=\"http", "href=\"http")):
        return None
    return text.encode("utf-8"), "image/svg+xml"


def _gravatar(email: str) -> tuple[bytes, str] | None:
    digest = hashlib.sha256(email.strip().lower().encode()).hexdigest()
    got = _get(f"https://www.gravatar.com/avatar/{digest}?s={_SIZE * 2}&d=404", _MAX_IMAGE, "image/*")
    return _to_png(got[0]) if got else None


def _bimi(domain: str) -> tuple[bytes, str] | None:
    """default._bimi.<домен>: «v=BIMI1; l=https://…/logo.svg». DNS — через публичный DoH (в Python нет своего TXT-резолвера)."""
    got = _get(f"https://cloudflare-dns.com/dns-query?name=default._bimi.{domain}&type=TXT", 16384, "application/dns-json")
    if not got:
        return None
    try:
        answers = (json.loads(got[0].decode("utf-8", "ignore")).get("Answer") or [])
    except ValueError:
        return None
    for ans in answers:
        data = str(ans.get("data") or "").replace('" "', "").strip('"')
        if "v=BIMI1" not in data:
            continue
        found = re.search(r"\bl=\s*(https://[^;\s]+)", data)
        if not found:
            continue
        logo = _get(found.group(1), _MAX_SVG, "image/svg+xml")
        if logo:
            svg = _safe_svg(logo[0])
            if svg:
                return svg
    return None


_LINK = re.compile(r"<link\b[^>]*>", re.I)


def _site_icons(page_url: str, html: str) -> list[str]:
    """Значки из <link>: apple-touch-icon, потом крупные icon, потом остальные; в конце — /favicon.ico."""
    scored: list[tuple[int, str]] = []
    for tag in _LINK.findall(html[:60000]):
        rel = re.search(r"rel\s*=\s*[\"']([^\"']+)[\"']", tag, re.I)
        href = re.search(r"href\s*=\s*[\"']([^\"']+)[\"']", tag, re.I)
        if not rel or not href or "icon" not in rel.group(1).lower() or "mask-icon" in rel.group(1).lower():
            continue
        if href.group(1).strip().lower().endswith(".svg"):
            continue  # Pillow SVG не читает; у сайта обычно есть и растровый значок
        size = re.search(r"sizes\s*=\s*[\"'](\d+)x\d+", tag, re.I)
        score = (int(size.group(1)) if size else 16) + (1000 if "apple-touch" in rel.group(1).lower() else 0)
        scored.append((score, urljoin(page_url, href.group(1).strip())))
    urls = [u for _, u in sorted(scored, key=lambda x: -x[0])]
    parsed = urlparse(page_url)
    urls.append(f"{parsed.scheme}://{parsed.netloc}/favicon.ico")
    seen: list[str] = []
    for u in urls:
        if u not in seen:
            seen.append(u)
    return seen[:4]


def _site_icon(domain: str) -> tuple[bytes, str] | None:
    hosts = [domain]
    labels = domain.split(".")
    if len(labels) >= 3:
        hosts.append(".".join(labels[1:]))  # mail.company.ru → company.ru
    for host in hosts:
        for start in (f"https://{host}/", f"https://www.{host}/"):
            page = _get(start, _MAX_PAGE, "text/html")
            if not page or "html" not in page[1]:
                continue
            html = page[0].decode("utf-8", "ignore")
            for icon_url in _site_icons(start, html):
                icon = _get(icon_url, _MAX_IMAGE, "image/*")
                png = _to_png(icon[0]) if icon else None
                if png:
                    return png
            break
    return None


def _cached(key: str, make) -> tuple[bytes, str] | None:
    known, value = _cache_get(key)
    if known:
        return value
    with _key_lock(key):
        known, value = _cache_get(key)  # пока ждали замок, другой запрос уже мог найти
        if known:
            return value
        value = make()
        _cache_put(key, value)
        return value


def lookup(email: str) -> tuple[bytes, str] | None:
    """Лицо отправителя по адресу или None."""
    addr = (email or "").strip().lower()
    found = _EMAIL.match(addr)
    if not found:
        return None
    domain = found.group(1)
    if not re.search(r"\.[a-z][a-z0-9-]*$", domain):
        return None  # a@127.0.0.1 и прочие числовые «домены» — не почта людей
    face = _cached(f"a:{addr}", lambda: _gravatar(addr))
    if face:
        return face
    if domain in _FREE_MAIL:
        return None
    return _cached(f"d:{domain}", lambda: _bimi(domain) or _site_icon(domain))


@router.get("/api/mail/avatar")
async def mail_avatar(email: str, me: Identity = Depends(current_identity)):
    """Лицо отправителя для списка писем. 204 — лица нет, клиент рисует буквы."""
    if not limiter.allow(f"mail-avatar:{me.user_id}", 600, 60):
        return Response(status_code=429)
    face = await run_in_threadpool(lookup, email)
    if not face:
        return Response(status_code=204, headers={"Cache-Control": "private, max-age=3600"})
    return Response(
        content=face[0], media_type=face[1],
        headers={
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )
