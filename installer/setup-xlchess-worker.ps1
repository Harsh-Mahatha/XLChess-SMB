<#
.SYNOPSIS
    One-time setup of the XLChess SMB home-PC worker (docs/installer-v1-plan.md).

.DESCRIPTION
    Checks the PC, installs the local AI runtimes and models, installs the worker as a Windows service,
    pairs it with XLChess and runs a test. Every step can be re-run safely: run this script again to
    resume after an interruption or to update to a newer package.

.PARAMETER CheckOnly
    Run the preflight checks and stop. Changes nothing and needs no administrator rights.
.PARAMETER ApiUrl
    Address of the SMB API, for example https://smb.example.com. Needed for pairing.
.PARAMETER PairingCode
    The short pairing code made by an XLChess admin. If omitted, setup asks for it.
.PARAMETER DataPath
    Where models, logs and state are kept. Default: C:\ProgramData\XLChessWorker.
.PARAMETER ProgramPath
    Where program files go. Default: C:\Program Files\XLChessWorker.
.PARAMETER Yes
    Do not ask for confirmation (power changes are still skipped unless -AllowPowerChanges is given).
.PARAMETER AllowPowerChanges
    Turn off sleep and hibernate on AC power without asking.
.PARAMETER SkipGpuChecks
    Developer only: treat GPU preflight failures as warnings.
.PARAMETER SkipSelfTest
    Developer only: do not run the local GPU self-test (step 9).
#>
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$ApiUrl,
    [string]$PairingCode,
    [string]$DataPath,
    [string]$ProgramPath,
    [switch]$Yes,
    [switch]$AllowPowerChanges,
    [switch]$SkipGpuChecks,
    [switch]$SkipSelfTest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$InstallerRoot = $PSScriptRoot
foreach ($m in 'Common', 'Power', 'Preflight', 'Download', 'Runtimes', 'Service', 'Pairing') {
    Import-Module (Join-Path $InstallerRoot "lib\$m.psm1") -Force -DisableNameChecking
}

$pathArgs = @{}
if ($DataPath) { $pathArgs.DataPath = $DataPath }
if ($ProgramPath) { $pathArgs.ProgramPath = $ProgramPath }
$Paths = Get-InstallPaths @pathArgs
$Manifest = Get-Manifest -Path (Join-Path $InstallerRoot 'manifest.json')

# Steps in order. Each is { Name; Title; Run } and must be safe to run again (it checks what is already in place).
# Later milestones append to this list (service, firewall, power, pairing, end-to-end test).
$Steps = New-Object System.Collections.ArrayList
function Add-Step {
    param([string]$Name, [string]$Title, [scriptblock]$Run)
    [void]$Steps.Add([pscustomobject]@{ Name = $Name; Title = $Title; Run = $Run })
}

