-- Системные сообщения («Заявка закрыта», плашки чатов) не имеют автора-пользователя.
-- Раньше они писались с author_id = 'system', что нарушало внешний ключ на users, и сообщение молча терялось.
ALTER TABLE messages ALTER COLUMN author_id DROP NOT NULL;
