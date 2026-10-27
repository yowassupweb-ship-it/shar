<#
.SYNOPSIS
  Выкладка сайта и API Шара на прод (81.90.31.129, /opt/shar-next, docker compose -f compose.live.yaml).

.DESCRIPTION
  Без -Execute — сухой прогон: проверки и план, на сервере ничего не меняется.
  С -Execute:
    1. проверка места на диске (сборке образов нужно ≥ 1.5 ГБ);
    2. бэкап /root/backups/shar-next-before-<Label>.<время>.tgz (server/app, migrations, dist, compose);
    3. загрузка архива (dist + server + docker + compose.live.yaml) и раскладка в /opt/shar-next;
    4. docker compose build;
    5. -Schema: новые таблицы и столбцы (python -m app.migrate --schema-only) — ДО запуска нового кода;
    6. docker compose up -d, ожидание healthy, проверка /api/v2/health и того, какая сборка отдаётся.
  Выкладывать только из чистого main, запушенного в origin, и только с «да» владельца (docs/RELEASE.md).

  Что уходит на сервер: server, docker, compose.live.yaml и dist. Сайт (dist) обязан быть собран из этого же коммита:
    - сборка идёт скриптом и клеймится (dist/.built-from = коммит); при незакоммиченных правках интерфейса сборка запрещена;
    - -SkipBuild берёт готовый dist только с клеймом текущего коммита (пересобранный кем-то вручную dist — отказ);
    - -ServerOnly выкладывает только бэкенд: dist на сервере не трогается, пересобирается и перезапускается один api.
  -AllowDirty пропускает проверки main/чисто/запушено, но серверный код и интерфейс должны совпадать с коммитом всегда.

.EXAMPLE
  ./scripts/deploy-server.ps1 -Label mcp                       # сухой прогон
  ./scripts/deploy-server.ps1 -Label mcp -Schema -Execute      # выкладка с догоном схемы
  ./scripts/deploy-server.ps1 -Label fix -ServerOnly -Execute  # только бэкенд, сайт и Shar OS не затрагиваются
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9-]+$')][string]$Label,
    [switch]$Execute,
    [switch]$Schema,
    [switch]$SkipBuild,
    [switch]$ServerOnly,
    [switch]$PruneDocker,
    [switch]$AllowDirty,
    [string]$CredentialFile = ''
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/shar-ssh.ps1"
$root = Split-Path -Parent $PSScriptRoot
$remote = '/opt/shar-next'
$compose = "docker compose -f $remote/compose.live.yaml --project-directory $remote"

