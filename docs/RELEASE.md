# Выпуск Шара

Как устроен прод, как выкладывать сайт с API и Shar OS, как догонять схему базы и как откатываться.
Состояние описано на 27.10.2026. Если меняете процесс, меняйте и этот файл.

## Правила

1. **Только по «да» владельца и только законченное.** Посреди работы прод не выкладывается и Shar OS не
   публикуется: сначала доделать, проверить в интерфейсе, спросить.
2. **Прод = git.** Выкладывается только чистый `main`, запушенный в `origin`. Скрипт выкладки это проверяет.
   Пушить в `origin` можно только с разрешения владельца.
3. **Одна сборка везде.** Тот же `dist/`, что отдаёт сайт, кладётся в установщик Shar OS (там интерфейс встроенный,
   с сервера он не грузится). Сверка идёт по `assets/index-*.js`.
4. **Схема — отдельным шагом.** На проде `SHAR_AUTO_MIGRATE=0`: при старте сервис схему не трогает. Новые таблицы и
   столбцы применяются при выкладке (`-Schema`) до запуска нового кода. Код, который ждёт новую таблицу, должен
   работать и без неё (см. `store.table_ready`): так выкладка не ломает то, что работало.
5. **`latest.yml` — последним.** Сначала пакет и установщик, потом атомарная замена `latest.yml`. Иначе клиенты
   увидят версию, пакет которой ещё не докачан.
6. **Перед каждым изменением на сервере — бэкап** в `/root/backups` (скрипты делают его сами).
7. **Итог — в MBOX** (проект `shar-messenger`): что выкачено, коммит, сборка, бэкап, что проверено.

## Как устроен прод

Сервер `81.90.31.129` (Ubuntu, 2 ГБ памяти, диск 20 ГБ), домен `vokrug-sveta.shar-os.ru`.

| Что | Где |
| --- | --- |
| Сайт и API | `/opt/shar-next` (не git, копия), `docker compose -f compose.live.yaml`: `shar-live-web` (nginx со сборкой, `127.0.0.1:18081`), `shar-live-api` (FastAPI, `127.0.0.1:18101`) |
| Настройки API | `/opt/shar-next/api.prod.env` (права 600, в git нет) |
| Вход снаружи | системный nginx: `/etc/nginx/sites-enabled/default`. `/`, `/api/`, `/api/ws/` идут в новый стек, `/updates/` — в каталог |
| Обновления Shar OS | `/var/www/shar/updates` (`latest.yml`, `Shar setup-<версия>.exe`, `Shar setup.exe`, `shar-os-client-<версия>-x64.nsis.7z`) |
| База | PostgreSQL 16 на хосте (`shar_messenger`), Redis на хосте |
| Файлы | `/var/www/shar/data`, `/var/www/shar/backend/uploads` (смонтированы в API), документы «Офиса» — в S3 (Yandex Object Storage) |
| Старый бэкенд | `shar-backend.service` (uvicorn `:8000`) ещё работает: вебхук и вход Telegram, **фоновые задачи** (напоминания, наблюдение за почтой — у нового API они выключены) |
| Старый фронт | `shar-frontend.service` (Next, `:3000`) работает, трафика не получает |
| Песочница | `shar-preview-*` (контейнеры с 05.10 на клоне базы), трафика не получает |

## Доступ к серверу

Ключ из `~/.ssh` сервер не принимает, вход по паролю root через модуль Posh-SSH
(`Install-Module Posh-SSH -Scope CurrentUser`). Пароль лежит в файле **вне репозитория** строкой `SSH_PASSWORD=...`.
Путь к файлу задаётся параметром `-CredentialFile`, переменной `SHAR_SSH_CREDENTIALS` или файлом `~/.shar/ssh.env`.
В MBOX и git пароль не кладётся.

## Сайт и API

```powershell
npm run typecheck; npm run lint; cd server; .venv\Scripts\python.exe -m pytest -q; cd ..
./scripts/deploy-server.ps1 -Label <что-выкладываем>                     # сухой прогон: проверки и план
./scripts/deploy-server.ps1 -Label <что-выкладываем> -Schema -Execute    # выкладка
```

Что делает скрипт (`scripts/deploy-server.ps1`):

1. Проверяет git: `main`, рабочая копия чистая, всё запушено. Собирает `dist`.
2. Проверяет место на диске: нужно ≥ 1,5 ГБ, иначе выкладка останавливается (см. «Диск»).
3. Делает бэкап `/root/backups/shar-next-before-<Label>.<время>.tgz`.
4. Раскладывает архив в `/opt/shar-next`. `dist` заменяется целиком, прежний остаётся в `dist.prev`.
5. Запускает `docker compose build`.
6. С `-Schema` применяет `python -m app.migrate --schema-only` в разовом контейнере нового образа, до запуска.
7. Запускает `docker compose up -d`, ждёт `healthy`, проверяет `/api/v2/health` и то, какой `index-*.js` отдаёт сайт.

