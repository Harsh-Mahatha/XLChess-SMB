# Installs the worker's runtimes and models: Node.js, the worker bundle, Ollama + Qwen3.5 9B,
# ComfyUI + Z-Image-Turbo, and runs the local GPU self-test (docs/installer-v1-plan.md section 4, steps 3-9).
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only.

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'Common.psm1')
Import-Module (Join-Path $PSScriptRoot 'Download.psm1')

function New-InstallFolders {
    param([Parameter(Mandatory)]$Paths)
    foreach ($key in 'Program', 'Data', 'Node', 'Worker', 'Workflows', 'Ollama', 'Scripts', 'Winsw', 'Tools',
        'Secrets', 'State', 'Checkpoints', 'OllamaModels', 'Outputs', 'Logs', 'Downloads') {
        $dir = $Paths[$key]
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }
    # Secrets: only SYSTEM and Administrators (the service runs as SYSTEM-level or a virtual account that is
    # granted access when the service is registered).
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($id in 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators') {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($id, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Paths.Secrets -AclObject $acl
}

function Get-WorkerPackageDir {
    <# Where the worker bundle lives: next to the installer in a package, or in the repo while developing. #>
    param([Parameter(Mandatory)][string]$InstallerRoot)
    foreach ($candidate in @((Join-Path $InstallerRoot 'worker'), (Join-Path $InstallerRoot '..\apps\worker\bundle'))) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'worker.cjs')) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    throw "worker.cjs was not found next to the installer. Build it with 'npm run bundle -w @smb/worker' or use a built installer package."
}

function Install-NodeRuntime {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)]$Paths)
    Install-ArchiveComponent -Component $Manifest.components.node -Name 'node' -DownloadDir $Paths.Downloads `
        -Destination $Paths.Node -MustExist 'node.exe'
    $v = (& $Paths.NodeExe --version) 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Node.js does not run: $v" }
    Write-Log -Message "Node.js $v"
}

function Install-SevenZip {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)]$Paths)
    $c = $Manifest.components.sevenZip
    Invoke-VerifiedDownload -Url $c.url -Destination $Paths.SevenZipExe -Sha256 $c.sha256 -SizeBytes $c.sizeBytes -Label '7-Zip'
}

function Install-WorkerFiles {
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][string]$InstallerRoot)
    $src = Get-WorkerPackageDir -InstallerRoot $InstallerRoot
    Copy-Item -LiteralPath (Join-Path $src 'worker.cjs') -Destination $Paths.WorkerJs -Force
    if (Test-Path -LiteralPath (Join-Path $src 'worker.cjs.map')) {
        Copy-Item -LiteralPath (Join-Path $src 'worker.cjs.map') -Destination (Join-Path $Paths.Worker 'worker.cjs.map') -Force
    }
    Copy-Item -Path (Join-Path $src 'workflows\*') -Destination $Paths.Workflows -Recurse -Force
    $v = (& $Paths.NodeExe $Paths.WorkerJs --version) 2>&1
    if ($LASTEXITCODE -ne 0) { throw "The worker does not start: $v" }
    Write-Log -Level Ok -Message "Worker $v installed."
}

function Write-WorkerConfig {
    <# config.json holds no secrets; the pairing step stores the device token separately. #>
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)]$Manifest, [string]$ApiUrl)
    $cfg = [ordered]@{
        schemaVersion = 1
        programDir    = $Paths.Program
        dataDir       = $Paths.Data
        ollama        = [ordered]@{ port = 11434; model = $Manifest.models.llm.name; numCtx = 16384 }
        comfy         = [ordered]@{ port = 8188 }
    }
    if ($ApiUrl) { $cfg['apiUrl'] = $ApiUrl.TrimEnd('/') }
    elseif (Test-Path -LiteralPath $Paths.Config) {
        $old = Read-JsonFile -Path $Paths.Config
        if ($old.PSObject.Properties['apiUrl']) { $cfg['apiUrl'] = $old.apiUrl }
    }
    Write-JsonFile -Path $Paths.Config -Value $cfg
}

function Install-OllamaRuntime {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)]$Paths)
    Install-ArchiveComponent -Component $Manifest.components.ollama -Name 'ollama' -DownloadDir $Paths.Downloads `
        -Destination $Paths.Ollama -MustExist 'ollama.exe'
}

function Invoke-WithOllamaServer {
    <# Runs $Action while a private `ollama serve` (localhost only, our model folder) is up, then stops it. #>
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][scriptblock]$Action, $Context = $null, [int]$Port = 11434)
    $old = @{}
    $vars = @{ OLLAMA_HOST = "127.0.0.1:$Port"; OLLAMA_MODELS = $Paths.OllamaModels; OLLAMA_MAX_LOADED_MODELS = '1'; OLLAMA_NUM_PARALLEL = '1' }
    foreach ($k in $vars.Keys) { $old[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process') }
    $proc = $null
    try {
        $logOut = Join-Path $Paths.Logs 'ollama-install.log'
        $proc = Start-Process -FilePath $Paths.OllamaExe -ArgumentList 'serve' -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $logOut -RedirectStandardError ($logOut + '.err')
        $ready = $false
        for ($i = 0; $i -lt 60; $i++) {
            try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/version" -TimeoutSec 2 | Out-Null; $ready = $true; break } catch { Start-Sleep -Seconds 1 }
        }
        if (-not $ready) { throw "Ollama did not start. See $logOut" }
        & $Action $Context
    } finally {
        if ($proc -and -not $proc.HasExited) { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null }
        foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $old[$k], 'Process') }
    }
}

