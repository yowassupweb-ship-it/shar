from __future__ import annotations

from datetime import datetime
from typing import Any

_RU_MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']


def _ru_when(start_iso: str, all_day: bool = False) -> str:
    """«30 сентября, 14:00» — как говорит человек, а не 2026-09-30."""
    try:
        d = datetime.fromisoformat(str(start_iso)[:19])
    except Exception:
        return str(start_iso or '')
    year = f" {d.year}" if d.year != datetime.now().year else ''
    return f"{d.day} {_RU_MONTHS_GEN[d.month - 1]}{year}" + ('' if all_day else f", {d:%H:%M}")


def _truthy(value: Any) -> bool:
    return value is True or str(value).strip().lower() in ('1', 'true', 'yes')
