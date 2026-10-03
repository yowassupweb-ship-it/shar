"""Уменьшенные копии картинок для ленты чата.

Лента показывает фото шириной 300–600px, а грузила оригиналы по 3–4 МБ —
отсюда медленные картинки и прыгающая лента. Здесь только работа с самой
картинкой (размер, поворот по EXIF, WebP); где брать оригинал и где хранить
готовые копии, решает приложение — модуль можно вынести отдельно.
"""

from __future__ import annotations

import io
from typing import Optional, Tuple

# Только эти ширины: иначе каждый размер экрана порождал бы свою копию.
WIDTHS = (320, 640, 1280)

# Анимацию и векторы не трогаем — отдаём как есть.
_SKIP_EXT = {'.gif', '.svg', '.svgz'}
_IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif'}

try:
    from PIL import Image, ImageOps  # type: ignore
    _PIL = True
except Exception:  # Pillow не установлен — отдаём оригиналы, ничего не ломая
    _PIL = False


def available() -> bool:
    return _PIL


def pick_width(requested: int) -> int:
    """Ближайшая разрешённая ширина не меньше запрошенной."""
    for w in WIDTHS:
        if requested <= w:
            return w
    return WIDTHS[-1]


def is_thumbnailable(filename: str) -> bool:
    name = filename.lower()
    ext = name[name.rfind('.'):] if '.' in name else ''
    return ext in _IMAGE_EXT and ext not in _SKIP_EXT


def cache_key(filename: str, width: int) -> str:
    return f"thumbs/{width}/{filename}.webp"


def make_thumbnail(data: bytes, width: int) -> Optional[Tuple[bytes, int, int]]:
    """WebP шириной не больше width (меньше — не увеличиваем).
    Возвращает (байты, ширина, высота) или None, если открыть не удалось."""
    if not _PIL:
        return None
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)  # фото с телефона — правильной стороной вверх
        if img.mode not in ('RGB', 'RGBA'):
            img = img.convert('RGBA' if 'A' in img.getbands() else 'RGB')
        if img.width > width:
            img.thumbnail((width, width * 4), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, format='WEBP', quality=80, method=4)
        return out.getvalue(), img.width, img.height
    except Exception:
        return None
