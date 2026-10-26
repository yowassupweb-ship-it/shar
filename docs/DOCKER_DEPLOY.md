# Docker deployment without production downtime

The Docker stack is intentionally separate from the current systemd deployment.
Nothing in this runbook stops or edits the old application automatically.

## Local verification

Prerequisites:

- Docker Desktop with Compose v2;
- the PostgreSQL SSH tunnel listening on `127.0.0.1:55432`;
- database credentials exported in the current shell or placed in an ignored
  root `.env` file.

Automatic database migrations, startup maintenance, scheduled jobs, and mail
watchers are disabled in the local compose file.

```powershell
docker compose -f compose.local.yaml build
docker compose -f compose.local.yaml up -d
docker compose -f compose.local.yaml ps
Invoke-WebRequest http://127.0.0.1:8085/healthz
Invoke-WebRequest http://127.0.0.1:8085/api/v2/health
```

The UI is available at `http://127.0.0.1:8085`. Stop only this isolated stack:

```powershell
docker compose -f compose.local.yaml down
```

Do not add `-v`: the Redis volume is useful between local restarts.

## Build immutable images

Run the `Build Docker images` workflow manually in GitHub Actions. It publishes
`shar-api` and `shar-web` to GHCR with the full Git commit SHA as the tag. The
production server only pulls images; it does not run the memory-heavy Vite build.

## First production launch: no traffic, no migrations

1. Install Docker Engine and the Compose plugin without stopping systemd, Nginx,
   PostgreSQL, or Redis.
2. Copy `deploy/docker/production.env.example` to `/etc/shar-next/api.env`, fill
   it from the existing service environment, and set mode `600`.
3. Identify the current persistent data/uploads directory. Do not create a new
   empty directory and do not move the existing one.
4. Read its numeric owner and group with `stat -c '%u:%g' <directory>`. The API
   container runs as that same identity, so no ownership change can break the
   old application.
5. Log in to GHCR using a read-only package token, then set deployment variables.
   `SHAR_IMAGE_TAG` must be an immutable commit SHA.

```bash
export SHAR_IMAGE_TAG='<full-git-sha>'
export SHAR_ENV_FILE='/etc/shar-next/api.env'
export SHAR_DATA_DIR='<existing-absolute-data-directory>'
export SHAR_RUNTIME_UID='<existing-directory-owner-uid>'
export SHAR_RUNTIME_GID='<existing-directory-owner-gid>'
docker compose -f compose.production.yaml pull
docker compose -f compose.production.yaml up -d
```

This starts the candidate on loopback only:

- web: `127.0.0.1:18080`;
- API: `127.0.0.1:18100`;
- old production ports and services remain untouched.

The candidate starts in standby mode: migrations, startup maintenance,
reminders, and mail watchers are disabled. The old backend remains the only
background worker while both versions are online.

Verify before changing Nginx:

```bash
curl --fail http://127.0.0.1:18080/healthz
curl --fail http://127.0.0.1:18100/api/v2/health
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs --tail=200 api web
```

Test login, session reuse, chat read/send, WebSocket reconnect, upload/download,
notifications, mail, and one old Electron client through a temporary internal
hostname. The candidate and old application must use the same production Redis
so existing sessions survive the cutover.

## Database migrations

`SHAR_AUTO_MIGRATE=0` is forced in production. Never run migrations as part of
container startup. Before an explicit migration:

1. review every pending SQL file for backward compatibility with the old app;
2. take and verify a PostgreSQL backup;
3. test the migration against a recent clone;
4. only then run the one-shot maintenance profile:

```bash
docker compose -f compose.production.yaml --profile maintenance run --rm migrate
```

If a migration is not backward compatible, do not use zero-downtime switching;
plan a short write freeze and a separate rollback procedure instead.

## Nginx cutover and rollback

Keep the existing `/updates/` location unchanged. The Electron update feed is
not part of the containers. Adapt the example in
`deploy/docker/nginx-blue-green.conf.example`, validate with `nginx -t`, then
reload Nginx. A reload is atomic and does not stop active connections.

Rollback is the inverse Nginx change followed by another `nginx -t` and reload.
Do not stop the old systemd services during the observation period.

After the observation period, transfer background-worker ownership separately:

1. keep the new web/API serving traffic;
2. stop only the old backend service;
3. set `SHAR_SCHEDULED_JOBS=1` and `SHAR_MAIL_WATCH=1` in the deployment shell;
4. recreate only the new API container:

   ```bash
   docker compose -f compose.production.yaml up -d --no-deps --force-recreate api
   ```

5. verify reminders and IMAP watchers in its logs.

For rollback, first disable those two flags on the new API, then restart the old
backend. Never leave both sets of background workers enabled.

## Electron release

Release Electron only after the Docker production stack has been stable and the
old Electron client has passed smoke tests. Upload installer, package, blockmap,
and other payload files first. Publish `latest.yml` last via an atomic rename.
That keeps old clients on the working release until the new release is complete.
