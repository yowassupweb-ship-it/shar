-- «Офис» включён у всех: у существующих пользователей — явно, у новых — через значение по умолчанию.
UPDATE users
   SET visible_tabs = COALESCE(visible_tabs, '{}'::jsonb) || '{"office": true}'::jsonb
 WHERE COALESCE(visible_tabs->>'office', '') <> 'true';

ALTER TABLE users ALTER COLUMN visible_tabs
  SET DEFAULT '{"links": true, "tasks": true, "calendar": true, "contacts": true, "messages": true, "office": true}'::jsonb;
