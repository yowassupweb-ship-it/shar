<#
.SYNOPSIS
  Разработка на БОЕВОЙ базе: SSH-туннель к PostgreSQL прода + локальные Redis, API, Vite и (по желанию) Electron.

.DESCRIPTION
  Всё, что делается в таком Шаре, пишется в настоящую базу. Поэтому у локального API выключено всё фоновое
  (миграции, обслуживание, напоминания, наблюдение за почтой) — это делает прод, второй исполнитель дал бы дубли.
  Схема локальным API не меняется: таблицы новых функций появляются только шагом выпуска (docs/RELEASE.md).
  Сессии — в локальном Redis: войти нужно заново.

  Компоненты запускаются в отдельных свёрнутых окнах; закрыть окно — остановить компонент.
    tunnel   127.0.0.1:55432 → прод 127.0.0.1:5432 (пароль SSH — см. scripts/shar-ssh.ps1)
    redis    127.0.0.1:6390
    api      127.0.0.1:8100 (настройки прода из /opt/shar-next/api.prod.env, кладутся в %LOCALAPPDATA%\shar-dev;
             перезапускается сам при правке server/)
    vite     127.0.0.1:3005 (/api → API)
    electron Shar OS из desktop/ с интерфейсом с Vite (горячая перезагрузка), свой профиль %LOCALAPPDATA%\shar-dev\electron
             (иначе single-instance lock столкнётся с установленным Shar OS) и CDP на -DebugPort

  Порты меняются параметрами — когда стандартные заняты, например, локальной тестовой базой на 55432.
  Занятый порт скрипт считает уже поднятым компонентом, поэтому чужое на нём он не заметит.

.EXAMPLE
  ./scripts/dev-prod.ps1 -Electron
.EXAMPLE
  ./scripts/dev-prod.ps1 -Electron -DbPort 55442 -RedisPort 6391 -ApiPort 8110 -VitePort 3015 -DebugPort 9232
#>
[CmdletBinding()]
param(
    [switch]$Electron,
    [string]$CredentialFile = '',
    [int]$DbPort = 55432,
    [int]$RedisPort = 6390,
    [int]$ApiPort = 8100,
    [int]$VitePort = 3005,
    [int]$DebugPort = 9222,
    [ValidateSet('', 'tunnel', 'api', 'vite', 'electron')][string]$Part = ''
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/shar-ssh.ps1"
$root = Split-Path -Parent $PSScriptRoot
$state = Join-Path $env:LOCALAPPDATA 'shar-dev'
$envFile = Join-Path $state 'api.prod.env'

function Wait-Port([int]$Port, [int]$Seconds = 60) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "Порт $Port так и не открылся"
}

function Start-Part([string]$Name) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Part', $Name,
        '-DbPort', $DbPort, '-RedisPort', $RedisPort, '-ApiPort', $ApiPort, '-VitePort', $VitePort, '-DebugPort', $DebugPort)
    if ($CredentialFile) { $argList += @('-CredentialFile', $CredentialFile) }
    Start-Process powershell -ArgumentList $argList -WindowStyle Minimized | Out-Null
}

