<#
.SYNOPSIS
    Removes the XLChess worker from this PC.

.PARAMETER RemoveData
    Also delete the data folder, including the downloaded models (about 30 GB). Without this switch the script
    asks; the default answer keeps the models so a reinstall does not download them again.
.PARAMETER Yes
    Do not ask for confirmation. Models are kept unless -RemoveData is also given.
#>
[CmdletBinding()]
param(
    [switch]$RemoveData,
    [switch]$Yes
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

foreach ($m in 'Common', 'Power', 'Download', 'Service') {
    Import-Module (Join-Path $PSScriptRoot "lib\$m.psm1") -Force -DisableNameChecking
}
$Paths = Resolve-InstallPaths -ScriptRoot $PSScriptRoot

if (-not (Test-IsAdmin)) {
    Write-Host 'Run this as administrator.' -ForegroundColor Red
    exit 1
}
function Confirm-Action {
    param([string]$Question, [bool]$Default = $false)
    if ($Yes) { return $Default }
    $suffix = $(if ($Default) { '[Y/n]' } else { '[y/N]' })
    $a = Read-Host "$Question $suffix"
    if (-not $a) { return $Default }
    $a -match '^(y|yes)$'
}

Write-Host ''
Write-Host 'This removes the XLChess worker service, watchdog, firewall rules and program files.' -ForegroundColor Cyan
if (-not $Yes -and -not (Confirm-Action 'Continue?')) { Write-Host 'Cancelled.'; exit 3 }
$dropData = $RemoveData
if (-not $RemoveData) { $dropData = Confirm-Action "Also delete the downloaded models in $($Paths.Data)? Keeping them makes a reinstall much faster." $false }

# Run from a neutral folder: this script itself lives in the folder being removed.
Set-Location -LiteralPath $env:SystemRoot
try {
    Write-Host '- stopping the service'
    Stop-WorkerService -Paths $Paths
    $svc = Get-WorkerService
    if ($svc -and (Test-Path -LiteralPath $Paths.WinswExe)) { & $Paths.WinswExe uninstall 2>&1 | Out-Null }
    elseif ($svc) { & sc.exe delete (Get-ServiceName) | Out-Null }
    Write-Host '- removing the watchdog, firewall rules and shortcuts'
    Remove-WatchdogTask
    Remove-FirewallRules
    Remove-Shortcuts
    Write-Host '- restoring power settings'
    if (Restore-AcSleep -BackupPath $Paths.PowerBackup) { Write-Host '  sleep settings restored' } else { Write-Host '  nothing to restore' }

    Write-Host '- removing program files'
    Start-Sleep -Seconds 2
    if (Test-Path -LiteralPath $Paths.Program) { Remove-Item -LiteralPath $Paths.Program -Recurse -Force }

    if ($dropData) {
        Write-Host '- removing data and models'
        if (Test-Path -LiteralPath $Paths.Data) { Remove-Item -LiteralPath $Paths.Data -Recurse -Force }
    } else {
        Write-Host '- keeping models; removing the device token and runtime state'
        if (Test-Path -LiteralPath $Paths.Secrets) { Remove-Item -LiteralPath $Paths.Secrets -Recurse -Force }
        foreach ($f in $Paths.Health, $Paths.PowerBackup) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
    }
    Write-Host ''
    Write-Host 'Uninstalled.' -ForegroundColor Green
    Write-Host 'Also revoke this worker in the XLChess admin screen so its device token stops working.'
    exit 0
} catch {
    Write-Host "Uninstall stopped: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Close anything using the worker folders and run it again.'
    exit 1
}