Add-Step 'folders' 'Creating folders and settings' {
    New-InstallFolders -Paths $Paths
    Write-WorkerConfig -Paths $Paths -Manifest $Manifest -ApiUrl $ApiUrl
}
Add-Step 'tools' 'Installing 7-Zip (used to unpack ComfyUI)' { Install-SevenZip -Manifest $Manifest -Paths $Paths }
Add-Step 'node' 'Installing Node.js' { Install-NodeRuntime -Manifest $Manifest -Paths $Paths }
Add-Step 'worker' 'Installing the worker' { Install-WorkerFiles -Paths $Paths -InstallerRoot $InstallerRoot }
Add-Step 'ollama' 'Installing Ollama (text model runtime)' { Install-OllamaRuntime -Manifest $Manifest -Paths $Paths }
Add-Step 'llm-model' "Downloading the text model ($($Manifest.models.llm.name))" { Install-OllamaModel -Manifest $Manifest -Paths $Paths }
Add-Step 'comfyui' 'Installing ComfyUI (image model runtime)' { Install-ComfyRuntime -Manifest $Manifest -Paths $Paths }
Add-Step 'image-models' "Downloading the image model ($($Manifest.models.image.name))" { Install-ImageModels -Manifest $Manifest -Paths $Paths }
Add-Step 'selftest-local' 'Testing the GPU: text model, then image model' {
    if ($SkipSelfTest) { Write-Log -Level Warn -Message 'Skipped (-SkipSelfTest).'; return }
    if (-not (Invoke-LocalSelfTest -Paths $Paths)) {
        throw 'The local GPU test failed. The models are kept, so running the installer again only repeats the test.'
    }
}
Add-Step 'firewall' 'Blocking inbound access to the model servers' {
    try { Register-FirewallRules -Manifest $Manifest }
    catch { Write-Log -Level Warn -Message "Could not add the firewall rules: $($_.Exception.Message)" }
}
Add-Step 'power' 'Keeping the PC awake while plugged in' {
    if (Test-AcSleepDisabled -Settings (Get-AcPowerSettings)) {
        Write-Log -Message 'Sleep and hibernate are already off on AC power.'
    } elseif ($AllowPowerChanges -or (Confirm-Action 'Turn off sleep and hibernate while plugged in, so the worker can run 24/7?')) {
        Set-AcSleepNever -BackupPath $Paths.PowerBackup
        Write-Log -Level Ok -Message 'Sleep and hibernate are now off on AC power (the old values are saved for uninstall).'
    } else {
        Write-Log -Level Warn -Message 'Left as it was. The PC may go to sleep, which stops the worker.'
    }
    Write-Log -Message 'Recommended once: in the BIOS/UEFI, set "Restore on AC power loss" to "Power On" so the PC starts again after a power cut.'
}
Add-Step 'pairing' 'Pairing this PC with XLChess' {
    if (Test-DeviceTokenPresent -Paths $Paths) { Write-Log -Message 'This PC is already paired.'; return }
    $url = $ApiUrl
    if (-not $url -and (Test-Path -LiteralPath $Paths.Config)) {
        $saved = Read-JsonFile -Path $Paths.Config
        if ($saved.PSObject.Properties['apiUrl']) { $url = [string]$saved.apiUrl }
    }
    if (-not $url) {
        if ($Yes) {
            Write-Log -Level Warn -Message 'No -ApiUrl was given, so this PC is not paired. Run repair-xlchess-worker.ps1 -NewPairing -ApiUrl <address> later.'
            return
        }
        $url = Read-Host 'SMB API address (for example https://smb.example.com)'
    }
    Write-WorkerConfig -Paths $Paths -Manifest $Manifest -ApiUrl $url
    [void](Invoke-WorkerPairing -Paths $Paths -PairingCode $PairingCode)
}
Add-Step 'service' 'Installing and starting the worker service' {
    Install-ManagementScripts -Paths $Paths -InstallerRoot $InstallerRoot
    Install-WorkerService -Manifest $Manifest -Paths $Paths -Account Virtual
    Register-WatchdogTask -Paths $Paths
    Register-Shortcuts -Paths $Paths

    $needGpu = -not $SkipGpuChecks
    foreach ($account in 'Virtual', 'LocalSystem') {
        if ($account -eq 'LocalSystem') {
            Write-Log -Level Warn -Message 'The worker could not see the GPU from the limited service account; switching to the LocalSystem account.'
            Stop-WorkerService -Paths $Paths
            Install-WorkerService -Manifest $Manifest -Paths $Paths -Account LocalSystem
        }
        $started = Get-Date
        Start-WorkerService -Paths $Paths
        Write-Log -Message 'Waiting for the worker to report healthy...'
        $health = Wait-WorkerHealthy -Paths $Paths -Since $started -TimeoutSeconds 120
        if (-not $health) {
            throw "The service started but the worker did not report healthy. See the logs in $($Paths.Logs)."
        }
        if ($health.gpu -or -not $needGpu) { break }
        if ($account -eq 'LocalSystem') { throw 'The worker service cannot see the GPU (nvidia-smi). Check the NVIDIA driver and run the installer again.' }
    }
    Write-Log -Level Ok -Message "Worker is running (version $($health.version))."
}