function Test-OllamaModelPresent {
    <# True when every blob listed in the manifest is on disk with the right size. #>
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)]$Paths)
    foreach ($b in $Manifest.models.llm.blobs) {
        $f = Join-Path $Paths.OllamaModels ("blobs\sha256-" + $b.sha256)
        if (-not (Test-Path -LiteralPath $f)) { return $false }
        if ((Get-Item -LiteralPath $f).Length -ne [long]$b.sizeBytes) { return $false }
    }
    $true
}

function Install-OllamaModel {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)]$Paths, [int]$Retries = 3)
    if (Test-OllamaModelPresent -Manifest $Manifest -Paths $Paths) {
        Write-Log -Message "$($Manifest.models.llm.name) is already downloaded and verified."
        return
    }
    $name = $Manifest.models.llm.name
    $action = {
        param($ctx)
        for ($attempt = 1; $attempt -le $ctx.Retries; $attempt++) {
            Write-Log -Message "Downloading $($ctx.Name) (attempt $attempt of $($ctx.Retries))"
            # `ollama pull` prints a progress line many times a second; show one every 15 seconds.
            $clock = [Diagnostics.Stopwatch]::StartNew()
            $lastShown = -15
            & $ctx.Paths.OllamaExe pull $ctx.Name 2>&1 | ForEach-Object {
                $text = ([string]$_).Trim()
                if ($text -and ($clock.Elapsed.TotalSeconds - $lastShown) -ge 15) {
                    $lastShown = $clock.Elapsed.TotalSeconds
                    Write-Log -Message $text
                }
            }
            if ($LASTEXITCODE -eq 0 -and (Test-OllamaModelPresent -Manifest $ctx.Manifest -Paths $ctx.Paths)) { return }
            Start-Sleep -Seconds (5 * $attempt)
        }
        throw "Could not download $($ctx.Name). Check the internet connection and run the installer again."
    }
    $context = @{ Paths = $Paths; Manifest = $Manifest; Name = $name; Retries = $Retries }
    Invoke-WithOllamaServer -Paths $Paths -Action $action -Context $context
    Write-Log -Level Ok -Message "$name downloaded and verified."
}

function Install-ComfyRuntime {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)]$Paths)
    Install-ArchiveComponent -Component $Manifest.components.comfyui -Name 'comfyui' -DownloadDir $Paths.Downloads `
        -Destination $Paths.Comfy -SevenZipExe $Paths.SevenZipExe -Preserve @('ComfyUI\models') -MustExist 'python_embeded\python.exe'
}

function Install-ImageModels {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)]$Paths)
    $m = $Manifest.models.image
    foreach ($f in $m.files) {
        $url = "https://huggingface.co/$($m.repo)/resolve/$($m.revision)/$($f.path)"
        $dest = Join-Path $Paths.Comfy ($f.dest -replace '/', '\')
        Invoke-VerifiedDownload -Url $url -Destination $dest -Sha256 $f.sha256 -SizeBytes $f.sizeBytes -Label $f.role
    }
}

function Invoke-LocalSelfTest {
    <#
    .SYNOPSIS Runs `worker.cjs --selftest-local` and prints a short report. Returns $true when everything passed.
    #>
    param([Parameter(Mandatory)]$Paths)
    Write-Log -Message 'Running the local GPU test: text model, then image model. The first run can take several minutes.'
    $out = & $Paths.NodeExe $Paths.WorkerJs --selftest-local --json --config $Paths.Config 2>&1
    $exit = $LASTEXITCODE
    $line = @($out | ForEach-Object { [string]$_ } | Where-Object { $_.StartsWith('{"ok"') }) | Select-Object -Last 1
    if (-not $line) {
        Write-Log -Level Error -Message 'The self-test did not produce a report. Last output:'
        @($out) | Select-Object -Last 8 | ForEach-Object { Write-Log -Message ([string]$_) }
        return $false
    }
    $report = $line | ConvertFrom-Json
    foreach ($s in $report.steps) {
        $mem = ''
        if ($s.PSObject.Properties['peakMiB'] -and $null -ne $s.peakMiB) {
            $mem = " [GPU memory $($s.baselineMiB) -> peak $($s.peakMiB) -> released $($s.releasedMiB) MiB]"
        }
        if ($s.ok) { Write-Log -Level Ok -Message "$($s.name): $($s.detail)$mem" }
        else { Write-Log -Level Error -Message "$($s.name): $($s.detail)$mem" }
    }
    ($exit -eq 0) -and $report.ok
}

Export-ModuleMember -Function New-InstallFolders, Get-WorkerPackageDir, Install-NodeRuntime, Install-SevenZip,
    Install-WorkerFiles, Write-WorkerConfig, Install-OllamaRuntime, Invoke-WithOllamaServer,
    Test-OllamaModelPresent, Install-OllamaModel, Install-ComfyRuntime, Install-ImageModels, Invoke-LocalSelfTest
