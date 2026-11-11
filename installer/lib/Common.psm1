# Shared helpers for the XLChess worker installer.
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only.

Set-StrictMode -Version 2.0

$script:ServiceName = 'XLChessWorker'
$script:WatchdogTaskName = 'XLChessWorkerWatchdog'
$script:LogFile = $null

function Get-ServiceName { $script:ServiceName }
function Get-WatchdogTaskName { $script:WatchdogTaskName }

function Get-InstallPaths {
    <#
    .SYNOPSIS Resolves every folder and file the installer uses (see docs/installer-v1-plan.md section 3).
    #>
    param(
        [string]$ProgramPath = (Join-Path $env:ProgramFiles 'XLChessWorker'),
        [string]$DataPath = (Join-Path $env:ProgramData 'XLChessWorker')
    )
    $comfy = Join-Path $DataPath 'comfyui'
    [ordered]@{
        Program        = $ProgramPath
        Data           = $DataPath
        Node           = Join-Path $ProgramPath 'node'
        NodeExe        = Join-Path $ProgramPath 'node\node.exe'
        Worker         = Join-Path $ProgramPath 'worker'
        WorkerJs       = Join-Path $ProgramPath 'worker\worker.cjs'
        Workflows      = Join-Path $ProgramPath 'worker\workflows'
        Ollama         = Join-Path $ProgramPath 'ollama'
        OllamaExe      = Join-Path $ProgramPath 'ollama\ollama.exe'
        Scripts        = Join-Path $ProgramPath 'scripts'
        Winsw          = Join-Path $ProgramPath 'winsw'
        WinswExe       = Join-Path $ProgramPath 'winsw\XLChessWorker.exe'
        WinswXml       = Join-Path $ProgramPath 'winsw\XLChessWorker.xml'
        Tools          = Join-Path $ProgramPath 'tools'
        SevenZipExe    = Join-Path $ProgramPath 'tools\7zr.exe'
        Config         = Join-Path $DataPath 'config.json'
        Secrets        = Join-Path $DataPath 'secrets'
        TokenFile      = Join-Path $DataPath 'secrets\device-token.bin'
        State          = Join-Path $DataPath 'state'
        InstallState   = Join-Path $DataPath 'state\install-state.json'
        PowerBackup    = Join-Path $DataPath 'state\power-settings-backup.json'
        Health         = Join-Path $DataPath 'state\health.json'
        Checkpoints    = Join-Path $DataPath 'checkpoints'
        Comfy          = $comfy
        ComfyMain      = Join-Path $comfy 'ComfyUI\main.py'
        ComfyPython    = Join-Path $comfy 'python_embeded\python.exe'
        OllamaModels   = Join-Path $DataPath 'models\ollama'
        Outputs        = Join-Path $DataPath 'outputs'
        Logs           = Join-Path $DataPath 'logs'
        Downloads      = Join-Path $DataPath 'downloads'
    }
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Format-Bytes {
    param([Parameter(Mandatory)][double]$Bytes)
    if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N0} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
    return ('{0:N0} B' -f $Bytes)
}

# ---------------------------------------------------------------- logging

function Initialize-Log {
    param([Parameter(Mandatory)][string]$Path)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $script:LogFile = $Path
}

