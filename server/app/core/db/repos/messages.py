from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from app.core.db.connection import Json


class MessagesRepo:
    """Запросы области «messages». Требует self.conn (PostgresConnection)."""

    # ==================== MESSAGES ====================
    def get_messages(self, chat_id: str, limit: int = 50, before_timestamp: str = None) -> List[Dict[str, Any]]:
        """Get the latest messages from chat, ordered oldest-first.

        If before_timestamp is given, returns messages older than that timestamp (for pagination).
        """
        if before_timestamp:
            query = """
                SELECT * FROM (
                    SELECT * FROM messages
                    WHERE chat_id = %s AND is_deleted = false AND created_at < %s::timestamptz
                    ORDER BY created_at DESC
                    LIMIT %s
                ) sub
                ORDER BY created_at ASC
            """
            return self.conn.fetch_all(query, (chat_id, before_timestamp, limit))
        else:
            query = """
                SELECT * FROM (
                    SELECT * FROM messages
                    WHERE chat_id = %s AND is_deleted = false
                    ORDER BY created_at DESC
                    LIMIT %s
                ) sub
                ORDER BY created_at ASC
            """
            return self.conn.fetch_all(query, (chat_id, limit))

    def get_chat_messages(self, chat_id: str) -> List[Dict[str, Any]]:
        """Get messages from chat (alias for get_messages)"""
        return self.get_messages(chat_id)

    def get_last_messages_bulk(self, chat_ids: List[str]) -> Dict[str, Any]:
        """Return the last non-deleted message for each chat in ONE query."""
        if not chat_ids:
            return {}
        # По одной строке на чат через индекс (chat_id, created_at DESC) WHERE NOT is_deleted.
        # Прежний DISTINCT ON сортировал ВСЕ сообщения всех чатов пользователя (десятки
        # тысяч широких строк с metadata/attachments, со сбросом на диск) ради одной строки.
        query = """
            SELECT m.chat_id, m.id, m.content, m.author_id, m.author_name,
                   m.created_at, m.attachments, m.metadata, m.is_system_message,
                   m.notification_type, m.linked_task_id, m.linked_post_id
            FROM unnest(%s::text[]) AS c(chat_id)
            CROSS JOIN LATERAL (
                SELECT * FROM messages
                WHERE chat_id = c.chat_id AND is_deleted = false
                ORDER BY created_at DESC
                LIMIT 1
            ) m
        """
        rows = self.conn.fetch_all(query, (list(chat_ids),))
        return {str(row['chat_id']): dict(row) for row in rows}

    def get_unread_counts_bulk(self, chat_ids: List[str], user_id: str,
                                read_markers: Dict[str, str]) -> Dict[str, int]:
        """Return unread message counts for all chats in TWO queries (no per-chat loop)."""
        if not chat_ids:
            return {}

        # Step 1: resolve read-marker message_ids → created_at timestamps (one query)
        marker_ids = [v for v in read_markers.values() if v]
        marker_times: Dict[str, Any] = {}
        if marker_ids:
            rows = self.conn.fetch_all(
                "SELECT id, created_at FROM messages WHERE id = ANY(%s)",
                (marker_ids,)
            )
            marker_times = {str(r['id']): r['created_at'] for r in rows}

        # Step 2: count unread per chat with a single query using CASE
        # Build per-chat cutoff times
        cutoffs: Dict[str, Any] = {}
        for cid in chat_ids:
            marker = read_markers.get(cid) or read_markers.get(str(cid))
            if marker and marker in marker_times:
                cutoffs[cid] = marker_times[marker]
            elif marker:
                # Not a message id (or that message no longer resolves) — mark-read
                # (/api/chats/{chat_id}/mark-read) falls back to writing an ISO
                # timestamp here instead of a message id whenever last_message_id
                # didn't exist in the messages table yet, which happens whenever the
                # client's activity-triggered read-ping (mousemove/scroll/touch —
                # see markChatReadFromActivityRef) fires with a still-optimistic
                # temp_* id, before the real server id has come back from the send.
                # Falling through to "no marker at all" (cutoff = epoch, every
                # message counts as unread) for THIS case specifically is what made
                # a chat the user had genuinely just read flip to "entirely unread"
                # — the read state's own timestamp fallback existed for exactly this
                # situation and just wasn't being read back here.
                try:
                    cutoffs[cid] = datetime.fromisoformat(marker.replace('Z', '+00:00'))
                except (ValueError, TypeError):
                    pass

        # Build a temporary VALUES table of per-chat read cutoffs. A chat with a
        # resolved read marker uses its timestamp; every other chat gets the epoch
        # (on the marker alone, all of its messages would count as unread). We ALWAYS
        # go through this path now — even with no markers at all — because the
        # own-message floor below is what actually makes the count self-healing, and
        # it has to apply regardless of whether any marker exists.
        values_parts = []
        params: List[Any] = []
        for cid in chat_ids:
            ts = cutoffs.get(cid)
            if ts is not None:
                values_parts.append("(%s::text, %s::timestamptz)")
                params.extend([cid, ts])
            else:
                values_parts.append("(%s::text, '1970-01-01'::timestamptz)")
                params.append(cid)

        values_sql = ", ".join(values_parts)
        # own_last = the timestamp of THIS user's most recent message in each chat.
        # Sending a message is proof you had read everything before it, so this is a
        # second, self-healing cutoff floor that doesn't depend on the read-marker
        # plumbing (mark-read pings, temp-id resolution, etc.) being perfect. It's
        # what fixes the "58 unread on a chat I clearly answered" bug: when the marker
        # was never written or went stale, the marker cutoff falls back to the epoch,
        # but own_last still excludes every message up to and including your own reply.
        # A chat where you sent the last message therefore always reads as 0 unread.
        query = f"""
            WITH cutoffs(chat_id, cutoff) AS (VALUES {values_sql}),
                 own_last AS (
                     SELECT chat_id, MAX(created_at) AS own_ts
                     FROM messages
                     WHERE chat_id = ANY(%s) AND author_id = %s AND is_deleted = false
                     GROUP BY chat_id
                 )
            SELECT m.chat_id, COUNT(*) as cnt
            FROM messages m
            JOIN cutoffs c ON m.chat_id = c.chat_id
            LEFT JOIN own_last o ON m.chat_id = o.chat_id
            WHERE m.is_deleted = false
              AND m.created_at > c.cutoff
              AND (
                -- Notifications chats: every notification counts. They're authored as the
                -- recipient and flagged system, so the normal own/system/own-floor
                -- exclusions below would zero them out — bypass those for notifications.
                m.chat_id ~ '^notifications[-_]'
                OR (
                  m.author_id != %s
                  AND m.is_system_message IS NOT TRUE
                  AND (o.own_ts IS NULL OR m.created_at > o.own_ts)
                )
              )
            GROUP BY m.chat_id
        """
        params.append(chat_ids)  # own_last: chat_id = ANY(%s)
        params.append(user_id)   # own_last: author_id = %s
        params.append(user_id)   # outer:    author_id != %s
        rows = self.conn.fetch_all(query, params)
        return {str(r['chat_id']): int(r['cnt']) for r in rows}

    def add_message(self, message: Dict[str, Any], if_new: bool = False) -> Optional[Dict[str, Any]]:
        """Add new message.

        if_new=True: при занятом id строку не пишем и возвращаем None (ON
        CONFLICT DO NOTHING) — повтор той же отправки узнаётся одной вставкой,
        без предварительного SELECT на каждое сообщение."""
        query = """
            INSERT INTO messages 
            (id, chat_id, author_id, author_name, content, mentions, reply_to_id,
             is_edited, is_deleted, is_system_message, notification_type,
             linked_chat_id, linked_message_id, linked_task_id, linked_post_id,
             attachments, metadata)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            {conflict}
            RETURNING *
        """.format(conflict='ON CONFLICT (id) DO NOTHING' if if_new else '')
        params = (
            message.get('id'),
            message.get('chat_id') or message.get('chatId'),
            message.get('author_id') or message.get('authorId'),
            message.get('author_name') or message.get('authorName'),
            message.get('content'),
            Json(message.get('mentions', [])),
            message.get('reply_to_id') or message.get('replyToId'),
            message.get('is_edited') or message.get('isEdited', False),
            message.get('is_deleted') or message.get('isDeleted', False),
            message.get('is_system_message') or message.get('isSystemMessage', False),
            message.get('notification_type') or message.get('notificationType'),
            message.get('linked_chat_id') or message.get('linkedChatId'),
            message.get('linked_message_id') or message.get('linkedMessageId'),
            message.get('linked_task_id') or message.get('linkedTaskId'),
            message.get('linked_post_id') or message.get('linkedPostId'),
            Json(message.get('attachments', [])),
            Json(message.get('metadata', {}))
        )
        result = self.conn.fetch_one(query, params)
        return dict(result) if result else None

    def find_message_by_client_nonce(self, chat_id: str, author_id: str, client_nonce: str) -> Optional[Dict[str, Any]]:
        """Return an already-stored message for this (chat, author, clientNonce) if one exists.

        Idempotency guard against duplicate sends: on a slow connection the client's
        fetchWithRetry re-POSTs a message whose first attempt actually reached the server
        and committed a row, but whose response was lost to a timeout. Both attempts carry
        the same metadata.clientNonce, so we can recognise the retry and return the original
        row instead of inserting a second one. Bounded to a recent window so a nonce can't
        collide with an unrelated old message (temp ids are per-tab timestamps, effectively
        unique, but the window keeps this cheap and index-friendly regardless)."""
        if not client_nonce:
            return None
        query = """
            SELECT * FROM messages
            WHERE chat_id = %s
              AND author_id = %s
              AND metadata->>'clientNonce' = %s
              AND created_at > NOW() - INTERVAL '1 hour'
            ORDER BY created_at ASC
            LIMIT 1
        """
        result = self.conn.fetch_one(query, (chat_id, str(author_id), str(client_nonce)))
        return dict(result) if result else None

    def toggle_message_reaction(self, message_id: str, emoji: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Atomically toggle one user's reaction on a message — the fix for the lost-update
        race. The old path had the client send the WHOLE reactions map (read-modify-write off
        its own possibly-stale view) and the server replaced metadata.reactions wholesale, so
        two people reacting at once clobbered each other. Here the server toggles ONLY this
        (emoji, user) pair inside a single UPDATE, so concurrent reactions from different users
        can't overwrite one another. Empty emoji arrays are dropped so no stale zero-count keys
        accumulate. Returns the updated row (server-authoritative reactions)."""
        query = """
            UPDATE messages
            SET metadata = CASE
              WHEN (
                CASE WHEN COALESCE(metadata->'reactions'->%(emoji)s, '[]'::jsonb) ? %(uid)s
                     THEN COALESCE(metadata->'reactions'->%(emoji)s, '[]'::jsonb) - %(uid)s
                     ELSE COALESCE(metadata->'reactions'->%(emoji)s, '[]'::jsonb) || to_jsonb(%(uid)s::text)
                END
              ) = '[]'::jsonb
              THEN COALESCE(metadata, '{}'::jsonb) #- ARRAY['reactions', %(emoji)s]
              ELSE jsonb_set(
                    CASE WHEN COALESCE(metadata, '{}'::jsonb) ? 'reactions'
                         THEN COALESCE(metadata, '{}'::jsonb)
                         ELSE COALESCE(metadata, '{}'::jsonb) || '{"reactions":{}}'::jsonb END,
                    ARRAY['reactions', %(emoji)s],
                    CASE WHEN COALESCE(metadata->'reactions'->%(emoji)s, '[]'::jsonb) ? %(uid)s
                         THEN COALESCE(metadata->'reactions'->%(emoji)s, '[]'::jsonb) - %(uid)s
                         ELSE COALESCE(metadata->'reactions'->%(emoji)s, '[]'::jsonb) || to_jsonb(%(uid)s::text) END,
                    true
                   )
            END,
            updated_at = NOW()
            WHERE id = %(mid)s
            RETURNING *
        """
        result = self.conn.fetch_one(query, {'emoji': str(emoji), 'uid': str(user_id), 'mid': message_id})
        return dict(result) if result else None

    def update_message(self, message_id: str, content: str) -> bool:
        """Update message content"""
        query = """
            UPDATE messages
            SET content = %s, is_edited = true, updated_at = NOW()
            WHERE id = %s
        """
        return self.conn.execute_query(query, (content, message_id))

    def delete_message(self, message_id: str) -> bool:
        """Mark message as deleted"""
        query = """
            UPDATE messages
            SET is_deleted = true, updated_at = NOW()
            WHERE id = %s
        """
        return self.conn.execute_query(query, (message_id,))
