# Шар

Рабочая система команды «Вокруг света»: чаты, задачи, календарь, почта, «Офис» (заметки, документы, таблицы,
презентации), файлы, контакты, соцсети, заявки.

- `src/` — клиент: React 19 + Vite + react-router 7 + zustand (слои `app → features → shared`, проверяет eslint);
- `server/` — API: FastAPI + PostgreSQL + Redis (см. [server/README.md](server/README.md)); документы «Офиса» хранятся в S3;
- `desktop/` — Shar OS, клиент для компьютера на Electron (интерфейс встроен — тот же `dist/`, что у сайта);
- `docker/`, `compose.*.yaml`, `deploy/` — сборка образов и конфигурация прода;
- `scripts/` — выкладка, публикация Shar OS, разработка на боевой базе;
- `docs/` — [выпуск](docs/RELEASE.md), [MCP «Офиса»](docs/MCP.md), API уведомлений для внешних систем.

Как работать в репозитории (задачи, проверки, выпуск) — [CLAUDE.md](CLAUDE.md).

## Разработка

```bash
npm install
npm run dev            # http://localhost:3005, /api → :8100
cd server && python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env   # заполнить DB_*, SHAR_SECRET_KEY
.venv/bin/python -m app
```

На своей базе сервис при старте сам создаёт схему (`SHAR_AUTO_MIGRATE` по умолчанию включён). На боевой базе — только
отдельным шагом выпуска.

Разработка на боевой базе (туннель, API, Vite, Shar OS): `./scripts/dev-prod.ps1 -Electron` — подробно в
[docs/RELEASE.md](docs/RELEASE.md#разработка-на-боевой-базе).

## Проверки

```bash
npm run typecheck && npm run lint && npm run build
cd server && .venv/bin/python -m pytest -q   # нужны Postgres и Redis (SHAR_TEST_DB_*, REDIS_URL — см. tests/conftest.py)
```

CI (`.github/workflows/ci.yml`) гоняет то же на каждый push в `main` и на pull request.

## Выпуск

Сайт и API — `scripts/deploy-server.ps1`, Shar OS — `scripts/publish-electron.ps1`. Правила, устройство прода, схема
базы, откат — [docs/RELEASE.md](docs/RELEASE.md).

## Настройки сервиса

| Переменная | Зачем |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | PostgreSQL |
| `REDIS_URL` | сессии, счётчики, живые события между воркерами |
| `SHAR_SECRET_KEY` | шифрование паролей почтовых ящиков |
| `SHAR_INTEGRATION_API_KEY` | внешний API уведомлений (`docs/INTEGRATION_API.md`) |
| `SHAR_INTERNAL_PUSH_KEY` | вызовы `/api/push/notify` между сервисами |
| `WEB_PUSH_PUBLIC_KEY` / `WEB_PUSH_PRIVATE_KEY` | web-push |
| `S3_*` | хранилище содержимого «Офиса» |
| `SHAR_AUTO_MIGRATE`, `SHAR_STARTUP_MAINTENANCE`, `SHAR_SCHEDULED_JOBS`, `SHAR_MAIL_WATCH` | схема при старте и фоновые задачи; на проде все `0` (их пока выполняет старый бэкенд) |
| `SHAR_ADMIN_ACTIONS` | кнопки обслуживания в админке (иначе скрыты) |
