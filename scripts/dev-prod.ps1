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
    api      127.0.0.1:8100 (настройки прода из /opt/shar-next/api.prod.env, кладутся в %LOCALAPPDATA%\shar-dev)
    vite     127.0.0.1:3005 (/api → :8100)
    electron Shar OS из desktop/ с интерфейсом с Vite (горячая перезагрузка)

.EXAMPLE
  ./scripts/dev-prod.ps1 -Electron
#>
[CmdletBinding()]
param(
    [switch]$Electron,
    [string]$CredentialFile = '',
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
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Part', $Name)
    if ($CredentialFile) { $argList += @('-CredentialFile', $CredentialFile) }
    Start-Process powershell -ArgumentList $argList -WindowStyle Minimized | Out-Null
}

switch ($Part) {
    'tunnel' {
        $conn = Connect-SharServer $CredentialFile
        try {
            New-SSHLocalPortForward -SessionId $conn.Session.SessionId -BoundHost '127.0.0.1' -BoundPort 55432 -RemoteAddress '127.0.0.1' -RemotePort 5432 | Out-Null
            Write-Host 'Туннель 127.0.0.1:55432 → боевой PostgreSQL. Закройте окно, чтобы разорвать.'
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
            DB_HOST = '127.0.0.1'; DB_PORT = '55432'; REDIS_URL = 'redis://127.0.0.1:6390/0'
            SHAR_V2_HOST = '127.0.0.1'; SHAR_V2_PORT = '8100'; SHAR_DATA_DIR = $data; SHAR_UPLOADS_DIR = (Join-Path $data 'uploads')
            SHAR_COOKIE_SECURE = '0'; SHAR_ENFORCE_AUTH = '1'; SHAR_LEGACY_ADOPT = '0'
            SHAR_AUTO_MIGRATE = '0'; SHAR_STARTUP_MAINTENANCE = '0'; SHAR_SCHEDULED_JOBS = '0'; SHAR_MAIL_WATCH = '0'
        }
        foreach ($k in $over.Keys) { Set-Item "Env:$k" $over[$k] }
        Set-Location (Join-Path $root 'server')
        & .\.venv\Scripts\python.exe -m app
        return
    }
    'vite' { Set-Location $root; npx vite --host 127.0.0.1 --port 3005 --strictPort; return }
    'electron' {
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue  # VS Code ставит его своим процессам
        $env:SHAR_DEV_URL = 'http://127.0.0.1:3005'; $env:SHAR_BACKEND_URL = 'http://127.0.0.1:3005'
        Set-Location (Join-Path $root 'desktop'); npx electron electron/main.cjs
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

if (-not (Get-NetTCPConnection -State Listen -LocalPort 55432 -ErrorAction SilentlyContinue)) { Write-Host '› туннель'; Start-Part tunnel; Wait-Port 55432 }
if (-not (Get-NetTCPConnection -State Listen -LocalPort 6390 -ErrorAction SilentlyContinue)) {
    Write-Host '› redis :6390'
    $redis = (Get-Command redis-server -ErrorAction SilentlyContinue).Source
    if (-not $redis) { $redis = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter redis-server.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
    if (-not $redis) { throw 'Нет redis-server: winget install taizod1024.redis-windows-fork' }
    Start-Process $redis -ArgumentList '--port', '6390', '--bind', '127.0.0.1', '--save', '""', '--appendonly', 'no' -WindowStyle Minimized | Out-Null
    Wait-Port 6390
}
if (-not (Get-NetTCPConnection -State Listen -LocalPort 8100 -ErrorAction SilentlyContinue)) { Write-Host '› API :8100'; Start-Part api; Wait-Port 8100 90 }
if (-not (Get-NetTCPConnection -State Listen -LocalPort 3005 -ErrorAction SilentlyContinue)) { Write-Host '› Vite :3005'; Start-Part vite; Wait-Port 3005 }
$health = Invoke-RestMethod http://127.0.0.1:3005/api/v2/health -TimeoutSec 15
Write-Host "Готово: http://127.0.0.1:3005 — база $($health.db), redis $($health.redis). ВНИМАНИЕ: база боевая."
if ($Electron) { Write-Host '› Electron'; Start-Part electron }
