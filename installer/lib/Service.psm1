# Windows service, watchdog, firewall rules, power settings and Start menu shortcuts
# (docs/installer-v1-plan.md section 7: the four layers that keep the worker running).
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only.

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'Common.psm1')
Import-Module (Join-Path $PSScriptRoot 'Power.psm1')
Import-Module (Join-Path $PSScriptRoot 'Download.psm1')

$script:FirewallGroup = 'XLChess Worker'
$script:VirtualAccount = 'NT SERVICE\XLChessWorker'
$script:ShortcutFolderName = 'XLChess Worker'

# ---------------------------------------------------------------- WinSW service definition

function New-WinswXml {
    <# Builds the WinSW service definition. Pure: returns text, writes nothing. #>
    param([Parameter(Mandatory)]$Paths)
    function Esc([string]$s) { [Security.SecurityElement]::Escape($s) }
    $name = Get-ServiceName
    $lines = @(
        '<service>',
        "  <id>$name</id>",
        '  <name>XLChess SMB Worker</name>',
        '  <description>Runs the XLChess SMB local AI worker (Ollama and ComfyUI) and talks to the SMB API.</description>',
        "  <executable>$(Esc $Paths.NodeExe)</executable>",
        "  <arguments>&quot;$(Esc $Paths.WorkerJs)&quot; --config &quot;$(Esc $Paths.Config)&quot;</arguments>",
        "  <workingdirectory>$(Esc $Paths.Worker)</workingdirectory>",
        "  <env name=`"XLW_CONFIG`" value=`"$(Esc $Paths.Config)`"/>",
        "  <logpath>$(Esc $Paths.Logs)</logpath>",
        '  <log mode="roll-by-size">',
        '    <sizeThreshold>10240</sizeThreshold>',
        '    <keepFiles>14</keepFiles>',
        '  </log>',
        '  <startmode>Automatic</startmode>',
        '  <onfailure action="restart" delay="10 sec"/>',
        '  <onfailure action="restart" delay="30 sec"/>',
        '  <onfailure action="restart" delay="60 sec"/>',
        '  <resetfailure>1 day</resetfailure>',
        '  <stoptimeout>30 sec</stoptimeout>',
        '</service>'
    )
    ($lines -join "`r`n") + "`r`n"
}

function Get-WorkerService {
    Get-Service -Name (Get-ServiceName) -ErrorAction SilentlyContinue
}

function Invoke-Winsw {
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][string]$Command)
    $out = & $Paths.WinswExe $Command 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Service command '$Command' failed (exit $LASTEXITCODE): $out" }
}

function Set-ServiceFolderAccess {
    <# Gives the service account what it needs: read the program, write data and logs, read the token. #>
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][string]$Account)
    & icacls.exe $Paths.Program /grant "${Account}:(OI)(CI)RX" /T /C /Q | Out-Null
    & icacls.exe $Paths.Data /grant "${Account}:(OI)(CI)M" /T /C /Q | Out-Null
    & icacls.exe $Paths.Secrets /grant "${Account}:(OI)(CI)R" /C /Q | Out-Null
}

function Install-WorkerService {
    <#
    .SYNOPSIS Registers (or re-registers) the XLChessWorker service. It starts automatically at boot.
    .PARAMETER Account 'Virtual' (NT SERVICE\XLChessWorker) or 'LocalSystem'.
    #>
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)]$Paths,
        [ValidateSet('Virtual', 'LocalSystem')][string]$Account = 'Virtual'
    )
    $c = $Manifest.components.winsw
    Invoke-VerifiedDownload -Url $c.url -Destination $Paths.WinswExe -Sha256 $c.sha256 -SizeBytes $c.sizeBytes -Label 'service wrapper'
    [IO.File]::WriteAllText($Paths.WinswXml, (New-WinswXml -Paths $Paths), (New-Object Text.UTF8Encoding($false)))

    $existing = Get-WorkerService
    if ($existing) {
        if ($existing.Status -ne 'Stopped') { Stop-WorkerService -Paths $Paths }
        Invoke-Winsw -Paths $Paths -Command 'uninstall'
        Start-Sleep -Seconds 2
    }
    Invoke-Winsw -Paths $Paths -Command 'install'

    $name = Get-ServiceName
    if ($Account -eq 'Virtual') {
        & sc.exe config $name obj= $script:VirtualAccount | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not set the service account to $($script:VirtualAccount)." }
        Set-ServiceFolderAccess -Paths $Paths -Account $script:VirtualAccount
    }
    & sc.exe description $name 'Runs the XLChess SMB local AI worker.' | Out-Null
    Write-Log -Level Ok -Message "Service $name registered ($Account account, starts automatically)."
}

function Start-WorkerService {
    param([Parameter(Mandatory)]$Paths, [int]$TimeoutSeconds = 60)
    $svc = Get-WorkerService
    if (-not $svc) { throw 'The worker service is not installed.' }
    if ($svc.Status -ne 'Running') { Start-Service -Name $svc.Name }
    $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds($TimeoutSeconds))
}