function Write-Log {
    param(
        [Parameter(Mandatory)][string]$Message,
        [ValidateSet('Info', 'Ok', 'Warn', 'Error', 'Step')][string]$Level = 'Info'
    )
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    if ($script:LogFile) {
        try {
            Add-Content -LiteralPath $script:LogFile -Value "$stamp [$Level] $Message" -Encoding UTF8
        } catch { }
    }
    switch ($Level) {
        'Ok'    { Write-Host "  [ OK ] $Message" -ForegroundColor Green }
        'Warn'  { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
        'Error' { Write-Host "  [FAIL] $Message" -ForegroundColor Red }
        'Step'  { Write-Host ''; Write-Host "== $Message" -ForegroundColor Cyan }
        default { Write-Host "         $Message" }
    }
}

# ---------------------------------------------------------------- JSON (no BOM: Node.js must be able to read it)

function Read-JsonFile {
    param([Parameter(Mandatory)][string]$Path)
    $raw = [IO.File]::ReadAllText($Path)
    if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
    $raw | ConvertFrom-Json
}

function Write-JsonFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $json = $Value | ConvertTo-Json -Depth 10
    $tmp = "$Path.tmp"
    [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Get-Manifest {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw "manifest.json not found at $Path" }
    $m = Read-JsonFile -Path $Path
    if ($m.schemaVersion -ne 1) { throw "Unsupported manifest schemaVersion $($m.schemaVersion)" }
    $m
}

function Get-ManifestDownloadBytes {
    <# Total bytes the installer would download for a full install. #>
    param([Parameter(Mandatory)]$Manifest)
    $total = 0.0
    foreach ($name in 'node', 'sevenZip', 'winsw', 'ollama', 'comfyui') {
        $total += [double]$Manifest.components.$name.sizeBytes
    }
    foreach ($b in $Manifest.models.llm.blobs) { $total += [double]$b.sizeBytes }
    foreach ($f in $Manifest.models.image.files) { $total += [double]$f.sizeBytes }
    $total
}

# ---------------------------------------------------------------- install state (resume support)

function Get-InstallState {
    param([Parameter(Mandatory)]$Paths)
    if (Test-Path -LiteralPath $Paths.InstallState) {
        try { return Read-JsonFile -Path $Paths.InstallState } catch { }
    }
    [pscustomobject]@{ schemaVersion = 1; installerVersion = $null; steps = [pscustomobject]@{} }
}

function Save-InstallState {
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)]$State)
    Write-JsonFile -Path $Paths.InstallState -Value $State
}

function Test-StepDone {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][string]$Step)
    $prop = $State.steps.PSObject.Properties[$Step]
    ($null -ne $prop) -and ($prop.Value.status -eq 'done')
}

function Set-StepResult {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$Step,
        [Parameter(Mandatory)][ValidateSet('done', 'failed', 'skipped')][string]$Status,
        [string]$Detail = ''
    )
    $entry = [pscustomobject]@{ status = $Status; at = (Get-Date).ToString('o'); detail = $Detail }
    if ($State.steps.PSObject.Properties[$Step]) {
        $State.steps.PSObject.Properties.Remove($Step)
    }
    $State.steps | Add-Member -NotePropertyName $Step -NotePropertyValue $entry
}

function Reset-StepResult {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][string]$Step)
    if ($State.steps.PSObject.Properties[$Step]) { $State.steps.PSObject.Properties.Remove($Step) }
}


function Resolve-InstallPaths {
    <#
    .SYNOPSIS Finds the paths of an existing install from where a maintenance script runs
    (Program\scripts\*.ps1 -> Program\install.json). Falls back to the defaults.
    #>
    param([Parameter(Mandatory)][string]$ScriptRoot)
    $marker = Join-Path (Split-Path -Parent $ScriptRoot) 'install.json'
    if (Test-Path -LiteralPath $marker) {
        $m = Read-JsonFile -Path $marker
        return Get-InstallPaths -ProgramPath $m.programPath -DataPath $m.dataPath
    }
    Get-InstallPaths
}

# ---------------------------------------------------------------- misc

function Test-PortInUse {
    param([Parameter(Mandatory)][int]$Port)
    $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if (-not $c) { return $null }
    $pid1 = ($c | Select-Object -First 1).OwningProcess
    $p = Get-Process -Id $pid1 -ErrorAction SilentlyContinue
    [pscustomobject]@{ Port = $Port; ProcessId = $pid1; ProcessName = $(if ($p) { $p.ProcessName } else { 'unknown' });
        Path = $(if ($p) { try { $p.Path } catch { $null } } else { $null }) }
}

Export-ModuleMember -Function Get-ServiceName, Get-WatchdogTaskName, Get-InstallPaths, Test-IsAdmin,
    Format-Bytes, Initialize-Log, Write-Log, Read-JsonFile, Write-JsonFile, Get-Manifest,
    Get-ManifestDownloadBytes, Get-InstallState, Save-InstallState, Test-StepDone, Set-StepResult,
    Reset-StepResult, Test-PortInUse, Resolve-InstallPaths