switch ($Part) {
    'tunnel' {
        $conn = Connect-SharServer $CredentialFile
        try {
            New-SSHLocalPortForward -SessionId $conn.Session.SessionId -BoundHost '127.0.0.1' -BoundPort $DbPort -RemoteAddress '127.0.0.1' -RemotePort 5432 | Out-Null
            Write-Host "Туннель 127.0.0.1:$DbPort → боевой PostgreSQL. Закройте окно, чтобы разорвать."
            while ($conn.Session.Connected) { Start-Sleep -Seconds 5 }
        } finally { Disconnect-SharServer $conn }
        return
    }
    'api' {
        foreach ($line in Get-Content -LiteralPath $envFile) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { Set-Item "Env:$($Matches[1])" $Matches[2].Trim().Trim('"').Trim("'") }
        }
        $data = Join-Path $state 'data'
        New-Item -ItemType Directory -Force -Path $data | Out-Null
        $over = @{
            DB_HOST = '127.0.0.1'; DB_PORT = "$DbPort"; REDIS_URL = "redis://127.0.0.1:$RedisPort/0"
            SHAR_V2_HOST = '127.0.0.1'; SHAR_V2_PORT = "$ApiPort"; SHAR_V2_RELOAD = '1'
            SHAR_DATA_DIR = $data; SHAR_UPLOADS_DIR = (Join-Path $data 'uploads')
            SHAR_COOKIE_SECURE = '0'; SHAR_ENFORCE_AUTH = '1'; SHAR_LEGACY_ADOPT = '0'
            SHAR_AUTO_MIGRATE = '0'; SHAR_STARTUP_MAINTENANCE = '0'; SHAR_SCHEDULED_JOBS = '0'; SHAR_MAIL_WATCH = '0'
        }
        foreach ($k in $over.Keys) { Set-Item "Env:$k" $over[$k] }
        Set-Location (Join-Path $root 'server')
        & .\.venv\Scripts\python.exe -m app
        return
    }
    'vite' {
        Set-Location $root
        # 127.0.0.1, не localhost: на Windows localhost уходит в IPv6, и сокет рвётся.
        $env:SHAR_API_TARGET = "http://127.0.0.1:$ApiPort"
        npx vite --host 127.0.0.1 --port $VitePort --strictPort
        return
    }
    'electron' {
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue  # VS Code ставит его своим процессам
        $env:SHAR_DEV_URL = "http://127.0.0.1:$VitePort"; $env:SHAR_BACKEND_URL = "http://127.0.0.1:$VitePort"
        Set-Location (Join-Path $root 'desktop')
        npx electron electron/main.cjs "--user-data-dir=$(Join-Path $state 'electron')" "--remote-debugging-port=$DebugPort"
        return
    }
}

# ── всё вместе ──
New-Item -ItemType Directory -Force -Path $state | Out-Null
Write-Host '› настройки прода (api.prod.env)'
$conn = Connect-SharServer $CredentialFile
try {
    $r = Invoke-SSHCommand -SessionId $conn.Session.SessionId -Command 'cat /opt/shar-next/api.prod.env'
    if ($r.ExitStatus -ne 0) { throw 'Не прочитали api.prod.env' }
    Set-Content -LiteralPath $envFile -Value ($r.Output -join "`n") -Encoding utf8
} finally { Disconnect-SharServer $conn }

if (-not (Get-NetTCPConnection -State Listen -LocalPort $DbPort -ErrorAction SilentlyContinue)) { Write-Host '› туннель'; Start-Part tunnel; Wait-Port $DbPort }
if (-not (Get-NetTCPConnection -State Listen -LocalPort $RedisPort -ErrorAction SilentlyContinue)) {
    Write-Host "› redis :$RedisPort"
    $redis = (Get-Command redis-server -ErrorAction SilentlyContinue).Source
    if (-not $redis) { $redis = Get-ChildItem "$env:LOCALAPPDATA\Programs\Redis for Windows", "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter redis-server.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
    if (-not $redis) { throw 'Нет redis-server: winget install taizod1024.redis-windows-fork' }
    Start-Process $redis -ArgumentList '--port', "$RedisPort", '--bind', '127.0.0.1', '--save', '""', '--appendonly', 'no' -WindowStyle Minimized | Out-Null
    Wait-Port $RedisPort
}
if (-not (Get-NetTCPConnection -State Listen -LocalPort $ApiPort -ErrorAction SilentlyContinue)) { Write-Host "› API :$ApiPort"; Start-Part api; Wait-Port $ApiPort 90 }
if (-not (Get-NetTCPConnection -State Listen -LocalPort $VitePort -ErrorAction SilentlyContinue)) { Write-Host "› Vite :$VitePort"; Start-Part vite; Wait-Port $VitePort }
$health = Invoke-RestMethod "http://127.0.0.1:$VitePort/api/v2/health" -TimeoutSec 15
Write-Host "Готово: http://127.0.0.1:$VitePort — база $($health.db), redis $($health.redis). ВНИМАНИЕ: база боевая."
if ($Electron) { Write-Host '› Electron'; Start-Part electron }
