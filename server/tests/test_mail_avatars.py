"""Лицо отправителя в почте: Gravatar → BIMI → значок сайта; публичные почтовые домены логотипа не получают."""

from __future__ import annotations

import io

import pytest

from app.modules.mail import avatars as A


def _png(size=64, color=(200, 30, 30, 255)) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGBA", (size, size), color).save(out, "PNG")
    return out.getvalue()


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    A._mem.clear()
    monkeypatch.setattr(A, "_CACHE_DIR", tmp_path / "avatars")


def test_gravatar_wins_and_is_resized(monkeypatch):
    calls = []

    def fake_get(url, limit, accept="*/*"):
        calls.append(url)
        return (_png(300), "image/png") if "gravatar.com" in url else None

    monkeypatch.setattr(A, "_get", fake_get)
    data, mime = A.lookup("Boss@Company.RU")
    assert mime == "image/png"
    from PIL import Image

    assert Image.open(io.BytesIO(data)).size == (A._SIZE, A._SIZE)
    assert len(calls) == 1 and "gravatar.com/avatar/" in calls[0] and "d=404" in calls[0]
    # второй вызов — из кэша, сеть не трогаем
    A.lookup("boss@company.ru")
    assert len(calls) == 1


def test_free_mail_gets_no_service_logo(monkeypatch):
    seen = []
    monkeypatch.setattr(A, "_get", lambda url, limit, accept="*/*": seen.append(url))
    assert A.lookup("someone@gmail.com") is None
    assert A.lookup("x@mail.ru") is None
    assert all("gravatar" in u for u in seen), "для gmail/mail.ru ищем только личное фото, не значок сайта"


def test_company_site_icon_used_when_no_gravatar(monkeypatch):
    page = b'<html><head><link rel="icon" href="/small.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch.png" sizes="180x180"></head></html>'

    def fake_get(url, limit, accept="*/*"):
        if "gravatar" in url or "cloudflare-dns" in url:
            return None
        if url == "https://acme.ru/":
            return page, "text/html"
        if url == "https://acme.ru/touch.png":
            return _png(180), "image/png"
        return None

    monkeypatch.setattr(A, "_get", fake_get)
    got = A.lookup("anna@acme.ru")
    assert got and got[1] == "image/png"


def test_bimi_svg_accepted_and_script_rejected(monkeypatch):
    good = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>'
    evil = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    doh = b'{"Answer":[{"data":"\\"v=BIMI1; l=https://acme.ru/logo.svg; a=\\""}]}'

    def make(logo):
        def fake_get(url, limit, accept="*/*"):
            if "gravatar" in url:
                return None
            if "cloudflare-dns" in url:
                return doh, "application/dns-json"
            if url == "https://acme.ru/logo.svg":
                return logo, "image/svg+xml"
            return None
        return fake_get

    monkeypatch.setattr(A, "_get", make(good))
    got = A.lookup("a@acme.ru")
    assert got and got[1] == "image/svg+xml"

    A._mem.clear()
    monkeypatch.setattr(A, "_CACHE_DIR", A._CACHE_DIR / "evil")
    monkeypatch.setattr(A, "_get", make(evil))
    monkeypatch.setattr(A, "_site_icon", lambda domain: None)
    assert A.lookup("a@acme.ru") is None


def test_garbage_addresses_do_not_hit_network(monkeypatch):
    monkeypatch.setattr(A, "_get", lambda *a, **k: pytest.fail("сеть не нужна"))
    for bad in ("", "no-at", "a@localhost", "a@127.0.0.1", "<x>@y.ru", "a b@c.ru"):
        assert A.lookup(bad) is None


def test_endpoint_requires_login_and_answers_204(client, anna, monkeypatch):
    assert client.get("/api/mail/avatar", params={"email": "a@acme.ru"}).status_code in (401, 403)
    monkeypatch.setattr(A, "lookup", lambda email: None)
    r = anna.get("/api/mail/avatar", params={"email": "a@acme.ru"})
    assert r.status_code == 204
    monkeypatch.setattr(A, "lookup", lambda email: (b"\x89PNG", "image/png"))
    r = anna.get("/api/mail/avatar", params={"email": "a@acme.ru"})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert "sandbox" in r.headers["content-security-policy"]
