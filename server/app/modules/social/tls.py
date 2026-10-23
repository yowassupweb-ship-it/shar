"""Проверка TLS для площадок с российскими сертификатами.

MAX (и всё больше сервисов VK) подписаны «Russian Trusted Sub CA» Минцифры, а стандартный набор
корневых сертификатов (certifi) его корня не знает: запросы падали с SSLError. Добавляем к certifi
один корневой «Russian Trusted Root CA» (app/certs/russian_trusted_root_ca.pem, с gu-st.ru,
SHA-256 D2:6D:2D:02:…:8E:CF:31; действует до 2032). Промежуточный сертификат НЕ кладём: сервер
присылает свой, а старый промежуточный из набора ломал построение цепочки.

Только для запросов к соцсетям — весь остальной сервер живёт со стандартным набором."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Optional

import certifi

log = logging.getLogger("shar.social.tls")

ROOT = Path(__file__).resolve().parents[2] / "certs" / "russian_trusted_root_ca.pem"
_bundle: Optional[str] = None


def ca_bundle() -> str:
    """Путь к набору «certifi + корень Минцифры» (собирается один раз за процесс). Нельзя записать
    файл (файловая система только для чтения) — один корень Минцифры: для MAX его хватает."""
    global _bundle
    if _bundle:
        return _bundle
    try:
        fd, path = tempfile.mkstemp(prefix="shar-ca-", suffix=".pem")
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(Path(certifi.where()).read_text(encoding="utf-8"))
            out.write("\n")
            out.write(ROOT.read_text(encoding="utf-8"))
        _bundle = path
    except OSError as e:
        log.warning("CA bundle not written (%s) — using the Russian root alone", e)
        _bundle = str(ROOT)
    return _bundle
