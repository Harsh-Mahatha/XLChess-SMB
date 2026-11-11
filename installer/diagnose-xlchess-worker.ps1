<#
.SYNOPSIS
    Shows whether the XLChess worker is healthy and saves a support bundle (a zip with a report and recent logs).
    Secrets are never included: the device token file is not collected and token/code values are masked.

.PARAMETER NoBundle
    Only print the report; do not create the zip.
#>
[CmdletBinding()]
param([switch]$NoBundle)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Continue'

foreach ($m in 'Common', 'Power', 'Download', 'Runtimes', 'Service') {
    Import-Module (Join-Path $PSScriptRoot "lib\$m.psm1") -Force -DisableNameChecking
}
$Paths = Resolve-InstallPaths -ScriptRoot $PSScriptRoot
$Manifest = Get-Manifest -Path (Join-Path $PSScriptRoot 'manifest.json')

$report = New-Object System.Collections.ArrayList
$problems = 0
function Add-Line { param([string]$Text) [void]$report.Add($Text) }
function Add-Check {
    param([string]$Name, [ValidateSet('OK', 'WARN', 'FAIL')][string]$Status, [string]$Detail)
    if ($Status -eq 'FAIL') { $script:problems++ }
    $color = switch ($Status) { 'OK' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
    $line = ('{0,-6} {1,-22} {2}' -f $Status, $Name, $Detail)
    Write-Host $line -ForegroundColor $color
    Add-Line $line
}
function Hide-Secrets {
    param([string]$Text)
    $Text -replace '(?i)((?:token|pairing[\s_-]*code|authorization|secret|password)["'']?\s*[:=]\s*["'']?)[^\s"'',;]+', '$1[hidden]'
}

Write-Host ''
Write-Host 'XLChess worker status' -ForegroundColor Cyan
Add-Line "XLChess worker diagnostics, $(Get-Date -Format s)"

# service
$svc = Get-WorkerService
if (-not $svc) { Add-Check 'Service' 'FAIL' 'Not installed. Run install.cmd.' }
elseif ($svc.Status -eq 'Running') { Add-Check 'Service' 'OK' "Running ($($svc.StartType))" }
else { Add-Check 'Service' 'FAIL' "$($svc.Status). Use the 'Restart XLChess Worker' shortcut." }

# worker heartbeat
$age = Get-HealthAgeSeconds -Paths $Paths
if ($null -eq $age) { Add-Check 'Worker heartbeat' 'FAIL' 'No health.json yet.' }
elseif ($age -gt 180) { Add-Check 'Worker heartbeat' 'FAIL' "Last seen $([int]$age) seconds ago (the worker looks hung)." }
else {
    $h = Read-JsonFile -Path $Paths.Health
    Add-Check 'Worker heartbeat' 'OK' "$([int]$age)s ago, version $($h.version), text model $($h.models.llm), image model $($h.models.image)"
    if ($h.gpu) { Add-Check 'GPU' 'OK' "$($h.gpu.name), $($h.gpu.usedMiB) of $($h.gpu.totalMiB) MiB in use" }
    else { Add-Check 'GPU' 'FAIL' 'The worker cannot see the GPU (nvidia-smi).' }
    Add-Check 'Ollama' $(if ($h.ollamaUp) { 'OK' } else { 'FAIL' }) $(if ($h.ollamaUp) { 'Answering on localhost' } else { 'Not answering' })
}

# watchdog
$task = Get-ScheduledTask -TaskName (Get-WatchdogTaskName) -ErrorAction SilentlyContinue
if ($task) { Add-Check 'Watchdog' 'OK' "Task is $($task.State)" } else { Add-Check 'Watchdog' 'WARN' 'The watchdog task is missing. Run repair -Repair.' }

# files and models
Add-Check 'Text model' $(if (Test-OllamaModelPresent -Manifest $Manifest -Paths $Paths) { 'OK' } else { 'FAIL' }) $Manifest.models.llm.name
$missing = @($Manifest.models.image.files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Paths.Comfy ($_.dest -replace '/', '\'))) })
Add-Check 'Image model' $(if ($missing.Count -eq 0) { 'OK' } else { 'FAIL' }) $(if ($missing.Count -eq 0) { $Manifest.models.image.name } else { "Missing: $(($missing | ForEach-Object { $_.role }) -join ', ')" })

# power, ports, disk, firewall
$power = Get-AcPowerSettings
Add-Check 'Power (sleep on AC)' $(if (Test-AcSleepDisabled -Settings $power) { 'OK' } else { 'WARN' }) "sleep after $($power.SleepAfter)s, hibernate after $($power.HibernateAfter)s (0 = never)"
$fw = @(Get-NetFirewallRule -Group 'XLChess Worker' -ErrorAction SilentlyContinue)
Add-Check 'Firewall' $(if ($fw.Count -ge 2) { 'OK' } else { 'WARN' }) "$($fw.Count) block rule(s) for the model ports"
$free = (New-Object IO.DriveInfo ($Paths.Data.Substring(0, 1))).AvailableFreeSpace
Add-Check 'Free disk space' $(if ($free -gt 10GB) { 'OK' } else { 'WARN' }) "$(Format-Bytes $free) on $($Paths.Data.Substring(0, 3))"

# versions
Add-Line ''
Add-Line "Versions: installer $($Manifest.installerVersion), ollama $($Manifest.components.ollama.version), comfyui $($Manifest.components.comfyui.version), node $($Manifest.components.node.version)"
$state = $(if (Test-Path -LiteralPath $Paths.InstallState) { Get-InstallState -Paths $Paths } else { $null })
if ($state) { Add-Line "Installed steps: $((($state.steps.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value.status)" }) -join ', '))" }