function Stop-WorkerProcesses {
    <# Ends Ollama and ComfyUI processes that belong to this install (they can outlive a crashed worker). #>
    param([Parameter(Mandatory)]$Paths)
    $prefixes = @($Paths.Ollama, $Paths.Comfy)
    foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
        $path = $null
        try { $path = $p.Path } catch { }
        if (-not $path) { continue }
        foreach ($prefix in $prefixes) {
            if ($path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                Write-Log -Message "Ending stray process $($p.ProcessName) (pid $($p.Id))"
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
                break
            }
        }
    }
}

function Stop-WorkerService {
    param([Parameter(Mandatory)]$Paths, [int]$TimeoutSeconds = 45)
    $svc = Get-WorkerService
    if ($svc -and $svc.Status -ne 'Stopped') {
        try {
            Stop-Service -Name $svc.Name -Force -ErrorAction Stop
            $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds($TimeoutSeconds))
        } catch {
            Write-Log -Level Warn -Message "The service did not stop cleanly: $($_.Exception.Message)"
            $procId = (Get-CimInstance Win32_Service -Filter "Name='$($svc.Name)'").ProcessId
            if ($procId) { & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null }
        }
    }
    Stop-WorkerProcesses -Paths $Paths
}

function Get-HealthAgeSeconds {
    <# Seconds since the worker last wrote health.json, or $null when there is no readable file. #>
    param([Parameter(Mandatory)]$Paths, [DateTime]$Now = (Get-Date))
    if (-not (Test-Path -LiteralPath $Paths.Health)) { return $null }
    try {
        $h = Read-JsonFile -Path $Paths.Health
        $at = [DateTime]::Parse([string]$h.at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        return [math]::Max(0, ($Now.ToUniversalTime() - $at.ToUniversalTime()).TotalSeconds)
    } catch { return $null }
}

function Wait-WorkerHealthy {
    <# Waits for a fresh health.json written after $Since. Returns the health object, or $null on timeout. #>
    param([Parameter(Mandatory)]$Paths, [DateTime]$Since = (Get-Date), [int]$TimeoutSeconds = 90)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $age = Get-HealthAgeSeconds -Paths $Paths
        if ($null -ne $age) {
            $h = Read-JsonFile -Path $Paths.Health
            $at = [DateTime]::Parse([string]$h.at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
            if ($at.ToUniversalTime() -ge $Since.ToUniversalTime().AddSeconds(-2)) { return $h }
        }
        Start-Sleep -Seconds 2
    }
    $null
}

# ---------------------------------------------------------------- watchdog (layer 3)

function Get-WatchdogDecision {
    <#
    .SYNOPSIS Decides what the watchdog should do. Pure.
    .PARAMETER ServiceStatus 'Missing', 'Running', 'Stopped', 'StartPending', ...
    .PARAMETER HealthAgeSeconds age of health.json, or $null when absent
    .PARAMETER UptimeSeconds how long the service process has been running (grace period after a start)
    .OUTPUTS @{ Action = 'none'|'start'|'restart'; Reason }
    #>
    param(
        [string]$ServiceStatus,
        $HealthAgeSeconds,
        [double]$UptimeSeconds = 0,
        [int]$StaleAfterSeconds = 180,
        [int]$GraceSeconds = 300
    )
    if ($ServiceStatus -eq 'Missing') { return @{ Action = 'none'; Reason = 'The service is not installed.' } }
    if ($ServiceStatus -in @('StartPending', 'StopPending', 'ContinuePending', 'PausePending')) {
        return @{ Action = 'none'; Reason = "The service is $ServiceStatus; waiting." }
    }
    if ($ServiceStatus -ne 'Running') { return @{ Action = 'start'; Reason = "The service is $ServiceStatus." } }
    if ($UptimeSeconds -lt $GraceSeconds) { return @{ Action = 'none'; Reason = 'The service started recently.' } }
    if ($null -eq $HealthAgeSeconds) { return @{ Action = 'restart'; Reason = 'The worker is running but has never written health.json.' } }
    if ([double]$HealthAgeSeconds -gt $StaleAfterSeconds) {
        return @{ Action = 'restart'; Reason = "health.json is $([int]$HealthAgeSeconds)s old; the worker looks hung." }
    }
    @{ Action = 'none'; Reason = 'Healthy.' }
}

function Get-ServiceUptimeSeconds {
    $name = Get-ServiceName
    $procId = (Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction SilentlyContinue).ProcessId
    if (-not $procId) { return 0 }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return 0 }
    ((Get-Date) - $p.StartTime).TotalSeconds
}

function Register-WatchdogTask {
    param([Parameter(Mandatory)]$Paths)
    $script = Join-Path $Paths.Scripts 'watchdog-xlchess-worker.ps1'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName (Get-WatchdogTaskName) -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description 'Restarts the XLChess worker if it stops or hangs.' -Force | Out-Null
    Write-Log -Level Ok -Message 'Watchdog task registered (checks every 5 minutes).'
}

