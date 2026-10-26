[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CredentialFile,
    [string]$ServerHost = '81.90.31.129',
    [string]$ServerUser = 'root',
    [int]$LocalPort = 18080,
    [string]$RemoteAddress = '127.0.0.1',
    [int]$RemotePort = 18080
)

$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH -ErrorAction Stop

$passwordLine = Get-Content -LiteralPath $CredentialFile |
    Where-Object { $_ -match '^SSH_PASSWORD=' } |
    Select-Object -First 1
if (-not $passwordLine) {
    throw 'SSH_PASSWORD is missing from the credential file.'
}

$plainPassword = $passwordLine.Substring($passwordLine.IndexOf('=') + 1).Trim()
$credential = [pscredential]::new(
    $ServerUser,
    (ConvertTo-SecureString $plainPassword -AsPlainText -Force)
)
$plainPassword = $null

$session = $null
try {
    $sessionParams = @{
        ComputerName = $ServerHost
        Credential = $credential
        AcceptKey = $true
        Force = $true
        WarningAction = 'SilentlyContinue'
    }
    $session = New-SSHSession @sessionParams
    if (-not $session.Connected) {
        throw 'SSH connection failed.'
    }

    $forwardParams = @{
        SessionId = $session.SessionId
        BoundHost = '127.0.0.1'
        BoundPort = $LocalPort
        RemoteAddress = $RemoteAddress
        RemotePort = $RemotePort
    }
    New-SSHLocalPortForward @forwardParams | Out-Null

    while ($session.Connected) {
        Start-Sleep -Seconds 5
    }
}
finally {
    if ($session) {
        Remove-SSHSession -SessionId $session.SessionId -WarningAction SilentlyContinue | Out-Null
    }
}
