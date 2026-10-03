from __future__ import annotations

import time
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from app.core.ratelimit import limiter
from app.core.security import Identity, current_identity

router = APIRouter()


def _og_fetch_is_safe_url(url: str) -> bool:
    """Reject anything that isn't a plain http(s) URL resolving to a public
    address. Without this, /api/og (no auth required) is a generic SSRF
    proxy: point it at http://169.254.169.254/ or http://localhost:PORT/
    and the title/description of whatever comes back is reflected to the
    caller. Call again on every redirect hop, not just the original URL."""
    import ipaddress
    import socket
    from urllib.parse import urlparse as _urlparse

    parsed = _urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return False
    try:
        resolved = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror:
        return False
    for info in resolved:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (addr.is_private or addr.is_loopback or addr.is_link_local
                or addr.is_multicast or addr.is_reserved or addr.is_unspecified):
            return False
    return True


def _fetch_og(url: str) -> dict:
    """Fetch Open Graph / basic HTML metadata from a URL. Returns dict with title/description/image/favicon/siteName."""
    _empty = {'title': '', 'description': '', 'image': '', 'siteName': '', 'favicon': ''}
    try:
        from html.parser import HTMLParser as _HP
        from urllib.parse import urljoin as _urljoin
        from urllib.parse import urlparse as _urlparse

        import requests as _req

        if not _og_fetch_is_safe_url(url):
            return _empty

        class _P(_HP):
            def __init__(self):
                super().__init__()
                self.og: dict = {}
                self._title: list = []
                self._in_title = False
            def handle_starttag(self, tag, attrs):
                a = dict(attrs)
                if tag == 'meta':
                    prop = a.get('property') or a.get('name') or ''
                    val = a.get('content') or ''
                    if prop in ('og:title', 'og:description', 'og:image', 'og:site_name'):
                        self.og[prop] = val
                    elif prop == 'description' and 'og:description' not in self.og:
                        self.og['og:description'] = val
                elif tag == 'link':
                    rel = a.get('rel') or ''
                    if 'icon' in rel:
                        self.og.setdefault('_favicon', a.get('href') or '')
                elif tag == 'title':
                    self._in_title = True
            def handle_data(self, data):
                if self._in_title:
                    self._title.append(data)
            def handle_endtag(self, tag):
                if tag == 'title':
                    self._in_title = False

        # Manual redirect loop, not allow_redirects=True: a redirect to a
        # private/loopback address would bypass the check above entirely.
        current_url = url
        resp = None
        for _ in range(5):
            resp = _req.get(current_url, timeout=8, headers={'User-Agent': 'Mozilla/5.0'}, allow_redirects=False, stream=True)
            if resp.is_redirect or resp.is_permanent_redirect:
                location = resp.headers.get('Location')
                if not location:
                    break
                current_url = _urljoin(current_url, location)
                if not _og_fetch_is_safe_url(current_url):
                    return _empty
                continue
            break
        if resp is None or resp.status_code >= 400:
            return _empty

        # Тело читаем кусками и не больше 256 КБ: страница-гигант не должна съедать память.
        raw = b''
        for chunk in resp.iter_content(16384):
            raw += chunk
            if len(raw) > 262144:
                break
        resp.close()
        p = _P()
        p.feed(raw.decode(resp.encoding or 'utf-8', 'replace')[:60000])
        fav = p.og.get('_favicon', '')
        if fav and not fav.startswith('http'):
            fav = _urljoin(current_url, fav)
        if not fav:
            parsed = _urlparse(current_url)
            fav = f"{parsed.scheme}://{parsed.netloc}/favicon.ico"
        return {
            'title': p.og.get('og:title') or ''.join(p._title).strip() or '',
            'description': p.og.get('og:description') or '',
            'image': p.og.get('og:image') or '',
            'siteName': p.og.get('og:site_name') or '',
            'favicon': fav,
        }
    except Exception:
        return {'title': '', 'description': '', 'image': '', 'siteName': '', 'favicon': ''}


_cache: dict[str, tuple[float, dict]] = {}
_CACHE_TTL = 3600.0


async def _preview(url: str, me: Identity) -> dict:
    if not limiter.allow(f"preview:{me.user_id}", 60, 60):
        raise HTTPException(status_code=429, detail="Слишком часто")
    hit = _cache.get(url)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    og = await run_in_threadpool(_fetch_og, url)
    host = urlparse(url).hostname or ""
    result = {"title": og["title"] or host, "description": og["description"], "image": og["image"],
              "siteName": og["siteName"] or host, "url": url}
    if len(_cache) > 2000:
        _cache.clear()
    _cache[url] = (time.monotonic() + _CACHE_TTL, result)
    return result


@router.get("/api/og")
async def fetch_og_endpoint(url: str, me: Identity = Depends(current_identity)):
    return await run_in_threadpool(_fetch_og, url)


@router.get("/api/preview")
async def link_preview(url: str, me: Identity = Depends(current_identity)):
    """Превью ссылки для ленты чата (раньше — маршрут Next, который ходил по любому адресу
    без проверок, в том числе во внутреннюю сеть)."""
    return await _preview(url, me)