function Remove-WatchdogTask {
    $t = Get-ScheduledTask -TaskName (Get-WatchdogTaskName) -ErrorAction SilentlyContinue
    if ($t) { Unregister-ScheduledTask -TaskName (Get-WatchdogTaskName) -Confirm:$false }
}

# ---------------------------------------------------------------- firewall

function Register-FirewallRules {
    <# Blocks inbound access to the local model servers. Loopback is not filtered by Windows Firewall, so the
       worker's own use is unaffected; this protects against anything ever binding to a LAN address. #>
    param([Parameter(Mandatory)]$Manifest)
    foreach ($port in $Manifest.requirements.ports) {
        $display = "$($script:FirewallGroup) - block inbound $port"
        Get-NetFirewallRule -DisplayName $display -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        New-NetFirewallRule -DisplayName $display -Group $script:FirewallGroup -Direction Inbound -Action Block `
            -Protocol TCP -LocalPort $port -Profile Any | Out-Null
    }
    Write-Log -Level Ok -Message "Inbound access to ports $($Manifest.requirements.ports -join ', ') is blocked."
}

function Remove-FirewallRules {
    Get-NetFirewallRule -Group $script:FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

# ---------------------------------------------------------------- Start menu shortcuts (layer 4)

function Set-ShortcutRunAsAdmin {
    param([Parameter(Mandatory)][string]$Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    $bytes[0x15] = $bytes[0x15] -bor 0x20     # SLDF_RUNAS_USER
    [IO.File]::WriteAllBytes($Path, $bytes)
}

function Get-ShortcutFolder {
    Join-Path ([Environment]::GetFolderPath('CommonPrograms')) $script:ShortcutFolderName
}

function Register-Shortcuts {
    param([Parameter(Mandatory)]$Paths, [string]$Folder)
    $dir = $(if ($Folder) { $Folder } else { Get-ShortcutFolder })
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $shell = New-Object -ComObject WScript.Shell
    $items = @(
        @{ Name = 'Restart XLChess Worker'; Script = 'repair-xlchess-worker.ps1'; Args = '-Restart'; Note = 'Stops and starts the worker again, then checks it is healthy.' },
        @{ Name = 'XLChess Worker Status'; Script = 'diagnose-xlchess-worker.ps1'; Args = ''; Note = 'Shows whether the worker is healthy and saves a report for support.' }
    )
    foreach ($i in $items) {
        $lnk = Join-Path $dir ($i.Name + '.lnk')
        $s = $shell.CreateShortcut($lnk)
        $s.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
        $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$(Join-Path $Paths.Scripts $i.Script)`" $($i.Args)".TrimEnd()
        $s.WorkingDirectory = $Paths.Scripts
        $s.Description = $i.Note
        $s.Save()
        Set-ShortcutRunAsAdmin -Path $lnk
    }
    Write-Log -Level Ok -Message "Start menu shortcuts created in '$($script:ShortcutFolderName)'."
}

function Remove-Shortcuts {
    $dir = Get-ShortcutFolder
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
}

# ---------------------------------------------------------------- management scripts on the PC

function Install-ManagementScripts {
    <# Copies the maintenance scripts, their modules and the manifest to the program folder so they keep
       working after the installer package is deleted. #>
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][string]$InstallerRoot)
    New-Item -ItemType Directory -Path (Join-Path $Paths.Scripts 'lib') -Force | Out-Null
    foreach ($f in 'setup-xlchess-worker.ps1', 'diagnose-xlchess-worker.ps1', 'repair-xlchess-worker.ps1',
        'uninstall-xlchess-worker.ps1', 'watchdog-xlchess-worker.ps1', 'install.cmd', 'manifest.json') {
        $src = Join-Path $InstallerRoot $f
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $Paths.Scripts $f) -Force }
    }
    Copy-Item -Path (Join-Path $InstallerRoot 'lib\*.psm1') -Destination (Join-Path $Paths.Scripts 'lib') -Force
    Write-JsonFile -Path (Join-Path $Paths.Program 'install.json') -Value ([ordered]@{
            schemaVersion = 1; programPath = $Paths.Program; dataPath = $Paths.Data
        })
}

Export-ModuleMember -Function New-WinswXml, Get-WorkerService, Install-WorkerService, Start-WorkerService,
    Stop-WorkerProcesses, Stop-WorkerService, Get-HealthAgeSeconds, Wait-WorkerHealthy, Get-WatchdogDecision,
    Get-ServiceUptimeSeconds, Register-WatchdogTask, Remove-WatchdogTask, Register-FirewallRules,
    Remove-FirewallRules, Set-ShortcutRunAsAdmin, Get-ShortcutFolder, Register-Shortcuts, Remove-Shortcuts,
    Install-ManagementScripts, Set-ServiceFolderAccess
