-- Базовая схема Шара (таблицы мессенджера). Идемпотентна: безопасно поверх существующей базы старого бэкенда.
-- Сформирована из боевой схемы (schema.sql + активные миграции + _ensure_*), без таблиц парсеров, фидов и слововола.

CREATE TABLE IF NOT EXISTS chat_participants (
    id integer NOT NULL,
    chat_id character varying(255) NOT NULL,
    user_id character varying(255) NOT NULL,
    joined_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE IF NOT EXISTS chat_participants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE chat_participants_id_seq OWNED BY chat_participants.id;

CREATE TABLE IF NOT EXISTS chats (
    id character varying(255) NOT NULL,
    title character varying(255),
    is_group boolean DEFAULT false,
    is_notifications_chat boolean DEFAULT false,
    is_system_chat boolean DEFAULT false,
    is_favorites_chat boolean DEFAULT false,
    creator_id character varying(255),
    todo_id character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    unread_count integer DEFAULT 0,
    read_messages_by_user jsonb DEFAULT '{}'::jsonb,
    pinned_by_user jsonb DEFAULT '{}'::jsonb,
    last_message_id character varying(255),
    pinned_order_by_user jsonb DEFAULT '{}'::jsonb,
    archived_by_user jsonb DEFAULT '{}'::jsonb,
    muted_by_user jsonb DEFAULT '{}'::jsonb,
    discussion_status character varying(50),
    avatar text,
    read_at_by_user jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cloud_files (
    id character varying(255) NOT NULL,
    name character varying(500) NOT NULL,
    folder_id character varying(255),
    owner_id character varying(255) NOT NULL,
    url text NOT NULL,
    s3_key text,
    size bigint DEFAULT 0,
    mime_type character varying(255),
    file_type character varying(50) DEFAULT 'file'::character varying,
    shared_with jsonb DEFAULT '[]'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    edit_access jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cloud_folders (
    id character varying(255) NOT NULL,
    name character varying(500) NOT NULL,
    parent_id character varying(255),
    owner_id character varying(255) NOT NULL,
    shared_with jsonb DEFAULT '[]'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    sort_order integer DEFAULT 0,
    is_pinned boolean DEFAULT false,
    color character varying(20) DEFAULT NULL::character varying,
    edit_access jsonb DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS departments (
    id character varying(255) NOT NULL,
    name text NOT NULL,
    color character varying(20) DEFAULT '#6b7280'::character varying,
    order_num integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    parent_id character varying(255)
);

COMMENT ON TABLE departments IS 'Real department directory: stable id, display name, color. users.department stores the id.';

COMMENT ON COLUMN departments.id IS 'Stable slug derived from name at creation time (see slugify_department in db_postgres.py); never changes on rename.';

CREATE TABLE IF NOT EXISTS email_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id character varying NOT NULL,
    name character varying NOT NULL,
    email character varying NOT NULL,
    imap_host character varying NOT NULL,
    imap_port integer DEFAULT 993,
    smtp_host character varying NOT NULL,
    smtp_port integer DEFAULT 587,
    username character varying NOT NULL,
    password_enc text NOT NULL,
    use_ssl boolean DEFAULT true,
    signature text DEFAULT ''::text,
    created_at timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_chat_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id character varying NOT NULL,
    account_id uuid,
    email_pattern character varying(255) NOT NULL,
    chat_id character varying(255) NOT NULL,
    description character varying(500) DEFAULT ''::character varying,
    keyword character varying(500) DEFAULT ''::character varying,
    created_at timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid,
    uid character varying,
    folder character varying DEFAULT 'INBOX'::character varying,
    message_id character varying,
    thread_id character varying,
    subject character varying DEFAULT ''::character varying,
    from_addr character varying DEFAULT ''::character varying,
    from_name character varying DEFAULT ''::character varying,
    to_addrs jsonb DEFAULT '[]'::jsonb,
    cc_addrs jsonb DEFAULT '[]'::jsonb,
    bcc_addrs jsonb DEFAULT '[]'::jsonb,
    body_text text DEFAULT ''::text,
    body_html text DEFAULT ''::text,
    attachments jsonb DEFAULT '[]'::jsonb,
    is_read boolean DEFAULT false,
    is_starred boolean DEFAULT false,
    is_draft boolean DEFAULT false,
    date timestamp without time zone,
    fetched_at timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
    id character varying(255) NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    start_date timestamp without time zone,
    end_date timestamp without time zone,
    user_id character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    metadata jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS mail_folder_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id character varying NOT NULL,
    folder_id uuid,
    email_pattern character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mail_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id character varying NOT NULL,
    name character varying(100) NOT NULL,
    color character varying(20) DEFAULT '#3b82f6'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_reactions (
    id integer NOT NULL,
    message_id character varying(255) NOT NULL,
    user_id character varying(255) NOT NULL,
    reaction character varying(50),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE IF NOT EXISTS message_reactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE message_reactions_id_seq OWNED BY message_reactions.id;

CREATE TABLE IF NOT EXISTS messages (
    id character varying(255) NOT NULL,
    chat_id character varying(255) NOT NULL,
    author_id character varying(255) NOT NULL,
    author_name character varying(255),
    content text,
    mentions jsonb DEFAULT '[]'::jsonb,
    reply_to_id character varying(255),
    is_edited boolean DEFAULT false,
    is_deleted boolean DEFAULT false,
    is_system_message boolean DEFAULT false,
    notification_type character varying(100),
    linked_chat_id character varying(255),
    linked_message_id character varying(255),
    linked_task_id character varying(255),
    linked_post_id character varying(255),
    attachments jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    id integer NOT NULL,
    key character varying(255) NOT NULL,
    value jsonb,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE IF NOT EXISTS settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE settings_id_seq OWNED BY settings.id;

CREATE TABLE IF NOT EXISTS tasks (
    id character varying(255) NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    is_completed boolean DEFAULT false,
    priority character varying(50) DEFAULT 'medium'::character varying,
    status character varying(50) DEFAULT 'pending'::character varying,
    list_id character varying(100),
    tags jsonb DEFAULT '[]'::jsonb,
    assigned_by_id character varying(255),
    assigned_by character varying(255),
    assigned_to character varying(255),
    assigned_to_ids jsonb DEFAULT '[]'::jsonb,
    author_id character varying(255),
    add_to_calendar boolean DEFAULT false,
    due_date timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    task_order integer DEFAULT 0,
    archived boolean DEFAULT false,
    review_comment text
);

COMMENT ON COLUMN tasks.archived IS 'Флаг архивации задачи';

CREATE TABLE IF NOT EXISTS todo_categories (
    id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    color character varying(50) DEFAULT '#3b82f6'::character varying,
    icon character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    category_order integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS todo_lists (
    id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    color character varying(50) DEFAULT '#3b82f6'::character varying,
    icon character varying(255),
    department character varying(255),
    archived boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    list_order integer DEFAULT 0
);

COMMENT ON COLUMN todo_lists.archived IS 'Флаг архивации списка задач';

CREATE TABLE IF NOT EXISTS users (
    id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    username character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    password character varying(255) NOT NULL,
    role character varying(50) DEFAULT 'user'::character varying,
    todo_role character varying(50) DEFAULT 'universal'::character varying,
    "position" character varying(255),
    department character varying(255),
    phone character varying(20),
    work_schedule text,
    telegram_id character varying(255),
    telegram_username character varying(255),
    is_department_head boolean DEFAULT false,
    is_active boolean DEFAULT true,
    enabled_tools jsonb DEFAULT '[]'::jsonb,
    can_see_all_tasks boolean DEFAULT false,
    avatar character varying(255),
    is_online boolean DEFAULT false,
    last_seen timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    pinned_tools jsonb DEFAULT '[]'::jsonb,
    visible_tabs jsonb DEFAULT '{"links": true, "tasks": true, "calendar": true, "contacts": true, "messages": true}'::jsonb,
    chat_settings jsonb DEFAULT '{"fontSize": 13, "bubbleColor": "#3c3d96", "bubbleStyle": "modern", "colorPreset": 0, "fontSizeMobile": 15, "bubbleColorLight": "#453de6"}'::jsonb,
    tools_order jsonb DEFAULT '[]'::jsonb,
    is_disabled boolean DEFAULT false,
    department_ids text[] DEFAULT '{}'::text[]
);

COMMENT ON COLUMN users.is_department_head IS 'Является ли пользователь руководителем отдела';

COMMENT ON COLUMN users.pinned_tools IS 'User''s pinned tools in bottom navigation (max 3)';

COMMENT ON COLUMN users.visible_tabs IS 'Видимые вкладки навигации пользователя';

COMMENT ON COLUMN users.chat_settings IS 'Chat appearance settings (bubble style, colors, fonts)';

COMMENT ON COLUMN users.tools_order IS 'Порядок инструментов на рабочем столе';

ALTER TABLE ONLY chat_participants ALTER COLUMN id SET DEFAULT nextval('chat_participants_id_seq'::regclass);

ALTER TABLE ONLY message_reactions ALTER COLUMN id SET DEFAULT nextval('message_reactions_id_seq'::regclass);

ALTER TABLE ONLY settings ALTER COLUMN id SET DEFAULT nextval('settings_id_seq'::regclass);

DO $$ BEGIN
    ALTER TABLE ONLY chat_participants
        ADD CONSTRAINT chat_participants_chat_id_user_id_key UNIQUE (chat_id, user_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY chat_participants
        ADD CONSTRAINT chat_participants_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY chats
        ADD CONSTRAINT chats_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY cloud_files
        ADD CONSTRAINT cloud_files_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY cloud_folders
        ADD CONSTRAINT cloud_folders_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY departments
        ADD CONSTRAINT departments_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY email_accounts
        ADD CONSTRAINT email_accounts_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY email_chat_rules
        ADD CONSTRAINT email_chat_rules_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY email_messages
        ADD CONSTRAINT email_messages_account_id_uid_folder_key UNIQUE (account_id, uid, folder);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY email_messages
        ADD CONSTRAINT email_messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY events
        ADD CONSTRAINT events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY mail_folder_rules
        ADD CONSTRAINT mail_folder_rules_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY mail_folders
        ADD CONSTRAINT mail_folders_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY message_reactions
        ADD CONSTRAINT message_reactions_message_id_user_id_reaction_key UNIQUE (message_id, user_id, reaction);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY message_reactions
        ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY messages
        ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY settings
        ADD CONSTRAINT settings_key_key UNIQUE (key);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY settings
        ADD CONSTRAINT settings_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY tasks
        ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY todo_categories
        ADD CONSTRAINT todo_categories_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY todo_lists
        ADD CONSTRAINT todo_lists_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY users
        ADD CONSTRAINT users_email_key UNIQUE (email);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY users
        ADD CONSTRAINT users_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY users
        ADD CONSTRAINT users_username_key UNIQUE (username);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_chat_participants_chat_id ON chat_participants USING btree (chat_id);

CREATE INDEX IF NOT EXISTS idx_chat_participants_user_id ON chat_participants USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_chats_creator_id ON chats USING btree (creator_id);

CREATE INDEX IF NOT EXISTS idx_chats_is_group ON chats USING btree (is_group);

CREATE INDEX IF NOT EXISTS idx_chats_is_system ON chats USING btree (is_system_chat);

CREATE INDEX IF NOT EXISTS idx_chats_todo_id ON chats USING btree (todo_id);

CREATE INDEX IF NOT EXISTS idx_cloud_files_folder ON cloud_files USING btree (folder_id);

CREATE INDEX IF NOT EXISTS idx_cloud_files_owner ON cloud_files USING btree (owner_id);

CREATE INDEX IF NOT EXISTS idx_cloud_files_shared ON cloud_files USING gin (shared_with);

CREATE INDEX IF NOT EXISTS idx_cloud_folders_owner ON cloud_folders USING btree (owner_id);

CREATE INDEX IF NOT EXISTS idx_cloud_folders_parent ON cloud_folders USING btree (parent_id);

CREATE INDEX IF NOT EXISTS idx_cloud_folders_shared ON cloud_folders USING gin (shared_with);

CREATE INDEX IF NOT EXISTS idx_email_accounts_user ON email_accounts USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_email_chat_rules_account ON email_chat_rules USING btree (account_id);

CREATE INDEX IF NOT EXISTS idx_email_chat_rules_user ON email_chat_rules USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_email_messages_account ON email_messages USING btree (account_id);

CREATE INDEX IF NOT EXISTS idx_email_messages_date ON email_messages USING btree (date DESC);

CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages USING btree (thread_id);

CREATE INDEX IF NOT EXISTS idx_events_start_date ON events USING btree (start_date);

CREATE INDEX IF NOT EXISTS idx_events_user_id ON events USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_mail_folder_rules_folder ON mail_folder_rules USING btree (folder_id);

CREATE INDEX IF NOT EXISTS idx_mail_folders_user ON mail_folders USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions USING btree (message_id);

CREATE INDEX IF NOT EXISTS idx_messages_author_created ON messages USING btree (author_id, created_at) WHERE (is_deleted = false);

CREATE INDEX IF NOT EXISTS idx_messages_author_id ON messages USING btree (author_id);

CREATE INDEX IF NOT EXISTS idx_messages_call_metadata ON messages USING btree (chat_id, ((metadata ->> 'callId'::text))) WHERE ((notification_type)::text = 'call'::text);

CREATE INDEX IF NOT EXISTS idx_messages_chat_author_created_active ON messages USING btree (chat_id, author_id, created_at DESC) WHERE (is_deleted = false);

CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages USING btree (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_chat_created_active ON messages USING btree (chat_id, created_at DESC) WHERE (is_deleted = false);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages USING btree (chat_id);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages USING btree (created_at);

CREATE INDEX IF NOT EXISTS idx_messages_is_system ON messages USING btree (is_system_message);

CREATE INDEX IF NOT EXISTS idx_messages_notif_type ON messages USING btree (chat_id, notification_type);

CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks USING btree (archived);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_by_id ON tasks USING btree (assigned_by_id);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks USING btree (assigned_to);

CREATE INDEX IF NOT EXISTS idx_tasks_author_id ON tasks USING btree (author_id);

CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks USING btree (due_date);

CREATE INDEX IF NOT EXISTS idx_tasks_is_completed ON tasks USING btree (is_completed);

CREATE INDEX IF NOT EXISTS idx_tasks_list_id ON tasks USING btree (list_id);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks USING btree (status);

CREATE INDEX IF NOT EXISTS idx_todo_lists_archived ON todo_lists USING btree (archived);

CREATE INDEX IF NOT EXISTS idx_users_email ON users USING btree (email);

CREATE INDEX IF NOT EXISTS idx_users_username ON users USING btree (username);

DO $$ BEGIN
    ALTER TABLE ONLY chat_participants
        ADD CONSTRAINT chat_participants_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY chat_participants
        ADD CONSTRAINT chat_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY chats
        ADD CONSTRAINT chats_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY cloud_files
        ADD CONSTRAINT cloud_files_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES cloud_folders(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY cloud_folders
        ADD CONSTRAINT cloud_folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES cloud_folders(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY email_chat_rules
        ADD CONSTRAINT email_chat_rules_account_id_fkey FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY email_messages
        ADD CONSTRAINT email_messages_account_id_fkey FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY events
        ADD CONSTRAINT events_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY mail_folder_rules
        ADD CONSTRAINT mail_folder_rules_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES mail_folders(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY message_reactions
        ADD CONSTRAINT message_reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY message_reactions
        ADD CONSTRAINT message_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY messages
        ADD CONSTRAINT messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY messages
        ADD CONSTRAINT messages_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY messages
        ADD CONSTRAINT messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY tasks
        ADD CONSTRAINT tasks_assigned_by_id_fkey FOREIGN KEY (assigned_by_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY tasks
        ADD CONSTRAINT tasks_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
