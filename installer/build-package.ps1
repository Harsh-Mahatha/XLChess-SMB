<#
.SYNOPSIS
    Builds the installer package (xlchess-worker-<version>.zip) that is given to the PC owner.
    Developer tool: run from the repository (npm run installer:package).

.DESCRIPTION
    Bundles the worker, copies the installer scripts and manifest next to it, checks the versions agree,
    zips the result and writes a SHA-256 file. The package contains no secrets and no model files; the
    installer downloads those on the PC, checking each against manifest.json.
#>
[CmdletBinding()]
param(
    [string]$OutDir,
    [switch]$SkipBundle
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$installerRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $installerRoot
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'dist\installer' }

$manifest = Get-Content -LiteralPath (Join-Path $installerRoot 'manifest.json') -Raw | ConvertFrom-Json
$workerPkg = Get-Content -LiteralPath (Join-Path $repoRoot 'apps\worker\package.json') -Raw | ConvertFrom-Json
if ($manifest.installerVersion -ne $workerPkg.version) {
    throw "Version mismatch: installer manifest says $($manifest.installerVersion) but apps/worker/package.json says $($workerPkg.version). Make them equal before packaging."
}
$version = [string]$manifest.installerVersion

if (-not $SkipBundle) {
    Write-Host 'Bundling the worker...'
    Push-Location $repoRoot
    try {
        & npm.cmd run bundle -w '@smb/worker'
        if ($LASTEXITCODE -ne 0) { throw 'npm run bundle failed.' }
    } finally { Pop-Location }
}
$bundle = Join-Path $repoRoot 'apps\worker\bundle'
if (-not (Test-Path -LiteralPath (Join-Path $bundle 'worker.cjs'))) { throw "worker.cjs not found in $bundle. Run without -SkipBundle." }

$name = "xlchess-worker-$version"
$stage = Join-Path $OutDir $name
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage, (Join-Path $stage 'lib'), (Join-Path $stage 'worker') -Force | Out-Null

foreach ($f in 'install.cmd', 'setup-xlchess-worker.ps1', 'diagnose-xlchess-worker.ps1', 'repair-xlchess-worker.ps1',
    'uninstall-xlchess-worker.ps1', 'watchdog-xlchess-worker.ps1', 'manifest.json') {
    Copy-Item -LiteralPath (Join-Path $installerRoot $f) -Destination (Join-Path $stage $f)
}
Copy-Item -Path (Join-Path $installerRoot 'lib\*.psm1') -Destination (Join-Path $stage 'lib')
Copy-Item -LiteralPath (Join-Path $bundle 'worker.cjs') -Destination (Join-Path $stage 'worker\worker.cjs')
Copy-Item -LiteralPath (Join-Path $bundle 'worker.cjs.map') -Destination (Join-Path $stage 'worker\worker.cjs.map') -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $bundle 'workflows') -Destination (Join-Path $stage 'worker\workflows') -Recurse

@"
XLChess worker installer $version

1. Copy this folder to the PC (or unzip it there).
2. Double-click install.cmd. Allow the administrator prompt.
3. Type the pairing code the XLChess admin gives you when asked.

Setup downloads the AI models (a large download) and can take a while. If it stops, run install.cmd again:
finished steps are not repeated.

To check the PC without installing anything:  install.cmd -CheckOnly
"@ | Set-Content -LiteralPath (Join-Path $stage 'README.txt') -Encoding ASCII

$zip = Join-Path $OutDir "$name.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash *$name.zip" | Set-Content -LiteralPath "$zip.sha256" -Encoding ASCII

Write-Host ''
Write-Host "Package: $zip"
Write-Host "SHA-256: $hash"
Write-Host ("Size:    {0:N1} MB" -f ((Get-Item -LiteralPath $zip).Length / 1MB))
