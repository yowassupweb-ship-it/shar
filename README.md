# Шар

Мессенджер команды: чаты, задачи, календарь, почта, файлы, контакты.

- `src/` — клиент: React 19 + Vite + react-router 7 + zustand (слои `app → features → shared`, проверяет eslint);
- `server/` — API: FastAPI + PostgreSQL + Redis (см. [server/README.md](server/README.md)); документы «Офиса» хранятся в S3;
- `desktop/` — клиент для компьютера на Electron;
- `deploy/` — примеры nginx и systemd;
- `docs/` — API уведомлений для внешних систем.

## Разработка

```bash
npm install
npm run dev            # http://localhost:3005, /api → :8100
cd server && python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env   # заполнить DB_*, SHAR_SECRET_KEY
.venv/bin/python -m app
```

```bash
npm run typecheck && npm run lint && npm run build
cd server && .venv/bin/python -m pytest -q   # нужны Postgres и Redis
```

## Выкат

`npm run build` → `dist/` отдаёт nginx, `/api` и `/api/ws` — на сервис (`deploy/nginx.conf`,
`deploy/shar-server.service`). Схема базы совместима со старой: `migrations/*.sql` идемпотентны и
применяются при старте. Сессии лежат в Redis под теми же ключами, что и раньше, — пользователи
остаются залогиненными.

## Что нужно задать при переходе со старой версии

| Переменная | Зачем |
| --- | --- |
| `SHAR_SECRET_KEY` | шифрование паролей почтовых ящиков (старые base64 перешифруются при старте) |
| `SHAR_INTEGRATION_API_KEY` | внешний API уведомлений, контракт прежний (`docs/INTEGRATION_API.md`) |
| `SHAR_INTERNAL_PUSH_KEY` | вызовы `/api/push/notify` между сервисами |
| `WEB_PUSH_PUBLIC_KEY` / `WEB_PUSH_PRIVATE_KEY` | web-push |
| `SHAR_ADMIN_ACTIONS` | кнопки обслуживания в админке (иначе скрыты) |

## Что не переносилось

Парсеры и инструменты туризма, фиды, словолов, планы контента, карта офиса, ссылки/«поделиться»,
вход и вебхук Telegram. Админка больше не показывает пароли: вместо этого — «Сбросить пароль»
(временный пароль виден один раз).
