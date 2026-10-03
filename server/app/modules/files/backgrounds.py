from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, List
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.core.security import Identity, current_identity
from app.core.storage import UPLOAD_DIR

router = APIRouter()
logger = logging.getLogger(__name__)


# Папки для фоновых SVG чатов (light/dark), устойчивые к передеплоям через SHAR_UPLOADS_DIR
CHAT_BACKGROUNDS_DIR = UPLOAD_DIR / "chat-backgrounds"


CHAT_BACKGROUNDS_LIGHT_DIR = CHAT_BACKGROUNDS_DIR / "light"


CHAT_BACKGROUNDS_DARK_DIR = CHAT_BACKGROUNDS_DIR / "dark"


CHAT_BACKGROUNDS_LIGHT_GRADIENT_DIR = CHAT_BACKGROUNDS_DIR / "light-gradient"


CHAT_BACKGROUNDS_DARK_GRADIENT_DIR = CHAT_BACKGROUNDS_DIR / "dark-gradient"


CHAT_BACKGROUNDS_LIGHT_BG_DIR = CHAT_BACKGROUNDS_LIGHT_DIR / "backgrounds"


CHAT_BACKGROUNDS_LIGHT_OVERLAY_DIR = CHAT_BACKGROUNDS_LIGHT_DIR / "overlays"


CHAT_BACKGROUNDS_DARK_BG_DIR = CHAT_BACKGROUNDS_DARK_DIR / "backgrounds"


CHAT_BACKGROUNDS_DARK_OVERLAY_DIR = CHAT_BACKGROUNDS_DARK_DIR / "overlays"


_upload_dirs = [
    CHAT_BACKGROUNDS_LIGHT_DIR,
    CHAT_BACKGROUNDS_DARK_DIR,
    CHAT_BACKGROUNDS_LIGHT_GRADIENT_DIR,
    CHAT_BACKGROUNDS_DARK_GRADIENT_DIR,
    CHAT_BACKGROUNDS_LIGHT_BG_DIR,
    CHAT_BACKGROUNDS_LIGHT_OVERLAY_DIR,
    CHAT_BACKGROUNDS_DARK_BG_DIR,
    CHAT_BACKGROUNDS_DARK_OVERLAY_DIR,
]


for _d in _upload_dirs:
    try:
        _d.mkdir(parents=True, exist_ok=True)
    except PermissionError as e:
        logger.warning("[Storage] Cannot create directory %s: %s", _d, e)


def _get_theme_background_root(theme: str) -> Path:
    normalized = str(theme or '').strip().lower()
    if normalized == 'light':
        return CHAT_BACKGROUNDS_LIGHT_DIR
    if normalized == 'dark':
        return CHAT_BACKGROUNDS_DARK_DIR
    raise HTTPException(status_code=400, detail="theme must be 'light' or 'dark'")


def _get_theme_asset_dirs(theme: str) -> Dict[str, List[Path]]:
    normalized = str(theme or '').strip().lower()
    if normalized == 'light':
        return {
            'backgrounds': [
                CHAT_BACKGROUNDS_LIGHT_GRADIENT_DIR,
                CHAT_BACKGROUNDS_LIGHT_BG_DIR,
            ],
            'overlays': [
                CHAT_BACKGROUNDS_LIGHT_OVERLAY_DIR,
                CHAT_BACKGROUNDS_LIGHT_DIR,
            ],
            'allowed_prefixes': ['light-gradient/', 'light/'],
        }
    if normalized == 'dark':
        return {
            'backgrounds': [
                CHAT_BACKGROUNDS_DARK_GRADIENT_DIR,
                CHAT_BACKGROUNDS_DARK_BG_DIR,
            ],
            'overlays': [
                CHAT_BACKGROUNDS_DARK_OVERLAY_DIR,
                CHAT_BACKGROUNDS_DARK_DIR,
            ],
            'allowed_prefixes': ['dark-gradient/', 'dark/'],
        }
    raise HTTPException(status_code=400, detail="theme must be 'light' or 'dark'")


def _detect_chat_asset_kind(relative_path: str) -> str:
    lower_path = str(relative_path or '').lower()
    normalized_parts = [part for part in lower_path.replace('\\', '/').split('/') if part]
    if normalized_parts:
        folder_hints_overlay = {'overlay', 'overlays', 'накладки', 'nakladki'}
        folder_hints_background = {'background', 'backgrounds', 'фон', 'фоны'}
        for part in normalized_parts[:-1]:
            if part in folder_hints_overlay:
                return 'overlay'
            if part in folder_hints_background:
                return 'background'

    overlay_markers = ('overlay', 'overlays', 'наклад', 'pattern', 'mask')
    for marker in overlay_markers:
        if marker in lower_path:
            return 'overlay'
    return 'background'


def _collect_assets(theme: str, source_dirs: List[Path]) -> List[Dict[str, str]]:
    allowed_ext = {'.svg', '.png', '.jpg', '.jpeg', '.webp'}
    root_dir = CHAT_BACKGROUNDS_DIR
    collected: List[Dict[str, str]] = []
    seen_paths = set()
    seen_names = set()

    for source_dir in source_dirs:
        if not source_dir.exists() or not source_dir.is_dir():
            continue

        for file_path in sorted(source_dir.rglob('*')):
            if not file_path.is_file():
                continue
            if file_path.suffix.lower() not in allowed_ext:
                continue

            rel_path = file_path.relative_to(root_dir).as_posix()
            lower_rel = rel_path.lower()
            lower_name = file_path.name.lower()
            if lower_rel in seen_paths or lower_name in seen_names:
                continue
            seen_paths.add(lower_rel)
            seen_names.add(lower_name)

            encoded_rel_path = quote(rel_path, safe='/')
            collected.append({
                'name': file_path.name,
                'path': rel_path,
                'url': f"/api/chat-backgrounds/{theme}/{encoded_rel_path}",
            })

    return collected


def _list_chat_assets_for_theme(theme: str) -> Dict[str, List[Dict[str, str]]]:
    directories = _get_theme_asset_dirs(theme)
    backgrounds = _collect_assets(theme, directories['backgrounds'])
    overlays = _collect_assets(theme, directories['overlays'])

    return {
        'backgrounds': backgrounds,
        'overlays': overlays,
    }


@router.get("/api/chat-backgrounds")
def list_chat_background_assets(me: Identity = Depends(current_identity)):
    """Список загруженных фонов/накладок чата (light/dark)."""
    return {
        'light': _list_chat_assets_for_theme('light'),
        'dark': _list_chat_assets_for_theme('dark'),
    }


@router.get("/api/chat-backgrounds/{theme}/{file_path:path}")
def get_chat_background_file(theme: str, file_path: str, me: Identity = Depends(current_identity)):
    """Отдача файла фона/накладки чата из persistent storage."""
    _get_theme_background_root(theme)
    root_dir = CHAT_BACKGROUNDS_DIR
    normalized_rel = str(file_path or '').strip().replace('\\', '/')
    if not normalized_rel:
        raise HTTPException(status_code=400, detail='file path is required')

    allowed_prefixes = _get_theme_asset_dirs(theme)['allowed_prefixes']
    if not any(normalized_rel.lower().startswith(prefix) for prefix in allowed_prefixes):
        raise HTTPException(status_code=400, detail='Invalid file path for theme')

    resolved = (root_dir / normalized_rel).resolve()
    try:
        resolved.relative_to(root_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail='Invalid file path')

    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=404, detail='Chat background file not found')

    return FileResponse(resolved)
