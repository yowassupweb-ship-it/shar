"""Уведомления в Telegram-чат администраторов (токен и чат — в настройках админки)."""

from __future__ import annotations

import logging
from typing import Optional

import requests

from app.core.db import db

log = logging.getLogger("shar.telegram")


class TelegramNotifier:
    def _settings(self) -> dict:
        try:
            return db.get_settings() or {}
        except Exception:
            return {}

    def send_notification(self, message: str, parse_mode: str = "HTML") -> bool:
        """Отправить сообщение. Настройки читаются при каждой отправке — правка в админке
        действует сразу. Возвращает True при успехе."""
        cfg = self._settings()
        token, chat_id = cfg.get("telegramBotToken"), cfg.get("telegramChatId")
        if not cfg.get("telegramNotifications") or not token or not chat_id:
            return False
        proxies = None
        proxy = str(cfg.get("telegramProxy") or "").strip()
        if proxy:
            proxy_url = proxy if "://" in proxy else f"socks5://{proxy}"
            proxies = {"https": proxy_url}
        try:
            res = requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": message, "parse_mode": parse_mode},
                timeout=10, proxies=proxies,
            )
            if res.status_code != 200:
                log.warning("Telegram API error: %s", res.status_code)  # тело не пишем: в нём может быть токен
            return res.status_code == 200
        except Exception as exc:
            log.warning("Telegram send failed: %s", type(exc).__name__)
            return False

    def notify_error(self, error_type: str, error_message: str) -> None:
        self.send_notification(f"❌ <b>Ошибка: {error_type}</b>\n\n{error_message}")

    def notify_reaction(self, user_name: str, emoji: str, message_content: str = "", chat_title: Optional[str] = None) -> None:
        """О реакции сообщаем без текста сообщения и названия чата: личная переписка
        не должна утекать во внешний мессенджер."""
        self.send_notification(f"{emoji} <b>Новая реакция</b>\n\nОт: {user_name}")


telegram = TelegramNotifier()
