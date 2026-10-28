<#
.SYNOPSIS
  Сборка и публикация Shar OS (Electron) в https://vokrug-sveta.shar-os.ru/updates.

.DESCRIPTION
  Правила (docs/RELEASE.md):
    - одна сборка везде: в установщик идёт ../dist, который уже отдаёт сайт (сверяется index-*.js);
    - версия в desktop/package.json выше опубликованной (поднять: cd desktop; npm version patch --no-git-tag-version; закоммитить);
    - latest.yml — последним и атомарно (загрузка во временный файл + mv): старые клиенты остаются на рабочей версии,
      пока новая не легла целиком.
  Без -Execute — сухой прогон: проверки и план.

.EXAMPLE
  ./scripts/publish-electron.ps1                  # проверки и план
  ./scripts/publish-electron.ps1 -Execute         # собрать и опубликовать
  ./scripts/publish-electron.ps1 -Execute -PruneOld   # и убрать старые пакеты, оставив 3 последних
#>
[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$SkipBuild,
    [switch]$PruneOld,
    [switch]$AllowDifferentBuild,
    [string]$CredentialFile = ''
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/shar-ssh.ps1"
$root = Split-Path -Parent $PSScriptRoot
$updates = '/var/www/shar/updates'
$public = 'https://vokrug-sveta.shar-os.ru'

function Get-Entry([string]$html) { ($html | Select-String -Pattern 'assets/index-[\w-]+\.js').Matches.Value }
# latest.yml сервер отдаёт как поток байт, страницу — текстом: приводим к строке.
function Get-Text([string]$url) {
    $content = (Invoke-WebRequest $url -UseBasicParsing).Content
    if ($content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($content) } else { [string]$content }
}

$version = (Get-Content (Join-Path $root 'desktop/package.json') -Raw | ConvertFrom-Json).version
$published = (((Get-Text "$public/updates/latest.yml") -split "`n" | Where-Object { $_ -match '^version:' } | Select-Object -First 1) -replace '^version:\s*', '').Trim()
Write-Host "Shar OS: в репозитории $version, опубликована $published"
if ([version]$version -le [version]$published) { throw "Версия $version не выше опубликованной: cd desktop; npm version patch --no-git-tag-version; закоммитить." }

$local = Get-Entry (Get-Content (Join-Path $root 'dist/index.html') -Raw)
$live = Get-Entry (Get-Text "$public/")
Write-Host "Сборка: локальная $local, на сайте $live"
if ($local -ne $live -and -not $AllowDifferentBuild) { throw 'В установщик должна идти та же сборка, что на сайте: сначала выложите сайт (deploy-server.ps1) или соберите dist из того же коммита.' }

$release = Join-Path $root 'desktop/release/nsis-web'
$exe = "Shar setup-$version.exe"
$pkg = "shar-os-client-$version-x64.nsis.7z"
Write-Host "План:`n  - npm run build:win (web/ — копия dist)`n  - бэкап latest.yml и Shar setup.exe в /root/backups/*.before-$version`n  - загрузка $pkg, $exe; Shar setup.exe = $exe`n  - latest.yml — последним (tmp + mv)$(if ($PruneOld) { "`n  - удалить пакеты и установщики старше трёх последних версий" })"
if (-not $Execute) { Write-Host 'Сухой прогон: ничего не собиралось и не публиковалось. Публикация — с -Execute.'; return }

if (-not $SkipBuild) {
    Push-Location (Join-Path $root 'desktop')
    try { $ErrorActionPreference = 'Continue'; npm run build:win; $code = $LASTEXITCODE; $ErrorActionPreference = 'Stop'; if ($code -ne 0) { throw 'Сборка установщика упала' } } finally { Pop-Location }
}
foreach ($f in @($exe, $pkg, 'latest.yml')) { if (-not (Test-Path (Join-Path $release $f))) { throw "Нет $release/$f" } }

$conn = Connect-SharServer $CredentialFile
try {
    Invoke-SharServer $conn "cp $updates/latest.yml /root/backups/latest.yml.before-$version && cp '$updates/Shar setup.exe' /root/backups/Shar-setup.exe.before-$version" | Out-Null
    Send-SharFile $conn (Join-Path $release $pkg) $updates
    Send-SharFile $conn (Join-Path $release $exe) $updates
    Invoke-SharServer $conn "cd $updates && cp '$exe' 'Shar setup.exe.tmp' && mv 'Shar setup.exe.tmp' 'Shar setup.exe'" | Out-Null
    $tmp = Join-Path ([IO.Path]::GetTempPath()) 'latest.yml.tmp'
    Copy-Item (Join-Path $release 'latest.yml') $tmp -Force
    Send-SharFile $conn $tmp $updates
    Invoke-SharServer $conn "cd $updates && mv latest.yml.tmp latest.yml && chmod 644 latest.yml '$exe' '$pkg' 'Shar setup.exe'" | Out-Null
    if ($PruneOld) {
        Invoke-SharServer $conn "cd $updates && ls -t shar-os-client-*-x64.nsis.7z | tail -n +4 | xargs -r rm -v && ls -t 'Shar setup-'*.exe | tail -n +4 | xargs -r -d '\n' rm -v" | Out-Null
    }
} finally { Disconnect-SharServer $conn }

$check = Get-Text "$public/updates/latest.yml"
if ($check -notmatch "version: $([regex]::Escape($version))") { throw 'latest.yml на сервере не новый — проверить вручную' }
Invoke-WebRequest "$public/updates/$pkg" -Method Head -UseBasicParsing | Out-Null
Write-Host "Опубликована Shar OS $version ($local). Клиенты подхватят обновление при следующей проверке."
