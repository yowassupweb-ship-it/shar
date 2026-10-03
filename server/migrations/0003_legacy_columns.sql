-- Колонки, которые старый бэкенд добавлял отдельными скриптами (migrate_tasks_columns.py и др.).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category_id VARCHAR(255);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_response TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS calendar_event_id VARCHAR(255);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS calendar_list_id VARCHAR(255);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_to_id VARCHAR(255);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review_comment TEXT;
