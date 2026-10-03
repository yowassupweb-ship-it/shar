from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.core.db.connection import Json


class CloudRepo:
    """Запросы области «cloud». Требует self.conn (PostgresConnection)."""

    _cloud_tables_ensured = False

    def _ensure_cloud_storage_tables(self) -> None:
        if type(self)._cloud_tables_ensured:
            return
        self.conn.execute_query("""
            CREATE TABLE IF NOT EXISTS cloud_folders (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(500) NOT NULL,
                parent_id VARCHAR(255) REFERENCES cloud_folders(id) ON DELETE CASCADE,
                owner_id VARCHAR(255) NOT NULL,
                shared_with JSONB DEFAULT '[]',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        self.conn.execute_query("""
            CREATE TABLE IF NOT EXISTS cloud_files (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(500) NOT NULL,
                folder_id VARCHAR(255) REFERENCES cloud_folders(id) ON DELETE SET NULL,
                owner_id VARCHAR(255) NOT NULL,
                url TEXT NOT NULL,
                s3_key TEXT,
                size BIGINT DEFAULT 0,
                mime_type VARCHAR(255),
                file_type VARCHAR(50) DEFAULT 'file',
                shared_with JSONB DEFAULT '[]',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # Add shared_with to existing tables if column is missing
        for table in ('cloud_folders', 'cloud_files'):
            self.conn.execute_query(f"""
                DO $$ BEGIN
                  ALTER TABLE {table} ADD COLUMN IF NOT EXISTS shared_with JSONB DEFAULT '[]';
                EXCEPTION WHEN duplicate_column THEN NULL;
                END $$
            """)
        self.conn.execute_query("CREATE INDEX IF NOT EXISTS idx_cloud_files_owner ON cloud_files(owner_id)")
        self.conn.execute_query("CREATE INDEX IF NOT EXISTS idx_cloud_files_folder ON cloud_files(folder_id)")
        self.conn.execute_query("CREATE INDEX IF NOT EXISTS idx_cloud_folders_owner ON cloud_folders(owner_id)")
        self.conn.execute_query("CREATE INDEX IF NOT EXISTS idx_cloud_folders_parent ON cloud_folders(parent_id)")
        # GIN indexes for fast JSONB containment queries on shared_with
        self.conn.execute_query("CREATE INDEX IF NOT EXISTS idx_cloud_files_shared ON cloud_files USING GIN(shared_with)")
        self.conn.execute_query("CREATE INDEX IF NOT EXISTS idx_cloud_folders_shared ON cloud_folders USING GIN(shared_with)")
        self.conn.execute_query("UPDATE cloud_files SET shared_with = '[]' WHERE shared_with IS NULL")
        self.conn.execute_query("UPDATE cloud_folders SET shared_with = '[]' WHERE shared_with IS NULL")
        # Add sort_order and is_pinned for folder ordering
        for col, definition in [('sort_order', 'INTEGER DEFAULT 0'), ('is_pinned', 'BOOLEAN DEFAULT false')]:
            self.conn.execute_query(f"""
                DO $$ BEGIN
                  ALTER TABLE cloud_folders ADD COLUMN IF NOT EXISTS {col} {definition};
                EXCEPTION WHEN duplicate_column THEN NULL;
                END $$
            """)
        # Folder color
        self.conn.execute_query("""
            DO $$ BEGIN
              ALTER TABLE cloud_folders ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT NULL;
            EXCEPTION WHEN duplicate_column THEN NULL;
            END $$
        """)
        # Edit access and metadata columns
        for table, col, definition in [
            ('cloud_folders', 'edit_access', "JSONB DEFAULT '[]'"),
            ('cloud_files',   'edit_access', "JSONB DEFAULT '[]'"),
            ('cloud_files',   'metadata',    "JSONB DEFAULT '{}'"),
        ]:
            self.conn.execute_query(f"""
                DO $$ BEGIN
                  ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {definition};
                EXCEPTION WHEN duplicate_column THEN NULL;
                END $$
            """)
        type(self)._cloud_tables_ensured = True

    def get_cloud_folders(self, owner_id: str, parent_id: Optional[str] = None, user_dept: Optional[str] = None) -> List[Dict[str, Any]]:
        dept_val = f'dept:{user_dept}' if user_dept else None
        uid_text = '%s::text'
        parent_clause = "parent_id = %s" if parent_id else "parent_id IS NULL"
        parent_params: list = [parent_id] if parent_id else []

        if dept_val:
            access = f"""AND (
                owner_id = %s
                OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text})
                OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text})
                OR EXISTS (
                    SELECT 1 FROM cloud_files cf WHERE cf.folder_id = cloud_folders.id
                    AND (owner_id = %s
                         OR COALESCE(cf.shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text})
                         OR COALESCE(cf.shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text}))
                )
            )"""
            access_params = [owner_id, owner_id, dept_val, owner_id, owner_id, dept_val]
        else:
            access = f"""AND (
                owner_id = %s
                OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text})
                OR EXISTS (
                    SELECT 1 FROM cloud_files cf WHERE cf.folder_id = cloud_folders.id
                    AND (owner_id = %s
                         OR COALESCE(cf.shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text}))
                )
            )"""
            access_params = [owner_id, owner_id, owner_id, owner_id]

        # Check if sort columns exist before using them (fetch_all silently returns [] on errors)
        has_sort = self.conn.fetch_one("""
            SELECT 1 FROM information_schema.columns
            WHERE table_name='cloud_folders' AND column_name='is_pinned' LIMIT 1
        """)
        order_by = (
            "ORDER BY COALESCE(is_pinned,false) DESC, COALESCE(sort_order,0) ASC, name ASC"
            if has_sort else "ORDER BY name ASC"
        )
        # Ensure columns exist for next time
        if not has_sort:
            self.conn.execute_query("ALTER TABLE cloud_folders ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0")
            self.conn.execute_query("ALTER TABLE cloud_folders ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT false")

        # Fetch folders first (the access clause references cloud_folders without alias)
        query = f"SELECT * FROM cloud_folders WHERE {parent_clause} {access} {order_by}"
        rows = self.conn.fetch_all(query, tuple(parent_params + access_params))
        if not rows:
            return []

        # Enrich: first 4 files per folder (any type) + total count
        folder_ids = [r['id'] for r in rows if r.get('id')]
        preview_map: dict = {}   # folder_id → [{url, file_type, name}]
        count_map: dict = {}     # folder_id → int
        if folder_ids:
            placeholders = ','.join(['%s'] * len(folder_ids))
            # Count all files per folder
            cnt_rows = self.conn.fetch_all(
                f"SELECT folder_id, COUNT(*) AS cnt FROM cloud_files WHERE folder_id IN ({placeholders}) GROUP BY folder_id",
                tuple(folder_ids)
            )
            for cr in (cnt_rows or []):
                cd = dict(cr)
                count_map[cd['folder_id']] = int(cd.get('cnt') or 0)

            # First 9 files per folder ordered: images first, then by date — include id and created_at for unseen badge
            file_rows = self.conn.fetch_all(
                f"""SELECT folder_id, id, url, file_type, name, created_at
                    FROM (
                        SELECT folder_id, id, url, file_type, name, created_at,
                               ROW_NUMBER() OVER (PARTITION BY folder_id ORDER BY
                                 CASE WHEN file_type='image' THEN 0 ELSE 1 END,
                                 created_at DESC) AS rn
                        FROM cloud_files WHERE folder_id IN ({placeholders})
                    ) t WHERE rn <= 9""",
                tuple(folder_ids)
            )
            tmp: dict = {}
            for fr in (file_rows or []):
                fd = dict(fr)
                fid = fd['folder_id']
                if fid not in tmp:
                    tmp[fid] = []
                tmp[fid].append({
                    'id': fd.get('id', ''),
                    'url': fd.get('url',''),
                    'fileType': fd.get('file_type','file'),
                    'name': fd.get('name',''),
                    'createdAt': fd['created_at'].isoformat() if fd.get('created_at') else None,
                })
            preview_map = tmp

        # Also get sub-folders for each folder (show in thumbnail grid)
        subfolder_map: dict = {}
        if folder_ids:
            placeholders = ','.join(['%s'] * len(folder_ids))
            sf_rows = self.conn.fetch_all(
                f"SELECT id, name, parent_id, color FROM cloud_folders WHERE parent_id IN ({placeholders}) ORDER BY name LIMIT {len(folder_ids) * 4}",
                tuple(folder_ids)
            )
            for sf in (sf_rows or []):
                sfd = dict(sf)
                pid = sfd['parent_id']
                if pid not in subfolder_map:
                    subfolder_map[pid] = []
                subfolder_map[pid].append({
                    'url': '', 'fileType': 'folder',
                    'name': sfd.get('name', ''),
                    'color': sfd.get('color') or None,
                })

        result = []
        for r in rows:
            d = dict(r)
            fid = d.get('id')
            file_previews = preview_map.get(fid, [])[:9]
            folder_previews = subfolder_map.get(fid, [])
            # Mix: folders first (up to 3), then files (rest)
            combined = (folder_previews[:3] + file_previews)[:9]
            d['preview_files'] = combined
            d['file_count'] = count_map.get(fid, 0) + len(subfolder_map.get(fid, []))
            result.append(d)
        return result

    def create_cloud_folder(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        query = """
            INSERT INTO cloud_folders (id, name, parent_id, owner_id)
            VALUES (%s, %s, %s, %s) RETURNING *
        """
        result = self.conn.fetch_one(query, (data['id'], data['name'], data.get('parent_id'), data['owner_id']))
        return dict(result) if result else None

    def rename_cloud_folder(self, folder_id: str, owner_id: str, new_name: str) -> Optional[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        query = "UPDATE cloud_folders SET name = %s, updated_at = NOW() WHERE id = %s AND owner_id = %s RETURNING *"
        result = self.conn.fetch_one(query, (new_name, folder_id, owner_id))
        return dict(result) if result else None

    def move_cloud_folder(self, folder_id: str, owner_id: str, new_parent_id: Optional[str]) -> Optional[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        query = "UPDATE cloud_folders SET parent_id = %s, updated_at = NOW() WHERE id = %s AND owner_id = %s RETURNING *"
        result = self.conn.fetch_one(query, (new_parent_id, folder_id, owner_id))
        return dict(result) if result else None

    def delete_cloud_folder(self, folder_id: str, owner_id: str) -> bool:
        self._ensure_cloud_storage_tables()
        return self.conn.execute_query("DELETE FROM cloud_folders WHERE id = %s AND owner_id = %s", (folder_id, owner_id))

    _FILE_COLS = "id, name, folder_id, owner_id, url, s3_key, size, mime_type, file_type, shared_with, created_at, updated_at"

    def get_cloud_files(self, owner_id: str, folder_id: Optional[str] = None, user_dept: Optional[str] = None, all_files: bool = False) -> List[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        dept_val = f'dept:{user_dept}' if user_dept else None
        uid_text = '%s::text'
        cols = self._FILE_COLS

        if folder_id:
            # Use pure SQL to check folder access — avoids psycopg2 JSONB deserialization issues.
            # If user has folder access → return ALL files in the folder.
            if dept_val:
                folder_access_check = self.conn.fetch_one(
                    f"""SELECT 1 FROM cloud_folders
                        WHERE id = %s
                        AND (owner_id = %s
                             OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text})
                             OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text}))
                        LIMIT 1""",
                    (folder_id, owner_id, owner_id, dept_val)
                )
            else:
                folder_access_check = self.conn.fetch_one(
                    f"""SELECT 1 FROM cloud_folders
                        WHERE id = %s
                        AND (owner_id = %s
                             OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text}))
                        LIMIT 1""",
                    (folder_id, owner_id, owner_id)
                )

            if folder_access_check:
                rows = self.conn.fetch_all(
                    f"SELECT {cols} FROM cloud_files WHERE folder_id = %s ORDER BY name",
                    (folder_id,)
                )
            else:
                if dept_val:
                    q = f"""SELECT {cols} FROM cloud_files WHERE folder_id = %s
                        AND (owner_id = %s
                             OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text})
                             OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text}))
                        ORDER BY name"""
                    rows = self.conn.fetch_all(q, (folder_id, owner_id, owner_id, dept_val))
                else:
                    q = f"""SELECT {cols} FROM cloud_files WHERE folder_id = %s
                        AND (owner_id = %s
                             OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text}))
                        ORDER BY name"""
                    rows = self.conn.fetch_all(q, (folder_id, owner_id, owner_id))
        else:
            # all_files=True: return ALL accessible files regardless of folder (for file pickers)
            folder_clause = "" if all_files else "folder_id IS NULL AND "
            if dept_val:
                q = f"""SELECT {cols} FROM cloud_files WHERE {folder_clause}
                    (owner_id = %s
                     OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text})
                     OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text}))
                    ORDER BY name"""
                rows = self.conn.fetch_all(q, (owner_id, owner_id, dept_val))
            else:
                q = f"""SELECT {cols} FROM cloud_files WHERE {folder_clause}
                    (owner_id = %s
                     OR COALESCE(shared_with,'[]'::jsonb) @> jsonb_build_array({uid_text}))
                    ORDER BY name"""
                rows = self.conn.fetch_all(q, (owner_id, owner_id))

        result = []
        for r in (rows or []):
            d = dict(r)
            # Safely convert JSONB fields from string → list if needed
            for jf in ('shared_with',):
                v = d.get(jf)
                if isinstance(v, str):
                    try:
                        import json as _j; d[jf] = _j.loads(v)
                    except Exception: d[jf] = []
                elif v is None:
                    d[jf] = []
            # Convert datetime to ISO string
            for tf in ('created_at', 'updated_at'):
                v = d.get(tf)
                if v is not None and hasattr(v, 'isoformat'):
                    d[tf] = v.isoformat()
            result.append(d)
        return result

    def get_cloud_file_by_id(self, file_id: str) -> Optional[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        result = self.conn.fetch_one("SELECT * FROM cloud_files WHERE id = %s", (file_id,))
        return dict(result) if result else None

    def get_cloud_folder_by_id(self, folder_id: str) -> Optional[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        result = self.conn.fetch_one("SELECT * FROM cloud_folders WHERE id = %s", (folder_id,))
        return dict(result) if result else None

    def create_cloud_file(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        query = """
            INSERT INTO cloud_files (id, name, folder_id, owner_id, url, s3_key, size, mime_type, file_type)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *
        """
        result = self.conn.fetch_one(query, (
            data['id'], data['name'], data.get('folder_id'), data['owner_id'],
            data['url'], data.get('s3_key'), data.get('size', 0),
            data.get('mime_type'), data.get('file_type', 'file')
        ))
        return dict(result) if result else None

    def rename_cloud_file(self, file_id: str, owner_id: str, new_name: str) -> Optional[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        query = "UPDATE cloud_files SET name = %s, updated_at = NOW() WHERE id = %s AND owner_id = %s RETURNING *"
        result = self.conn.fetch_one(query, (new_name, file_id, owner_id))
        return dict(result) if result else None

    def move_cloud_file(self, file_id: str, owner_id: str, new_folder_id: Optional[str]) -> Optional[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        query = "UPDATE cloud_files SET folder_id = %s, updated_at = NOW() WHERE id = %s AND owner_id = %s RETURNING *"
        result = self.conn.fetch_one(query, (new_folder_id, file_id, owner_id))
        return dict(result) if result else None

    def update_cloud_file_access(self, file_id: str, owner_id: str, shared_with: list) -> Optional[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        result = self.conn.fetch_one(
            "UPDATE cloud_files SET shared_with = %s, updated_at = NOW() WHERE id = %s AND owner_id = %s RETURNING *",
            (Json(shared_with), file_id, owner_id)
        )
        return dict(result) if result else None

    def update_cloud_folder_access(self, folder_id: str, owner_id: str, shared_with: list) -> Optional[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        result = self.conn.fetch_one(
            "UPDATE cloud_folders SET shared_with = %s, updated_at = NOW() WHERE id = %s AND owner_id = %s RETURNING *",
            (Json(shared_with), folder_id, owner_id)
        )
        return dict(result) if result else None

    def delete_cloud_file(self, file_id: str, owner_id: str) -> Optional[Dict[str, Any]]:
        self._ensure_cloud_storage_tables()
        # Try exact match first, then cast-insensitive match to handle integer/string owner_id mismatches
        result = self.conn.fetch_one(
            "SELECT * FROM cloud_files WHERE id = %s AND (owner_id = %s OR owner_id = %s::text)",
            (file_id, owner_id, owner_id)
        )
        if not result:
            return None
        self.conn.execute_query(
            "DELETE FROM cloud_files WHERE id = %s AND (owner_id = %s OR owner_id = %s::text)",
            (file_id, owner_id, owner_id)
        )
        return dict(result)

    def get_attachment_chats(self, user_id: str) -> List[Dict[str, Any]]:
        """Return distinct chats that have attachments visible to user, with counts."""
        query = """
            SELECT
                c.id AS chat_id,
                COALESCE(
                    NULLIF(TRIM(COALESCE(c.title, '')), ''),
                    (
                        SELECT u.name FROM chat_participants cp2
                        JOIN users u ON u.id = cp2.user_id
                        WHERE cp2.chat_id = c.id AND cp2.user_id != %s
                        LIMIT 1
                    )
                ) AS chat_name,
                COALESCE(c.is_group, false) AS is_group,
                COALESCE(c.avatar, (
                    SELECT u.avatar FROM chat_participants cp2
                    JOIN users u ON u.id = cp2.user_id
                    WHERE cp2.chat_id = c.id AND cp2.user_id != %s
                    LIMIT 1
                )) AS chat_avatar,
                COUNT(*) AS count,
                MAX(m.created_at) AS last_at
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
            WHERE m.is_deleted = false
              AND jsonb_array_length(COALESCE(m.attachments, '[]'::jsonb)) > 0
              AND m.chat_id IN (
                  SELECT chat_id FROM chat_participants WHERE user_id = %s
              )
            GROUP BY c.id, c.title, c.is_group, c.avatar
            ORDER BY MAX(m.created_at) DESC
        """
        rows = self.conn.fetch_all(query, (user_id, user_id, user_id))
        return [dict(r) for r in rows]

    def get_chat_attachments(self, user_id: str, file_type: Optional[str] = None,
                             limit: int = 200, offset: int = 0,
                             chat_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Return message attachments (+ links from content) for user, optionally filtered by chat."""
        params: list = [user_id]
        chat_filter = ""
        if chat_id:
            chat_filter = "AND m.chat_id = %s"
            params.append(chat_id)
        type_filter = ""
        if file_type:
            type_filter = "AND att->>'type' = %s"
            params.append(file_type)
        params.extend([limit, offset])

        query = f"""
            SELECT
                m.id AS message_id,
                m.chat_id,
                m.author_id,
                m.created_at,
                att->>'url' AS url,
                COALESCE(att->>'name', att->>'filename') AS filename,
                att->>'type' AS file_type,
                (att->>'size')::bigint AS size,
                u.name AS author_name,
                c.title AS chat_name
            FROM messages m
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(m.attachments, '[]'::jsonb)) att
            LEFT JOIN users u ON u.id = m.author_id
            LEFT JOIN chats c ON c.id = m.chat_id
            WHERE m.is_deleted = false
              AND m.chat_id IN (
                  SELECT chat_id FROM chat_participants WHERE user_id = %s
              )
              AND (att->>'url') IS NOT NULL
              AND (att->>'url') != ''
              {chat_filter}
              {type_filter}
            ORDER BY m.created_at DESC
            LIMIT %s OFFSET %s
        """
        rows = self.conn.fetch_all(query, tuple(params))
        results = [dict(r) for r in rows]

        if chat_id and not file_type:
            # Scan only the 300 most recent messages with URLs to avoid full-table regex
            link_query = """
                SELECT
                    src.id AS message_id,
                    src.chat_id,
                    src.author_id,
                    src.created_at,
                    t.link AS url,
                    t.link AS filename,
                    'link' AS file_type,
                    NULL::bigint AS size,
                    u.name AS author_name,
                    c.title AS chat_name
                -- Also: `c.name` doesn't exist on `chats` (the column is `title`,
                -- correctly used as `c.title AS chat_name` in the attachment query
                -- right above this one) — a second independent error in this same
                -- query, on top of the join-scoping one below.
                -- This was previously `FROM (...) src, LATERAL (...) t LEFT JOIN users u
                -- ON u.id = src.author_id` — mixing an implicit comma-join with an
                -- explicit JOIN chain. Postgres builds explicit JOINs as a strict
                -- left-linear tree scoped to what's already inside that chain; `src`
                -- was only a comma-joined sibling of `t`, not part of the `t LEFT JOIN
                -- u` sub-tree, so referencing `src.author_id` in that ON clause was
                -- flatly invalid SQL ("invalid reference to FROM-clause entry for
                -- table src") — this query has been throwing on every single call and
                -- returning nothing (fetch_all's bare except swallows the error), for
                -- EVERY chat, since it was written. That's the actual "far from all
                -- links" bug: the plain-text-in-message-content link scan never
                -- worked at all; only explicit link-preview attachment rows (the
                -- separate query above this one) were ever returned. Rewritten as one
                -- single explicit join chain (CROSS JOIN LATERAL instead of a comma)
                -- so `src` stays in scope for the LEFT JOINs that follow it.
                FROM (
                    SELECT * FROM messages
                    WHERE is_deleted = false
                      AND chat_id = %s
                      AND content ~ 'https?://'
                    ORDER BY created_at DESC
                    LIMIT 300
                ) src
                CROSS JOIN LATERAL (
                    SELECT unnest(regexp_matches(src.content, %s, 'g')) AS link
                ) t
                LEFT JOIN users u ON u.id = src.author_id
                LEFT JOIN chats c ON c.id = src.chat_id
                ORDER BY src.created_at DESC
                LIMIT 200
            """
            link_rows = self.conn.fetch_all(link_query, (chat_id, 'https?://[^\\s<>"\']+'))
            # Dedup by (message_id, url) — not by url alone — so the same link shared
            # in several different messages still counts as several entries. Only
            # collapses a link that would otherwise show up twice for the *same*
            # message (e.g. once via an explicit attachment row, once via the
            # content regex scan above).
            seen = {(r.get('message_id'), r.get('url')) for r in results}
            for row in link_rows:
                d = dict(row)
                key = (d.get('message_id'), d.get('url'))
                if key not in seen:
                    results.append(d)
                    seen.add(key)
            results.sort(key=lambda x: x.get('created_at') or '', reverse=True)

        return results