Write-Host ''
if ($problems -eq 0) { Write-Host 'Everything looks fine.' -ForegroundColor Green }
else { Write-Host "$problems problem(s) found. Use the 'Restart XLChess Worker' shortcut, or send the report below to support." -ForegroundColor Yellow }

if (-not $NoBundle) {
    $outDir = Join-Path $Paths.Data 'diagnostics'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $work = Join-Path $outDir "bundle-$stamp"
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $report | Set-Content -LiteralPath (Join-Path $work 'report.txt') -Encoding UTF8
    if (Test-Path -LiteralPath $Paths.Config) { Hide-Secrets (Get-Content -LiteralPath $Paths.Config -Raw) | Set-Content -LiteralPath (Join-Path $work 'config.json.txt') -Encoding UTF8 }
    if (Test-Path -LiteralPath $Paths.Health) { Copy-Item -LiteralPath $Paths.Health -Destination (Join-Path $work 'health.json') }
    if (Test-Path -LiteralPath $Paths.InstallState) { Copy-Item -LiteralPath $Paths.InstallState -Destination (Join-Path $work 'install-state.json') }
    if (Test-Path -LiteralPath $Paths.Logs) {
        foreach ($f in Get-ChildItem -LiteralPath $Paths.Logs -File | Sort-Object LastWriteTime -Descending | Select-Object -First 12) {
            Hide-Secrets ((Get-Content -LiteralPath $f.FullName -Tail 300 -ErrorAction SilentlyContinue) -join "`r`n") |
                Set-Content -LiteralPath (Join-Path $work ($f.Name + '.txt')) -Encoding UTF8
        }
    }
    & nvidia-smi.exe 2>&1 | Set-Content -LiteralPath (Join-Path $work 'nvidia-smi.txt') -Encoding UTF8
    $zip = Join-Path $outDir "xlchess-worker-diagnostics-$stamp.zip"
    Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -Force
    Remove-Item -LiteralPath $work -Recurse -Force
    Write-Host "Support bundle saved: $zip"
}
exit $(if ($problems -eq 0) { 0 } else { 1 })