### Схема базы

DDL живёт рядом с кодом: `schema.register(...)` в модулях, всё через `IF NOT EXISTS`. Посмотреть, что будет применено:

```bash
docker compose -f /opt/shar-next/compose.live.yaml --project-directory /opt/shar-next run --rm --no-deps api python -m app.migrate --print
```

Перед выкладкой нового DDL прочитать его и убедиться, что старый код с ним работает (только добавление таблиц и
столбцов). Удаление и переименование — отдельный план с остановкой записи, не через `--schema-only`.

### Откат

```bash
cd /opt/shar-next
rm -rf dist && mv dist.prev dist                                  # прежняя сборка
tar -xzf /root/backups/shar-next-before-<Label>.<время>.tgz       # прежний server/, compose, docker
docker compose -f compose.live.yaml up -d --build
```

Добавленные таблицы откатывать не нужно: прежний код их не трогает.

## Shar OS (Electron)

```powershell
cd desktop; npm version patch --no-git-tag-version; cd ..   # версия выше опубликованной; закоммитить
./scripts/publish-electron.ps1              # сухой прогон: версия, та же сборка, что на сайте
./scripts/publish-electron.ps1 -Execute     # сборка и публикация
```

- Сайт выкладывается **раньше**: скрипт сверяет `index-*.js` локального `dist` с тем, что отдаёт сайт.
- `npm run build:win` в `desktop/` копирует `../dist` в `desktop/web` (`scripts/prepare-web.cjs`) без эмодзи (их отдаёт
  сервер) и собирает NSIS web installer в `desktop/release/nsis-web/`. Пересборка `dist` — только `node scripts/prepare-web.cjs --build`, для проверок.
- Порядок загрузки: пакет `.7z` → `Shar setup-<версия>.exe` → `Shar setup.exe` (ссылка «скачать») → `latest.yml` (через `.tmp` + `mv`).
- Бэкапы прежних `latest.yml` и `Shar setup.exe` лежат в `/root/backups/*.before-<версия>`.
- `-PruneOld` удаляет пакеты и установщики старше трёх последних версий (каждый пакет ~108 МБ).
- Workflow `Build Electron (check)` в GitHub только проверяет сборку, вручную и без публикации.

## Разработка на боевой базе

```powershell
./scripts/dev-prod.ps1 -Electron
```

Скрипт поднимает туннель к PostgreSQL прода (`127.0.0.1:55432`), локальный Redis (`:6390`), API (`:8100`) с настройками
прода, Vite (`:3005`) и Shar OS из `desktop/` с интерфейсом из Vite. **Всё пишется в настоящую базу.** Фоновые задачи и
миграции у локального API выключены. Таблиц, которых на проде ещё нет, локально тоже нет: функции, которые их ждут,
скажут «ещё не включено на сервере». Из VS Code Electron запускается без `ELECTRON_RUN_AS_NODE`, скрипт его снимает.

## Диск

На 27.10.2026 свободно около 0,8 ГБ из 20 (96 %). Это опасно: при заполнении диска PostgreSQL перестаёт писать. Что
занимает место и что можно освободить (только с «да» владельца):

| Что | Объём | Как |
| --- | --- | --- |
| Кэш сборки Docker | ~1,8 ГБ | `docker builder prune -f` |
| Песочница `shar-preview-*` (контейнеры и образы) | ~1,8 ГБ | `docker compose -f /opt/shar-next/compose.preview.yaml down` + `docker image prune` |
| Старые пакеты Shar OS | ~0,8 ГБ | `publish-electron.ps1 -PruneOld` |
| `syslog`, журнал | ~0,4 ГБ | ротация logrotate / `journalctl --vacuum-size=100M` |

## Известные долги

- **Безопасность:** PostgreSQL (`5432`) и Redis (`6379`) открыты в интернет (ufw allow, `pg_hba`: `postgres` с любого
  адреса). Нужно закрыть снаружи: всем, кому нужен доступ, хватает SSH-туннеля.
- Старый бэкенд всё ещё выполняет фоновые задачи. Перенос их в новый API описан в `docs/DOCKER_DEPLOY.md`
  («transfer background-worker ownership»).
- `/opt/shar-next` не git-репозиторий: что там лежит, видно только по бэкапам и выводу скрипта выкладки.
