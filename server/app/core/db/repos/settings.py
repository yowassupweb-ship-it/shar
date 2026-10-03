from __future__ import annotations

from typing import Any, Dict

from app.core.db.connection import Json


class SettingsRepo:
    """Запросы области «settings». Требует self.conn (PostgresConnection)."""

    # ==================== SETTINGS ====================
    def get_settings(self) -> Dict[str, Any]:
        """Get all settings"""
        query = "SELECT key, value FROM settings"
        results = self.conn.fetch_all(query)
        return {row['key']: row['value'] for row in results}

    def update_settings(self, settings: Dict[str, Any]):
        """Update settings"""
        for key, value in settings.items():
            query = """
                INSERT INTO settings (key, value, updated_at)
                VALUES (%s, %s, NOW())
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            """
            self.conn.execute_query(query, (key, Json(value)))
