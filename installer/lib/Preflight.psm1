# Preflight checks (docs/installer-v1-plan.md section 5).
# Each Get-*Check function is pure (inputs in, result out) so it can be unit-tested; Invoke-Preflight gathers
# the real values. Windows PowerShell 5.1 compatible. Keep this file ASCII-only.

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'Common.psm1')
Import-Module (Join-Path $PSScriptRoot 'Power.psm1')

function New-CheckResult {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet('Pass', 'Warn', 'Fail')][string]$Status,
        [Parameter(Mandatory)][string]$Message,
        [string]$Hint = ''
    )
    [pscustomobject]@{ Name = $Name; Status = $Status; Message = $Message; Hint = $Hint }
}

# ---------------------------------------------------------------- pure evaluators

function Get-ElevationCheck {
    param([bool]$IsAdmin, [bool]$CheckOnly = $false)
    if ($IsAdmin) { return New-CheckResult 'Administrator' 'Pass' 'Running as administrator.' }
    if ($CheckOnly) {
        return New-CheckResult 'Administrator' 'Warn' 'Not running as administrator (fine for -CheckOnly).' `
            'Run install.cmd to install; it asks for administrator rights.'
    }
    New-CheckResult 'Administrator' 'Fail' 'This installer needs administrator rights.' `
        'Start it with install.cmd, or right-click PowerShell and choose "Run as administrator".'
}

function Get-OsCheck {
    param([int]$Build, [bool]$Is64Bit, [string]$Caption = 'Windows', $Requirements)
    if (-not $Is64Bit) {
        return New-CheckResult 'Operating system' 'Fail' '64-bit Windows is required.' `
            'Install 64-bit Windows 11.'
    }
    if ($Build -ge [int]$Requirements.windows11Build) {
        return New-CheckResult 'Operating system' 'Pass' "$Caption (build $Build)."
    }
    if ($Build -ge [int]$Requirements.minWindowsBuild) {
        return New-CheckResult 'Operating system' 'Warn' `
            "$Caption (build $Build). Windows 10 is past end of support." `
            'Plan a move to Windows 11 (see the deployment notes in docs/devphases/1.21).'
    }
    New-CheckResult 'Operating system' 'Fail' "Windows build $Build is too old (need $($Requirements.minWindowsBuild) or newer)." `
        'Update Windows 10 to version 22H2, or install Windows 11.'
}

function Compare-VersionString {
    <# Returns -1, 0 or 1 comparing dotted numeric versions such as '560.76' and '596.36'. #>
    param([Parameter(Mandatory)][string]$A, [Parameter(Mandatory)][string]$B)
    function ConvertTo-Ver([string]$s) {
        $parts = @($s.Split('.') | ForEach-Object { [int]($_ -replace '[^0-9]', '0') })
        while ($parts.Count -lt 2) { $parts += 0 }
        [version]::new($parts[0], $parts[1], $(if ($parts.Count -gt 2) { $parts[2] } else { 0 }))
    }
    (ConvertTo-Ver $A).CompareTo((ConvertTo-Ver $B))
}

function Get-GpuChecks {
    <#
    .PARAMETER Gpu @{ Found; Name; VramMiB; Driver; Count } from Get-NvidiaGpuInfo.
    #>
    param($Gpu, $Requirements)
    if (-not $Gpu.Found) {
        $gpu = New-CheckResult 'GPU' 'Fail' 'No NVIDIA GPU found (nvidia-smi is missing or reports no device).' `
            'Install an NVIDIA GPU driver from nvidia.com/drivers, then run the installer again.'
        $drv = New-CheckResult 'GPU driver' 'Fail' 'Cannot check the driver without an NVIDIA GPU.'
        return @($gpu, $drv)
    }
    $gb = [math]::Round($Gpu.VramMiB / 1024, 1)
    if ($Gpu.VramMiB -ge [int]$Requirements.minVramMiB) {
        $gpuRes = New-CheckResult 'GPU' 'Pass' "$($Gpu.Name), $gb GB VRAM."
    } else {
        $gpuRes = New-CheckResult 'GPU' 'Fail' "$($Gpu.Name) has $gb GB VRAM; 12 GB is required." `
            'The models need a 12 GB GPU such as the RTX 4070.'
    }
    if ((Compare-VersionString $Gpu.Driver ([string]$Requirements.minDriverVersion)) -ge 0) {
        $drvRes = New-CheckResult 'GPU driver' 'Pass' "Driver $($Gpu.Driver) (minimum $($Requirements.minDriverVersion))."
    } else {
        $drvRes = New-CheckResult 'GPU driver' 'Fail' "Driver $($Gpu.Driver) is older than the minimum $($Requirements.minDriverVersion)." `
            'Update the NVIDIA driver from nvidia.com/drivers, then run the installer again.'
    }
    @($gpuRes, $drvRes)
}

function Get-RamCheck {
    param([double]$TotalGB, $Requirements)
    $gb = [math]::Round($TotalGB, 1)
    if ($TotalGB -lt [double]$Requirements.minRamGB) {
        return New-CheckResult 'Memory (RAM)' 'Fail' "$gb GB RAM; at least $($Requirements.minRamGB) GB is required." `
            'Add memory to the PC.'
    }
    if ($TotalGB -lt [double]$Requirements.recommendedRamGB) {
        return New-CheckResult 'Memory (RAM)' 'Warn' "$gb GB RAM; 64 GB is recommended (image generation will be slower)." `
            'Image generation moves part of the model into system memory.'
    }
    New-CheckResult 'Memory (RAM)' 'Pass' "$gb GB RAM."
}

function Get-DiskCheck {
    <#
    .PARAMETER Volumes list of @{ Root; FreeBytes; NeededBytes } (one entry per drive that will be written to).
    #>
    param($Volumes, $Requirements)
    $headroom = [double]$Requirements.diskHeadroomGB * 1GB
    $bad = @()
    $lines = @()
    foreach ($v in $Volumes) {
        $need = [double]$v.NeededBytes + $headroom
        $lines += "$($v.Root) $(Format-Bytes $v.FreeBytes) free (needs $(Format-Bytes $need))"
        if ([double]$v.FreeBytes -lt $need) { $bad += $v.Root }
    }
    if ($bad.Count -gt 0) {
        return New-CheckResult 'Disk space' 'Fail' ("Not enough free space on " + ($bad -join ', ') + '. ' + ($lines -join '; ')) `
            'Free up space, or use -DataPath to put the models on another drive.'
    }
    New-CheckResult 'Disk space' 'Pass' ($lines -join '; ')
}

function Get-NetworkCheck {
    <# .PARAMETER Hosts list of @{ Host; Reachable; Error }. #>
    param($Hosts)
    $down = @($Hosts | Where-Object { -not $_.Reachable })
    if ($down.Count -eq 0) {
        return New-CheckResult 'Network' 'Pass' ("Reached " + (($Hosts | ForEach-Object { $_.Host }) -join ', ') + '.')
    }
    New-CheckResult 'Network' 'Fail' ("Cannot reach: " + (($down | ForEach-Object { $_.Host }) -join ', ') + '.') `
        'Check the internet connection, proxy and firewall (HTTPS on port 443 must be allowed), then run the installer again.'
}

function Get-ApiCheck {
    param($Api)
    if ($null -eq $Api) {
        return New-CheckResult 'SMB API' 'Warn' 'No -ApiUrl given; the API check and pairing are skipped.' `
            'Pass -ApiUrl https://<smb-api-host> to pair this PC.'
    }
    if ($Api.Reachable) { return New-CheckResult 'SMB API' 'Pass' "$($Api.Url) is healthy." }
    New-CheckResult 'SMB API' 'Fail' "Cannot reach $($Api.Url)/health ($($Api.Error))." `
        'Check the API address and that the SMB API is running.'
}

function Get-PortCheck {
    <#
    .PARAMETER InUse list of @{ Port; ProcessName; Path } for ports that are listening.
    .PARAMETER OwnedPathPrefixes folders whose programs are ours (our own Ollama/ComfyUI from a previous run).
    #>
    param($InUse, [string[]]$OwnedPathPrefixes = @())
    $foreign = @()
    foreach ($p in @($InUse)) {
        if ($null -eq $p) { continue }
        $ours = $false
        if ($p.Path) {
            foreach ($prefix in $OwnedPathPrefixes) {
                if ($prefix -and $p.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $ours = $true }
            }
        }
        if (-not $ours) { $foreign += $p }
    }
    if ($foreign.Count -eq 0) { return New-CheckResult 'Local ports' 'Pass' 'Ports 11434 and 8188 are free (or used by this worker).' }
    $desc = ($foreign | ForEach-Object { "$($_.Port) used by $($_.ProcessName)" }) -join '; '
    New-CheckResult 'Local ports' 'Fail' "Another program is using a required port: $desc." `
        'Close that program (for example a separately installed Ollama or ComfyUI) and run the installer again.'
}

function Get-ExistingInstallCheck {
    <#
    .PARAMETER State install-state.json contents, or $null when there is no previous install.
    .PARAMETER Expected the manifest step names that make a complete install.
    #>
    param($State, [string]$NewVersion, [string[]]$ExpectedSteps)
    if ($null -eq $State -or -not $State.installerVersion) {
        return New-CheckResult 'Existing install' 'Pass' 'No previous install found.'
    }
    $cmp = Compare-VersionString ([string]$State.installerVersion) $NewVersion
    if ($cmp -gt 0) {
        return New-CheckResult 'Existing install' 'Fail' "A newer version ($($State.installerVersion)) is installed; this package is $NewVersion." `
            'Use the newer installer package.'
    }
    $done = @($ExpectedSteps | Where-Object { $State.steps.PSObject.Properties[$_] -and $State.steps.$_.status -eq 'done' })
    if ($done.Count -lt $ExpectedSteps.Count) {
        return New-CheckResult 'Existing install' 'Warn' "A previous install ($($State.installerVersion)) did not finish; setup will resume."
    }
    New-CheckResult 'Existing install' 'Pass' "Version $($State.installerVersion) is installed; setup will update it to $NewVersion."
}

function Get-PowerCheck {
    param($Settings)
    if (Test-AcSleepDisabled -Settings $Settings) {
        return New-CheckResult 'Power settings' 'Pass' 'Sleep and hibernate are off on AC power.'
    }
    New-CheckResult 'Power settings' 'Warn' 'The PC would go to sleep on AC power, which stops the worker.' `
        'Setup offers to turn this off for AC power.'
}

function Get-PreflightExitCode {
    param($Results)
    if (@($Results | Where-Object { $_.Status -eq 'Fail' }).Count -gt 0) { return 1 }
    0
}

# ---------------------------------------------------------------- gatherers

function Find-NvidiaSmi {
    $cmd = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
            (Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'),
            (Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'))) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    $null
}

function Get-NvidiaGpuInfo {
    $smi = Find-NvidiaSmi
    if (-not $smi) { return [pscustomobject]@{ Found = $false; Name = $null; VramMiB = 0; Driver = '0'; Count = 0 } }
    $lines = @(& $smi '--query-gpu=name,memory.total,driver_version' '--format=csv,noheader,nounits' 2>$null)
    $gpus = @()
    foreach ($line in $lines) {
        $f = $line.Split(',') | ForEach-Object { $_.Trim() }
        if ($f.Count -ge 3 -and $f[1] -match '^\d+$') {
            $gpus += [pscustomobject]@{ Name = $f[0]; VramMiB = [int]$f[1]; Driver = $f[2] }
        }
    }
    if ($gpus.Count -eq 0) { return [pscustomobject]@{ Found = $false; Name = $null; VramMiB = 0; Driver = '0'; Count = 0 } }
    $best = $gpus | Sort-Object VramMiB -Descending | Select-Object -First 1
    [pscustomobject]@{ Found = $true; Name = $best.Name; VramMiB = $best.VramMiB; Driver = $best.Driver; Count = $gpus.Count }
}

function Test-HostReachable {
    param([Parameter(Mandatory)][string]$HostName, [int]$Port = 443, [int]$TimeoutMs = 6000)
    $client = New-Object Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync($HostName, $Port)
        if ($task.Wait($TimeoutMs) -and $client.Connected) {
            return [pscustomobject]@{ Host = $HostName; Reachable = $true; Error = $null }
        }
        [pscustomobject]@{ Host = $HostName; Reachable = $false; Error = 'timed out' }
    } catch {
        [pscustomobject]@{ Host = $HostName; Reachable = $false; Error = $_.Exception.GetBaseException().Message }
    } finally {
        $client.Dispose()
    }
}

function Test-ApiReachable {
    param([Parameter(Mandatory)][string]$Url)
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    try {
        $r = Invoke-WebRequest -Uri ($Url.TrimEnd('/') + '/health') -UseBasicParsing -TimeoutSec 10
        [pscustomobject]@{ Url = $Url; Reachable = ($r.StatusCode -eq 200); Error = "HTTP $($r.StatusCode)" }
    } catch {
        [pscustomobject]@{ Url = $Url; Reachable = $false; Error = $_.Exception.Message }
    }
}

function Get-VolumeRequirement {
    <#
    .SYNOPSIS Splits the download total between the program drive and the data drive.
    Program files (Node, Ollama, WinSW) are about 3x their download size once unpacked.
    #>
    param($Manifest, $Paths)
    $programBytes = 0.0
    foreach ($n in 'node', 'sevenZip', 'winsw', 'ollama') { $programBytes += [double]$Manifest.components.$n.sizeBytes * 2 }
    $total = Get-ManifestDownloadBytes -Manifest $Manifest
    $dataBytes = $total + [double]$Manifest.components.comfyui.sizeBytes   # archive + extracted copy
    $progRoot = [IO.Path]::GetPathRoot($Paths.Program)
    $dataRoot = [IO.Path]::GetPathRoot($Paths.Data)
    if ($progRoot -eq $dataRoot) {
        return @([pscustomobject]@{ Root = $dataRoot; NeededBytes = $dataBytes + $programBytes })
    }
    @(
        [pscustomobject]@{ Root = $progRoot; NeededBytes = $programBytes },
        [pscustomobject]@{ Root = $dataRoot; NeededBytes = $dataBytes }
    )
}

function Get-FreeBytes {
    param([Parameter(Mandatory)][string]$Root)
    $d = New-Object IO.DriveInfo ($Root.Substring(0, 1))
    [double]$d.AvailableFreeSpace
}

function Invoke-Preflight {
    <#
    .SYNOPSIS Runs every check and returns the results (it does not print or stop).
    .PARAMETER SkipGpuChecks Developer switch: GPU checks become warnings so the flow can be tried without a GPU.
    #>
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)]$Paths,
        [string]$ApiUrl,
        [bool]$CheckOnly = $false,
        [switch]$SkipGpuChecks,
        [string[]]$ExpectedSteps = @()
    )
    $req = $Manifest.requirements
    $results = New-Object System.Collections.ArrayList

    [void]$results.Add((Get-ElevationCheck -IsAdmin (Test-IsAdmin) -CheckOnly $CheckOnly))

    $os = Get-CimInstance Win32_OperatingSystem
    [void]$results.Add((Get-OsCheck -Build ([int]$os.BuildNumber) -Is64Bit ([Environment]::Is64BitOperatingSystem) `
            -Caption $os.Caption -Requirements $req))

    $gpuChecks = Get-GpuChecks -Gpu (Get-NvidiaGpuInfo) -Requirements $req
    foreach ($c in $gpuChecks) {
        if ($SkipGpuChecks -and $c.Status -eq 'Fail') {
            $c = New-CheckResult $c.Name 'Warn' ("(skipped by -SkipGpuChecks) " + $c.Message) $c.Hint
        }
        [void]$results.Add($c)
    }

    $ramGB = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB
    [void]$results.Add((Get-RamCheck -TotalGB $ramGB -Requirements $req))

    $volumes = @()
    foreach ($v in (Get-VolumeRequirement -Manifest $Manifest -Paths $Paths)) {
        $volumes += [pscustomobject]@{ Root = $v.Root; NeededBytes = $v.NeededBytes; FreeBytes = (Get-FreeBytes -Root $v.Root) }
    }
    [void]$results.Add((Get-DiskCheck -Volumes $volumes -Requirements $req))

    $hosts = @($req.hosts)
    $netHosts = @($hosts | ForEach-Object { Test-HostReachable -HostName $_ })
    [void]$results.Add((Get-NetworkCheck -Hosts $netHosts))

    $api = $null
    if ($ApiUrl) { $api = Test-ApiReachable -Url $ApiUrl }
    [void]$results.Add((Get-ApiCheck -Api $api))

    $inUse = @($req.ports | ForEach-Object { Test-PortInUse -Port ([int]$_) } | Where-Object { $null -ne $_ })
    [void]$results.Add((Get-PortCheck -InUse $inUse -OwnedPathPrefixes @($Paths.Program, $Paths.Data)))

    $state = $null
    if (Test-Path -LiteralPath $Paths.InstallState) { $state = Get-InstallState -Paths $Paths }
    [void]$results.Add((Get-ExistingInstallCheck -State $state -NewVersion ([string]$Manifest.installerVersion) -ExpectedSteps $ExpectedSteps))

    [void]$results.Add((Get-PowerCheck -Settings (Get-AcPowerSettings)))

    , @($results)
}

function Write-PreflightReport {
    param([Parameter(Mandatory)]$Results)
    Write-Log -Level Step -Message 'Preflight checks'
    foreach ($r in $Results) {
        $line = ('{0,-18} {1}' -f $r.Name, $r.Message)
        switch ($r.Status) {
            'Pass' { Write-Log -Level Ok -Message $line }
            'Warn' { Write-Log -Level Warn -Message $line }
            'Fail' { Write-Log -Level Error -Message $line }
        }
        if ($r.Status -ne 'Pass' -and $r.Hint) { Write-Log -Level Info -Message "       -> $($r.Hint)" }
    }
}

Export-ModuleMember -Function New-CheckResult, Get-ElevationCheck, Get-OsCheck, Compare-VersionString,
    Get-GpuChecks, Get-RamCheck, Get-DiskCheck, Get-NetworkCheck, Get-ApiCheck, Get-PortCheck,
    Get-ExistingInstallCheck, Get-PowerCheck, Get-PreflightExitCode, Find-NvidiaSmi, Get-NvidiaGpuInfo,
    Test-HostReachable, Test-ApiReachable, Get-VolumeRequirement, Invoke-Preflight, Write-PreflightReport
