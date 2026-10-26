"""Набор сертификатов для соцсетей: certifi + корень Минцифры (MAX подписан Russian Trusted Sub CA)."""

from pathlib import Path

from app.modules.social import tls


def test_bundle_has_certifi_and_russian_root():
    text = Path(tls.ca_bundle()).read_text(encoding="utf-8")
    root = tls.ROOT.read_text(encoding="utf-8").strip()
    assert root in text
    assert text.count("BEGIN CERTIFICATE") > 50  # весь certifi на месте, а не один корень