Push-Location $root
try {
    # ── проверки ──
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    $dirty = git status --porcelain --untracked-files=no
    git fetch -q origin 2>$null
    $unpushed = (git rev-list --count 'origin/main..HEAD').Trim()
    $commit = (git rev-parse --short HEAD).Trim()
    Write-Host "Коммит $commit на ветке $branch; незапушенных: $unpushed; изменённых файлов: $(@($dirty).Count)"
    if (-not $AllowDirty) {
        if ($branch -ne 'main') { throw 'Выкладываем только main (или -AllowDirty для осознанного исключения).' }
        if ($dirty) { throw 'В рабочей копии незакоммиченные правки: прод должен совпадать с git.' }
        if ($unpushed -ne '0') { throw 'main не запушен в origin: прод должен совпадать с GitHub.' }
    }

    # Всё, что уезжает на сервер из рабочей копии, обязано быть закоммичено — даже с -AllowDirty.
    $codeDirty = @(git status --porcelain --untracked-files=all -- server docker compose.live.yaml)
    if ($codeDirty.Count) { throw "Незакоммиченный серверный код попал бы на прод:`n$($codeDirty -join "`n")" }

    # Интерфейс, из которого собирается dist: правки здесь не должны утечь в прод вместе со сборкой.
    $uiDirty = @(git status --porcelain --untracked-files=all -- src public index.html package.json package-lock.json vite.config.ts tsconfig.json)

    if ($ServerOnly) {
        $entry = '(сайт не меняется)'
    } else {
        if (-not $SkipBuild) {
            if ($uiDirty.Count) { throw "В интерфейсе незакоммиченные правки ($($uiDirty.Count) файлов): они попали бы в dist на проде. Закоммитьте их или выкладывайте только бэкенд (-ServerOnly).`n$($uiDirty -join "`n")" }
            Write-Host '› npm run build'
            # Предупреждения сборщика идут в stderr: в Windows PowerShell 5.1 при 'Stop' это падение, судим по коду выхода.
            $ErrorActionPreference = 'Continue'
            npm run build
            $buildCode = $LASTEXITCODE
            $ErrorActionPreference = 'Stop'
            if ($buildCode -ne 0) { throw 'Сборка упала' }
            Set-Content -LiteralPath dist/.built-from -Value $commit -NoNewline
        } else {
            $builtFrom = if (Test-Path dist/.built-from) { (Get-Content dist/.built-from -Raw).Trim() } else { '' }
            if ($builtFrom -ne $commit) { throw "dist собран не этим скриптом из $commit (клеймо: '$builtFrom'). Соберите заново (без -SkipBuild) или выкладывайте только бэкенд (-ServerOnly)." }
            if ($uiDirty.Count) { throw 'После сборки в интерфейсе появились незакоммиченные правки: dist больше не равен коммиту.' }
        }
        $entry = ((Get-Content dist/index.html -Raw) | Select-String -Pattern 'assets/index-[\w-]+\.js').Matches.Value
        Write-Host "Сборка: $entry (та же должна уйти в Shar OS — scripts/publish-electron.ps1)"
    }

    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    $archive = Join-Path ([IO.Path]::GetTempPath()) "shar-release-$stamp.tgz"
    $plan = @(
        "бэкап → /root/backups/shar-next-before-$Label.$stamp.tgz",
        $(if ($ServerOnly) { "загрузка $([IO.Path]::GetFileName($archive)) → /tmp, раскладка server/docker/compose в $remote (dist не трогается)" } else { "загрузка $([IO.Path]::GetFileName($archive)) → /tmp, раскладка в $remote (dist заменяется целиком, прежний — dist.prev)" }),
        $(if ($ServerOnly) { "$compose build api" } else { "$compose build" }),
        $(if ($Schema) { "$compose run --rm --no-deps api python -m app.migrate --schema-only" } else { 'схема не трогается (нужна — -Schema)' }),
        $(if ($ServerOnly) { "$compose up -d api, ожидание healthy, проверка health" } else { "$compose up -d, ожидание healthy, проверка health и $entry на https://vokrug-sveta.shar-os.ru/" })
    )
    Write-Host "План:`n  - $($plan -join "`n  - ")"
    if (-not $Execute) { Write-Host 'Сухой прогон: на сервере ничего не менялось. Выкладка — с -Execute.'; return }

    # ── архив ──
    $exclude = @('--exclude=server/.venv', '--exclude=server/.env', '--exclude=server/data', '--exclude=server/tests',
                 '--exclude=__pycache__', '--exclude=*.pyc', '--exclude=.pytest_cache', '--exclude=.ruff_cache')
    $parts = if ($ServerOnly) { @('server', 'docker', 'compose.live.yaml') } else { @('dist', 'server', 'docker', 'compose.live.yaml') }
    tar -czf $archive @exclude @parts
    if ($LASTEXITCODE -ne 0) { throw 'Архив не собрался' }

    $conn = Connect-SharServer $CredentialFile
    try {
        if ($PruneDocker) { Invoke-SharServer $conn 'docker builder prune -f | tail -1' | Out-Null }
        $free = [int64]((Invoke-SharServer $conn "df -Pk / | awk 'NR==2{print `$4}'").Output | Select-Object -First 1)
        if ($free -lt 1.5 * 1024 * 1024) { throw "На сервере свободно $([math]::Round($free / 1MB, 2)) ГБ — сборке образов не хватит. Сначала освободить место (docs/RELEASE.md, «Диск»)." }

        Invoke-SharServer $conn "cd $remote && tar -czf /root/backups/shar-next-before-$Label.$stamp.tgz server/app server/migrations server/requirements.txt dist compose.live.yaml docker" | Out-Null
        Send-SharFile $conn $archive '/tmp'
        $name = [IO.Path]::GetFileName($archive)
        Invoke-SharServer $conn (@(
            "set -e; rm -rf /tmp/shar-release && mkdir /tmp/shar-release && tar -xzf /tmp/$name -C /tmp/shar-release",
            $(if ($ServerOnly) { 'true' } else { "cd $remote && rm -rf dist.prev && mv dist dist.prev && mv /tmp/shar-release/dist dist" }),
            "cp -a /tmp/shar-release/server/. server/ && cp -a /tmp/shar-release/docker/. docker/ && cp /tmp/shar-release/compose.live.yaml compose.live.yaml",
            "rm -rf /tmp/shar-release /tmp/$name"
        ) -join ' && ') | Out-Null

        $svc = if ($ServerOnly) { ' api' } else { '' }
        Invoke-SharServer $conn "$compose build$svc" -TimeOut 1800 | Out-Null
        if ($Schema) { Invoke-SharServer $conn "$compose run --rm --no-deps api python -m app.migrate --schema-only" -TimeOut 600 | Out-Null }
        Invoke-SharServer $conn "$compose up -d$svc" -TimeOut 600 | Out-Null
        Invoke-SharServer $conn "for i in `$(seq 1 40); do s=`$($compose ps --format '{{.Health}}' | sort -u | tr '\n' ' '); [ `"`$s`" = 'healthy ' ] && echo healthy && exit 0; sleep 3; done; $compose ps; exit 1" -TimeOut 200 | Out-Null
        $live = Invoke-SharServer $conn "curl -fsS http://127.0.0.1:18101/api/v2/health && echo && curl -fsS https://vokrug-sveta.shar-os.ru/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1"
        if (-not $ServerOnly -and (@($live.Output) -notcontains $entry)) { throw "Сайт отдаёт не ту сборку: ждали $entry" }
        Write-Host "Готово: $commit ($entry). Откат — docs/RELEASE.md, «Откат» (бэкап shar-next-before-$Label.$stamp.tgz$(if (-not $ServerOnly) { ', dist.prev' }))."
    } finally { Disconnect-SharServer $conn }
} finally {
    Pop-Location
    if ($archive -and (Test-Path $archive)) { Remove-Item $archive -Force }
}