function Confirm-Action {
    param([Parameter(Mandatory)][string]$Question)
    if ($Yes) { return $true }
    $answer = Read-Host "$Question [y/N]"
    $answer -match '^(y|yes)$'
}

try {
    if (-not $CheckOnly) {
        Initialize-Log -Path (Join-Path $Paths.Logs ("install-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss')))
    }
    Write-Host ''
    Write-Host "XLChess worker installer $($Manifest.installerVersion)" -ForegroundColor Cyan

    # ---- 1. Preflight
    $expected = @($Steps | ForEach-Object { $_.Name })
    $results = Invoke-Preflight -Manifest $Manifest -Paths $Paths -ApiUrl $ApiUrl -CheckOnly:$CheckOnly `
        -SkipGpuChecks:$SkipGpuChecks -ExpectedSteps $expected
    Write-PreflightReport -Results $results
    $code = Get-PreflightExitCode -Results $results
    if ($code -ne 0) {
        Write-Log -Level Error -Message 'Preflight failed. Nothing has been changed. Fix the items above and run the installer again.'
        exit 1
    }
    if ($CheckOnly) {
        Write-Log -Level Ok -Message 'All required checks passed. Run install.cmd to install.'
        exit 0
    }

    # ---- 2. Consent
    $totalBytes = Get-ManifestDownloadBytes -Manifest $Manifest
    Write-Log -Level Step -Message 'What will be installed'
    Write-Log -Message "Ollama $($Manifest.components.ollama.version) with model $($Manifest.models.llm.name)"
    Write-Log -Message "ComfyUI $($Manifest.components.comfyui.version) with model $($Manifest.models.image.name)"
    Write-Log -Message "Worker service '$(Get-ServiceName)', Node.js $($Manifest.components.node.version)"
    Write-Log -Message "Download size: $(Format-Bytes $totalBytes)"
    Write-Log -Message "Program files: $($Paths.Program)"
    Write-Log -Message "Data and models: $($Paths.Data)"
    if (-not (Confirm-Action 'Continue?')) {
        Write-Log -Level Warn -Message 'Cancelled. Nothing was installed.'
        exit 3
    }

    $state = Get-InstallState -Paths $Paths
    foreach ($step in $Steps) {
        Write-Log -Level Step -Message $step.Title
        if (Test-StepDone -State $state -Step $step.Name) {
            Write-Log -Message 'Already done; checking it is still in place.'
        }
        try {
            & $step.Run
            Set-StepResult -State $state -Step $step.Name -Status done
        } catch {
            Set-StepResult -State $state -Step $step.Name -Status failed -Detail $_.Exception.Message
            throw
        } finally {
            $state.installerVersion = [string]$Manifest.installerVersion
            Save-InstallState -Paths $Paths -State $state
        }
    }
    $paired = Test-DeviceTokenPresent -Paths $Paths
    Write-Log -Level Step -Message 'Setup finished'
    Write-Log -Level Ok -Message "The worker is installed and runs in the background, including after a restart."
    if ($paired) { Write-Log -Level Ok -Message 'This PC is paired with XLChess.' }
    else { Write-Log -Level Warn -Message 'This PC is NOT paired yet. Run repair-xlchess-worker.ps1 -NewPairing -ApiUrl <address>.' }
    Write-Log -Message "If the worker ever stops: Start menu > '$((Split-Path -Leaf (Get-ShortcutFolder)))' > 'Restart XLChess Worker'."
    Write-Log -Message "Status and support report: Start menu > '$((Split-Path -Leaf (Get-ShortcutFolder)))' > 'XLChess Worker Status'."
    Write-Log -Message "Logs: $($Paths.Logs)"
    exit 0
} catch {
    Write-Log -Level Error -Message $_.Exception.Message
    if ($_.ScriptStackTrace) { Write-Log -Level Info -Message $_.ScriptStackTrace }
    Write-Log -Level Info -Message 'Setup stopped. Fix the problem and run the installer again; finished steps are not repeated.'
    exit 2
}
