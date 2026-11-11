<#
.SYNOPSIS
    Runs every 5 minutes (scheduled task, as SYSTEM) and restarts the XLChess worker if it stopped or hung.
    Layer 3 of the restart design (docs/installer-v1-plan.md section 7). Writes to logs\watchdog.log only when it acts.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

foreach ($m in 'Common', 'Power', 'Download', 'Service') {
    Import-Module (Join-Path $PSScriptRoot "lib\$m.psm1") -DisableNameChecking
}
$Paths = Resolve-InstallPaths -ScriptRoot $PSScriptRoot
$logFile = Join-Path $Paths.Logs 'watchdog.log'
if ((Test-Path -LiteralPath $logFile) -and ((Get-Item -LiteralPath $logFile).Length -gt 1MB)) {
    Move-Item -LiteralPath $logFile -Destination ($logFile + '.old') -Force
}
Initialize-Log -Path $logFile

try {
    $svc = Get-WorkerService
    $status = $(if ($svc) { $svc.Status.ToString() } else { 'Missing' })
    $age = Get-HealthAgeSeconds -Paths $Paths
    $uptime = $(if ($status -eq 'Running') { Get-ServiceUptimeSeconds } else { 0 })
    $decision = Get-WatchdogDecision -ServiceStatus $status -HealthAgeSeconds $age -UptimeSeconds $uptime

    switch ($decision.Action) {
        'start' {
            Write-Log -Level Warn -Message "Starting the worker: $($decision.Reason)"
            Stop-WorkerProcesses -Paths $Paths
            Start-WorkerService -Paths $Paths
        }
        'restart' {
            Write-Log -Level Warn -Message "Restarting the worker: $($decision.Reason)"
            Stop-WorkerService -Paths $Paths
            Start-WorkerService -Paths $Paths
        }
    }
} catch {
    Write-Log -Level Error -Message "Watchdog error: $($_.Exception.Message)"
    exit 1
}
