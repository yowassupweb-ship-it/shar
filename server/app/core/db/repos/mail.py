from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.core.db.connection import Json

logger = logging.getLogger("shar.db")


class MailRepo:
    """Запросы области «mail». Требует self.conn (PostgresConnection)."""

    _mail_tables_ensured = False

    def _ensure_mail_tables(self) -> None:
        if type(self)._mail_tables_ensured:
            return
        type(self)._mail_tables_ensured = True
        ddl = [
            """
            CREATE TABLE IF NOT EXISTS email_accounts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id VARCHAR NOT NULL,
                name VARCHAR NOT NULL,
                email VARCHAR NOT NULL,
                imap_host VARCHAR NOT NULL,
                imap_port INTEGER DEFAULT 993,
                smtp_host VARCHAR NOT NULL,
                smtp_port INTEGER DEFAULT 587,
                username VARCHAR NOT NULL,
                password_enc TEXT NOT NULL,
                use_ssl BOOLEAN DEFAULT TRUE,
                signature TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT NOW()
            )
            """,
            "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS signature TEXT DEFAULT ''",
            "CREATE INDEX IF NOT EXISTS idx_email_accounts_user ON email_accounts(user_id)",
            """
            CREATE TABLE IF NOT EXISTS email_messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
                uid VARCHAR,
                folder VARCHAR DEFAULT 'INBOX',
                message_id VARCHAR,
                thread_id VARCHAR,
                subject VARCHAR DEFAULT '',
                from_addr VARCHAR DEFAULT '',
                from_name VARCHAR DEFAULT '',
                to_addrs JSONB DEFAULT '[]',
                cc_addrs JSONB DEFAULT '[]',
                bcc_addrs JSONB DEFAULT '[]',
                body_text TEXT DEFAULT '',
                body_html TEXT DEFAULT '',
                attachments JSONB DEFAULT '[]',
                is_read BOOLEAN DEFAULT FALSE,
                is_starred BOOLEAN DEFAULT FALSE,
                is_draft BOOLEAN DEFAULT FALSE,
                date TIMESTAMP,
                fetched_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(account_id, uid, folder)
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_email_messages_account ON email_messages(account_id)",
            "CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_id)",
            "CREATE INDEX IF NOT EXISTS idx_email_messages_date ON email_messages(date DESC)",
            """
            CREATE TABLE IF NOT EXISTS email_chat_rules (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id VARCHAR NOT NULL,
                account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
                email_pattern VARCHAR(255) NOT NULL,
                chat_id VARCHAR(255) NOT NULL,
                description VARCHAR(500) DEFAULT '',
                keyword VARCHAR(500) DEFAULT '',
                created_at TIMESTAMP DEFAULT NOW()
            )
            """,
            "ALTER TABLE email_chat_rules ADD COLUMN IF NOT EXISTS keyword VARCHAR(500) DEFAULT ''",
            "CREATE INDEX IF NOT EXISTS idx_email_chat_rules_user ON email_chat_rules(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_email_chat_rules_account ON email_chat_rules(account_id)",
            # Custom mail folders (Gmail-label style) — a folder is just a saved
            # name/color; which mail lands in it is decided by mail_folder_rules,
            # matched against the sender address, not a real IMAP move.
            """
            CREATE TABLE IF NOT EXISTS mail_folders (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id VARCHAR NOT NULL,
                name VARCHAR(100) NOT NULL,
                color VARCHAR(20) NOT NULL DEFAULT '#3b82f6',
                created_at TIMESTAMP DEFAULT NOW()
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_mail_folders_user ON mail_folders(user_id)",
            """
            CREATE TABLE IF NOT EXISTS mail_folder_rules (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id VARCHAR NOT NULL,
                folder_id UUID REFERENCES mail_folders(id) ON DELETE CASCADE,
                email_pattern VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_mail_folder_rules_folder ON mail_folder_rules(folder_id)",
        ]
        for sql in ddl:
            try:
                self.conn.execute_query(sql)
            except Exception as e:
                logger.warning(f"[DB] mail DDL warning: {e}")

    def get_email_accounts(self, user_id: str) -> List[Dict[str, Any]]:
        self._ensure_mail_tables()
        rows = self.conn.fetch_all(
            "SELECT * FROM email_accounts WHERE user_id = %s ORDER BY created_at", (user_id,)
        )
        return [dict(r) for r in rows] if rows else []

    def add_email_account(self, account: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        self._ensure_mail_tables()
        row = self.conn.fetch_one(
            """
            INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, smtp_host, smtp_port, username, password_enc, use_ssl, signature)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
            """,
            (account['user_id'], account['name'], account['email'],
             account['imap_host'], account.get('imap_port', 993),
             account['smtp_host'], account.get('smtp_port', 587),
             account['username'], account['password_enc'], account.get('use_ssl', True),
             account.get('signature', ''))
        )
        return dict(row) if row else None

    def delete_email_account(self, account_id: str, user_id: str) -> bool:
        self._ensure_mail_tables()
        return self.conn.execute_query(
            "DELETE FROM email_accounts WHERE id = %s AND user_id = %s", (account_id, user_id)
        )

    def get_mail_folders(self, user_id: str) -> List[Dict[str, Any]]:
        self._ensure_mail_tables()
        rows = self.conn.fetch_all(
            "SELECT * FROM mail_folders WHERE user_id = %s ORDER BY created_at", (user_id,)
        )
        return [dict(r) for r in rows] if rows else []

    def add_mail_folder(self, user_id: str, name: str, color: str) -> Optional[Dict[str, Any]]:
        self._ensure_mail_tables()
        row = self.conn.fetch_one(
            "INSERT INTO mail_folders (user_id, name, color) VALUES (%s,%s,%s) RETURNING *",
            (user_id, name, color)
        )
        return dict(row) if row else None

    def rename_mail_folder(self, folder_id: str, user_id: str, name: str) -> Optional[Dict[str, Any]]:
        self._ensure_mail_tables()
        row = self.conn.fetch_one(
            "UPDATE mail_folders SET name = %s WHERE id = %s AND user_id = %s RETURNING *",
            (name, folder_id, user_id)
        )
        return dict(row) if row else None

    def delete_mail_folder(self, folder_id: str, user_id: str) -> bool:
        self._ensure_mail_tables()
        return self.conn.execute_query(
            "DELETE FROM mail_folders WHERE id = %s AND user_id = %s", (folder_id, user_id)
        )

    def get_mail_folder_rules(self, user_id: str, folder_id: Optional[str] = None) -> List[Dict[str, Any]]:
        self._ensure_mail_tables()
        if folder_id:
            rows = self.conn.fetch_all(
                "SELECT * FROM mail_folder_rules WHERE user_id = %s AND folder_id = %s ORDER BY created_at",
                (user_id, folder_id)
            )
        else:
            rows = self.conn.fetch_all(
                "SELECT * FROM mail_folder_rules WHERE user_id = %s ORDER BY created_at", (user_id,)
            )
        return [dict(r) for r in rows] if rows else []

    def add_mail_folder_rule(self, user_id: str, folder_id: str, email_pattern: str) -> Optional[Dict[str, Any]]:
        self._ensure_mail_tables()
        row = self.conn.fetch_one(
            "INSERT INTO mail_folder_rules (user_id, folder_id, email_pattern) VALUES (%s,%s,%s) RETURNING *",
            (user_id, folder_id, email_pattern)
        )
        return dict(row) if row else None

    def delete_mail_folder_rule(self, rule_id: str, user_id: str) -> bool:
        self._ensure_mail_tables()
        return self.conn.execute_query(
            "DELETE FROM mail_folder_rules WHERE id = %s AND user_id = %s", (rule_id, user_id)
        )

    def get_email_messages_by_patterns(self, account_id: str, patterns: List[str], limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
        """Virtual-folder view: messages from this account whose sender matches any
        of the folder's rule patterns, across INBOX/SENT (skips Trash/Spam/Drafts)."""
        self._ensure_mail_tables()
        if not patterns:
            return []
        clauses = " OR ".join(["from_addr ILIKE %s"] * len(patterns))
        params: List[Any] = [account_id] + [f'%{p}%' for p in patterns]
        rows = self.conn.fetch_all(
            f"""SELECT * FROM email_messages
                WHERE account_id = %s AND folder IN ('INBOX','SENT') AND ({clauses})
                ORDER BY date DESC LIMIT %s OFFSET %s""",
            tuple(params + [limit, offset])
        )
        return [dict(r) for r in rows] if rows else []

    def get_email_messages(self, account_id: str, folder: str = 'INBOX', limit: int = 50, offset: int = 0, search: str = '') -> List[Dict[str, Any]]:
        self._ensure_mail_tables()
        if search:
            rows = self.conn.fetch_all(
                """SELECT * FROM email_messages
                   WHERE account_id = %s AND folder = %s
                   AND (subject ILIKE %s OR from_addr ILIKE %s OR from_name ILIKE %s OR body_text ILIKE %s)
                   ORDER BY date DESC LIMIT %s OFFSET %s""",
                (account_id, folder, f'%{search}%', f'%{search}%', f'%{search}%', f'%{search}%', limit, offset)
            )
        else:
            rows = self.conn.fetch_all(
                "SELECT * FROM email_messages WHERE account_id = %s AND folder = %s ORDER BY date DESC LIMIT %s OFFSET %s",
                (account_id, folder, limit, offset)
            )
        return [dict(r) for r in rows] if rows else []

    def get_email_message(self, message_id: str) -> Optional[Dict[str, Any]]:
        self._ensure_mail_tables()
        row = self.conn.fetch_one("SELECT * FROM email_messages WHERE id = %s", (message_id,))
        return dict(row) if row else None

    def upsert_email_message(self, msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Insert or update an email message.
        Returns the row dict ONLY for truly new inserts (xmax=0).
        Returns None for rows that already existed (ON CONFLICT update path).
        """
        self._ensure_mail_tables()
        row = self.conn.fetch_one(
            """
            INSERT INTO email_messages
              (account_id, uid, folder, message_id, thread_id, subject,
               from_addr, from_name, to_addrs, cc_addrs, bcc_addrs,
               body_text, body_html, attachments, is_read, is_starred, is_draft, date)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (account_id, uid, folder) DO UPDATE SET
              is_read = EXCLUDED.is_read,
              is_starred = EXCLUDED.is_starred,
              from_name = CASE
                WHEN EXCLUDED.from_name IS NOT NULL AND EXCLUDED.from_name != ''
                     AND EXCLUDED.from_name != email_messages.from_addr
                THEN EXCLUDED.from_name
                ELSE email_messages.from_name
              END,
              fetched_at = NOW()
            RETURNING *, (xmax::text = '0') AS is_new_insert
            """,
            (msg['account_id'], msg.get('uid'), msg.get('folder', 'INBOX'),
             msg.get('message_id'), msg.get('thread_id'), msg.get('subject', ''),
             msg.get('from_addr', ''), msg.get('from_name', ''),
             Json(msg.get('to_addrs', [])), Json(msg.get('cc_addrs', [])), Json(msg.get('bcc_addrs', [])),
             msg.get('body_text', ''), msg.get('body_html', ''),
             Json(msg.get('attachments', [])),
             msg.get('is_read', False), msg.get('is_starred', False), msg.get('is_draft', False),
             msg.get('date'))
        )
        return dict(row) if row and row.get('is_new_insert') else None

    def add_email_message(self, msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        self._ensure_mail_tables()
        row = self.conn.fetch_one(
            """
            INSERT INTO email_messages
              (account_id, uid, folder, message_id, thread_id, subject,
               from_addr, from_name, to_addrs, cc_addrs, bcc_addrs,
               body_text, body_html, attachments, is_read, is_starred, is_draft, date)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING *
            """,
            (msg['account_id'], msg.get('uid'), msg.get('folder', 'INBOX'),
             msg.get('message_id'), msg.get('thread_id'), msg.get('subject', ''),
             msg.get('from_addr', ''), msg.get('from_name', ''),
             Json(msg.get('to_addrs', [])), Json(msg.get('cc_addrs', [])), Json(msg.get('bcc_addrs', [])),
             msg.get('body_text', ''), msg.get('body_html', ''),
             Json(msg.get('attachments', [])),
             msg.get('is_read', False), msg.get('is_starred', False), msg.get('is_draft', False),
             msg.get('date'))
        )
        return dict(row) if row else None

    def update_email_message(self, message_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        self._ensure_mail_tables()
        allowed = {'is_read', 'is_starred', 'folder', 'is_draft', 'body_text', 'body_html', 'subject'}
        clauses, params = [], []
        for k, v in updates.items():
            if k in allowed:
                clauses.append(f"{k} = %s")
                params.append(v)
        if not clauses:
            return self.get_email_message(message_id)
        params.append(message_id)
        row = self.conn.fetch_one(
            f"UPDATE email_messages SET {', '.join(clauses)} WHERE id = %s RETURNING *", tuple(params)
        )
        return dict(row) if row else None

    def delete_email_message(self, message_id: str) -> bool:
        self._ensure_mail_tables()
        return self.conn.execute_query("DELETE FROM email_messages WHERE id = %s", (message_id,))

    def get_email_chat_rules(self, user_id: str) -> List[Dict[str, Any]]:
        self._ensure_mail_tables()
        rows = self.conn.fetch_all(
            "SELECT * FROM email_chat_rules WHERE user_id = %s ORDER BY created_at",
            (user_id,)
        )
        return [dict(r) for r in rows] if rows else []

    def create_email_chat_rule(self, rule: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        self._ensure_mail_tables()
        row = self.conn.fetch_one(
            """
            INSERT INTO email_chat_rules (user_id, account_id, email_pattern, chat_id, description, keyword)
            VALUES (%s, %s, %s, %s, %s, %s) RETURNING *
            """,
            (rule['user_id'], rule.get('account_id'), rule['email_pattern'],
             rule['chat_id'], rule.get('description', ''), rule.get('keyword', ''))
        )
        return dict(row) if row else None

    def delete_email_chat_rule(self, rule_id: str, user_id: str) -> bool:
        self._ensure_mail_tables()
        return self.conn.execute_query(
            "DELETE FROM email_chat_rules WHERE id = %s AND user_id = %s", (rule_id, user_id)
        )

    def get_email_unread_counts(self, account_id: str) -> Dict[str, int]:
        self._ensure_mail_tables()
        rows = self.conn.fetch_all(
            "SELECT folder, COUNT(*) as cnt FROM email_messages WHERE account_id = %s AND is_read = FALSE GROUP BY folder",
            (account_id,)
        )
        return {r['folder']: r['cnt'] for r in rows} if rows else {}
