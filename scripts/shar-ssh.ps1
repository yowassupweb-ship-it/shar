# Общее для скриптов выпуска: SSH к прод-серверу через Posh-SSH (Install-Module Posh-SSH -Scope CurrentUser).
#
# Пароль root лежит в файле ВНЕ репозитория строкой SSH_PASSWORD=... Где файл:
#   параметр -CredentialFile скрипта, иначе $env:SHAR_SSH_CREDENTIALS, иначе ~/.shar/ssh.env.
# Подключать: . "$PSScriptRoot/shar-ssh.ps1"

$script:SharHost = '81.90.31.129'
$script:SharUser = 'root'

function Resolve-SharCredentialFile([string]$Path) {
    foreach ($candidate in @($Path, $env:SHAR_SSH_CREDENTIALS, (Join-Path $HOME '.shar/ssh.env'))) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    throw 'Нет файла с SSH_PASSWORD: укажите -CredentialFile или $env:SHAR_SSH_CREDENTIALS (см. docs/RELEASE.md).'
}

function Connect-SharServer([string]$CredentialFile) {
    Import-Module Posh-SSH -ErrorAction Stop
    $file = Resolve-SharCredentialFile $CredentialFile
    $line = Get-Content -LiteralPath $file | Where-Object { $_ -match '^SSH_PASSWORD=' } | Select-Object -First 1
    if (-not $line) { throw "В $file нет строки SSH_PASSWORD=" }
    $cred = [pscredential]::new($script:SharUser, (ConvertTo-SecureString $line.Substring($line.IndexOf('=') + 1).Trim() -AsPlainText -Force))
    $session = New-SSHSession -ComputerName $script:SharHost -Credential $cred -AcceptKey -Force -WarningAction SilentlyContinue
    if (-not $session.Connected) { throw 'SSH: не подключились' }
    [pscustomobject]@{ Session = $session; Credential = $cred }
}

function Invoke-SharServer($Conn, [string]$Command, [int]$TimeOut = 600, [switch]$AllowFail) {
    $r = Invoke-SSHCommand -SessionId $Conn.Session.SessionId -Command $Command -TimeOut $TimeOut
    if ($r.Output) { $r.Output | ForEach-Object { Write-Host "  $_" } }
    if ($r.ExitStatus -ne 0 -and -not $AllowFail) { throw "На сервере упало (код $($r.ExitStatus)): $Command`n$($r.Error)" }
    $r
}

function Send-SharFile($Conn, [string]$LocalPath, [string]$RemoteDir) {
    Set-SCPItem -ComputerName $script:SharHost -Credential $Conn.Credential -Path $LocalPath -Destination $RemoteDir -AcceptKey -Force -WarningAction SilentlyContinue
}

function Disconnect-SharServer($Conn) {
    if ($Conn) { Remove-SSHSession -SessionId $Conn.Session.SessionId -WarningAction SilentlyContinue | Out-Null }
}
