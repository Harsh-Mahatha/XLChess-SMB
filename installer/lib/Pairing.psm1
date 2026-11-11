# Pairing: exchange the owner's short-lived code for a device token and store it encrypted
# (docs/installer-v1-plan.md step 12). Windows PowerShell 5.1 compatible. Keep this file ASCII-only.

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'Common.psm1')

function Protect-DeviceToken {
    <# Encrypts with DPAPI (machine scope, so the service account can read it) and returns base64 text. #>
    param([Parameter(Mandatory)][string]$Token)
    Add-Type -AssemblyName System.Security
    $bytes = [Text.Encoding]::UTF8.GetBytes($Token)
    $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    [Convert]::ToBase64String($protected)
}

function Unprotect-DeviceToken {
    param([Parameter(Mandatory)][string]$Base64)
    Add-Type -AssemblyName System.Security
    $bytes = [Convert]::FromBase64String($Base64.Trim())
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    [Text.Encoding]::UTF8.GetString($plain)
}

function Save-DeviceToken {
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][string]$Token)
    $dir = Split-Path -Parent $Paths.TokenFile
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = "$($Paths.TokenFile).tmp"
    [IO.File]::WriteAllText($tmp, (Protect-DeviceToken -Token $Token), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $Paths.TokenFile -Force
}

function Test-DeviceTokenPresent {
    param([Parameter(Mandatory)]$Paths)
    (Test-Path -LiteralPath $Paths.TokenFile) -and ((Get-Item -LiteralPath $Paths.TokenFile).Length -gt 0)
}

function Get-PairingAdvice {
    <# Turns the worker's error code into one sentence the owner can act on. #>
    param([string]$Code, [string]$Message)
    switch ($Code) {
        'pairing_code_invalid' { 'That pairing code was not recognised. Check it was typed exactly as shown.' }
        'pairing_code_expired' { 'That pairing code has expired (codes last 10 minutes). Ask the XLChess admin for a new one.' }
        'pairing_code_used'    { 'That pairing code was already used. Ask the XLChess admin for a new one.' }
        'network'              { 'The SMB API could not be reached. Check the internet connection and the API address.' }
        'no_api_url'           { 'No SMB API address is set. Run the installer with -ApiUrl https://<smb-api-host>.' }
        default                { "Pairing failed: $Message" }
    }
}

function Test-PairingCodeRetryable {
    param([string]$Code)
    $Code -in @('pairing_code_invalid', 'pairing_code_expired', 'pairing_code_used')
}

function ConvertFrom-PairingOutput {
    <# The worker prints log lines and then one JSON result line; take the last line that looks like the result. #>
    param($Output)
    $line = @($Output | ForEach-Object { [string]$_ } | Where-Object { $_.TrimStart().StartsWith('{"ok"') }) | Select-Object -Last 1
    if (-not $line) { return $null }
    $line | ConvertFrom-Json
}

function Invoke-WorkerPairing {
    <#
    .SYNOPSIS Asks for a pairing code, pairs, and stores the device token. Returns the worker id.
    .PARAMETER PairingCode a code given on the command line (the first attempt); later attempts ask the owner.
    .PARAMETER ReadCode scriptblock that asks the owner for a code (replaced in tests).
    #>
    param(
        [Parameter(Mandatory)]$Paths,
        [string]$PairingCode,
        [int]$MaxAttempts = 3,
        [scriptblock]$ReadCode = { Read-Host 'Enter the pairing code shown in XLChess' }
    )
    $code = $PairingCode
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        if (-not $code) { $code = & $ReadCode }
        $code = ([string]$code).Trim()
        if (-not $code) { Write-Log -Level Warn -Message 'No code entered.'; continue }

        $out = $code | & $Paths.NodeExe $Paths.WorkerJs --pair --config $Paths.Config 2>&1
        $code = $null
        $result = ConvertFrom-PairingOutput -Output $out
        if (-not $result) {
            throw "The worker gave no pairing result. Last output: $(@($out) | Select-Object -Last 3)"
        }
        if ($result.ok) {
            Save-DeviceToken -Paths $Paths -Token $result.deviceToken
            Write-Log -Level Ok -Message "Paired. Worker id: $($result.workerId)."
            return [string]$result.workerId
        }
        $errCode = $(if ($result.PSObject.Properties['error']) { [string]$result.error } else { 'unknown' })
        $msg = $(if ($result.PSObject.Properties['message']) { [string]$result.message } else { '' })
        Write-Log -Level Warn -Message (Get-PairingAdvice -Code $errCode -Message $msg)
        if (-not (Test-PairingCodeRetryable -Code $errCode)) { throw (Get-PairingAdvice -Code $errCode -Message $msg) }
    }
    throw "Pairing did not succeed after $MaxAttempts tries. Ask the XLChess admin for a new code and run: repair-xlchess-worker.ps1 -NewPairing"
}

Export-ModuleMember -Function Protect-DeviceToken, Unprotect-DeviceToken, Save-DeviceToken, Test-DeviceTokenPresent,
    Get-PairingAdvice, Test-PairingCodeRetryable, ConvertFrom-PairingOutput, Invoke-WorkerPairing
