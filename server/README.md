# Шар API

FastAPI-сервис: сессии (кука `shar_session`, хранятся в Redis), REST, WebSocket `/api/ws`, web-push.

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env     # переменные описаны в файле
.venv/bin/python -m app  # :8100, /api/v2/docs
.venv/bin/python -m pytest -q
```

## Устройство

```
app/
  main.py        сборка: access log → AuthGate → роутеры модулей
  config.py      все настройки из окружения
  migrate.py     применение migrations/*.sql и DDL модулей
  core/          db (репозитории-миксины), security, sessions, realtime, kv, ratelimit, s3, storage…
  modules/       auth users departments chats calls cloud mail todos calendar files push
                 notifications requests utm og integrations admin ops realtime
migrations/      0001_baseline … — идемпотентные, учёт в schema_migrations
tests/           pytest на живых Postgres (shar_test) и Redis
```

- Доступ: `AuthGate` пускает только с сессией (публичные префиксы — `core/security.py`);
  права — зависимости `current_identity`, `require_admin`.
- Онлайн: аренды в Redis (`shar:presence:<uid>`, TTL 60 с, продление ~15 с) — счётчик не «залипает».
- Внешние уведомления: `POST /api/integrations/...` с ключом, см. `../docs/INTEGRATION_API.md`.
- Известные ограничения: файлы `/api/uploads` открыты по прямой ссылке (имена — uuid); токены сессий
  в Redis хранятся как есть; смена пароля не требует текущего.
