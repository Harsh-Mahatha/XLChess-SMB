<#
.SYNOPSIS
    Gets a stopped or broken XLChess worker running again. Layer 4 of the restart design (the manual fallback).

.PARAMETER Restart
    Stop the worker and everything it started, start it again and wait until it reports healthy.
.PARAMETER Verify
    Run the full setup again with no questions. Setup is safe to repeat: it re-checks every file against
    the pinned checksums, downloads anything missing or damaged, and repeats the GPU test.
.PARAMETER Repair
    Register the service, watchdog, firewall rules and shortcuts again, then restart.
#>
[CmdletBinding()]
param(
    [switch]$Restart,
    [switch]$Verify,
    [switch]$Repair
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

foreach ($m in 'Common', 'Power', 'Download', 'Service') {
    Import-Module (Join-Path $PSScriptRoot "lib\$m.psm1") -Force -DisableNameChecking
}
$Paths = Resolve-InstallPaths -ScriptRoot $PSScriptRoot
$Manifest = Get-Manifest -Path (Join-Path $PSScriptRoot 'manifest.json')
Initialize-Log -Path (Join-Path $Paths.Logs ("repair-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss')))

if (-not (Test-IsAdmin)) {
    Write-Log -Level Error -Message 'Run this as administrator (use the "Restart XLChess Worker" Start menu shortcut).'
    exit 1
}
if (-not ($Restart -or $Verify -or $Repair)) {
    Write-Host 'Choose one: -Restart (start it again), -Repair (re-register everything), -Verify (check all files).'
    exit 2
}

function Invoke-RestartAndCheck {
    Write-Log -Level Step -Message 'Restarting the worker'
    if (-not (Get-WorkerService)) {
        throw 'The worker service is not installed. Run install.cmd to set it up.'
    }
    $before = Get-Date
    Stop-WorkerService -Paths $Paths
    Start-WorkerService -Paths $Paths
    Write-Log -Message 'Waiting for the worker to report healthy (up to 2 minutes)...'
    $h = Wait-WorkerHealthy -Paths $Paths -Since $before -TimeoutSeconds 120
    if (-not $h) {
        Write-Log -Level Error -Message 'The service started but the worker did not report healthy.'
        Write-Log -Message "Look at the logs in $($Paths.Logs), or run the 'XLChess Worker Status' shortcut."
        return $false
    }
    $gpuText = $(if ($h.gpu) { "$($h.gpu.name), $($h.gpu.usedMiB) of $($h.gpu.totalMiB) MiB in use" } else { 'no GPU reported' })
    Write-Log -Level Ok -Message "Worker running (version $($h.version)). Ollama: $(if ($h.ollamaUp) { 'up' } else { 'down' }). GPU: $gpuText."
    $true
}

try {
    if ($Verify) {
        Write-Log -Level Step -Message 'Verifying the installation (running setup again)'
        & (Join-Path $PSScriptRoot 'setup-xlchess-worker.ps1') -Yes -DataPath $Paths.Data -ProgramPath $Paths.Program
        exit $LASTEXITCODE
    }
    if ($Repair) {
        Write-Log -Level Step -Message 'Registering the service, watchdog, firewall rules and shortcuts again'
        Stop-WorkerService -Paths $Paths
        Install-ManagementScripts -Paths $Paths -InstallerRoot $PSScriptRoot
        Install-WorkerService -Manifest $Manifest -Paths $Paths
        Register-WatchdogTask -Paths $Paths
        Register-FirewallRules -Manifest $Manifest
        Register-Shortcuts -Paths $Paths
    }
    if ($Restart -or $Repair) {
        if (-not (Invoke-RestartAndCheck)) { exit 1 }
    }
    exit 0
} catch {
    Write-Log -Level Error -Message $_.Exception.Message
    exit 1
}
