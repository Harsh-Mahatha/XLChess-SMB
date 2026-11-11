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
    [switch]$SkipGpuChecks
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$InstallerRoot = $PSScriptRoot
foreach ($m in 'Common', 'Power', 'Preflight') {
    Import-Module (Join-Path $InstallerRoot "lib\$m.psm1") -Force -DisableNameChecking
}

$pathArgs = @{}
if ($DataPath) { $pathArgs.DataPath = $DataPath }
if ($ProgramPath) { $pathArgs.ProgramPath = $ProgramPath }
$Paths = Get-InstallPaths @pathArgs
$Manifest = Get-Manifest -Path (Join-Path $InstallerRoot 'manifest.json')

# Steps in order. Each is { Name; Title; Run }. Later milestones append to this list.
$Steps = New-Object System.Collections.ArrayList

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
    Write-Log -Level Ok -Message 'Setup finished.'
    exit 0
} catch {
    Write-Log -Level Error -Message $_.Exception.Message
    if ($_.ScriptStackTrace) { Write-Log -Level Info -Message $_.ScriptStackTrace }
    Write-Log -Level Info -Message 'Setup stopped. Fix the problem and run the installer again; finished steps are not repeated.'
    exit 2
}
