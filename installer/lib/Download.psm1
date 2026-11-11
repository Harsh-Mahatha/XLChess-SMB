# Resumable, hash-verified downloads and archive extraction.
# Every file the installer fetches goes through Invoke-VerifiedDownload: it is only accepted when its SHA-256
# matches the pinned value in manifest.json (docs/installer-v1-plan.md section 2, "Integrity").
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only.

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'Common.psm1')

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-FileHash {
    <# True when the file exists and its SHA-256 equals $Sha256. #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Sha256)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    (Get-Sha256 -Path $Path) -eq $Sha256.ToLowerInvariant()
}

function Receive-FileResumable {
    <#
    .SYNOPSIS Downloads $Url into $PartPath, continuing from whatever is already there.
    Returns when the server has sent everything. Throws on network errors (the caller retries).
    #>
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$PartPath,
        [double]$ExpectedBytes = 0,
        [string]$Label = ''
    )
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

    $existing = 0L
    if (Test-Path -LiteralPath $PartPath) { $existing = (Get-Item -LiteralPath $PartPath).Length }
    if ($ExpectedBytes -gt 0 -and $existing -gt $ExpectedBytes) {
        Remove-Item -LiteralPath $PartPath -Force
        $existing = 0L
    }
    if ($ExpectedBytes -gt 0 -and $existing -eq [long]$ExpectedBytes) { return }   # already complete

    $req = [Net.HttpWebRequest]::Create($Url)
    $req.UserAgent = 'XLChessWorkerInstaller/1.0'
    $req.AllowAutoRedirect = $true
    $req.Timeout = 30000
    $req.ReadWriteTimeout = 60000
    if ($existing -gt 0) { $req.AddRange([long]$existing) }

    try {
        $resp = $req.GetResponse()
    } catch [Net.WebException] {
        $r = $_.Exception.Response
        if ($r -and [int]$r.StatusCode -eq 416) {
            # Range not satisfiable: our partial file is not usable. Start again next attempt.
            Remove-Item -LiteralPath $PartPath -Force -ErrorAction SilentlyContinue
        }
        throw
    }

    try {
        $append = ([int]$resp.StatusCode -eq 206)
        if (-not $append) { $existing = 0L }   # server ignored the range: it is sending the whole file
        $mode = $(if ($append) { [IO.FileMode]::Append } else { [IO.FileMode]::Create })
        $total = $(if ($ExpectedBytes -gt 0) { [double]$ExpectedBytes } else { [double]($existing + $resp.ContentLength) })
        $in = $resp.GetResponseStream()
        $out = New-Object IO.FileStream($PartPath, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None, 1MB)
        try {
            $buf = New-Object byte[] (1MB)
            $done = [double]$existing
            $nextReport = 10
            $sw = [Diagnostics.Stopwatch]::StartNew()
            if ($existing -gt 0) { Write-Log -Message "Resuming $Label at $(Format-Bytes $existing)" }
            while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                $out.Write($buf, 0, $n)
                $done += $n
                if ($total -gt 0) {
                    $pct = [int](100 * $done / $total)
                    if ($pct -ge $nextReport) {
                        $rate = $(if ($sw.Elapsed.TotalSeconds -gt 0) { ($done - $existing) / $sw.Elapsed.TotalSeconds } else { 0 })
                        Write-Log -Message ("{0} {1}% ({2} of {3}, {4}/s)" -f $Label, $pct, (Format-Bytes $done), (Format-Bytes $total), (Format-Bytes $rate))
                        $nextReport = (([int]($pct / 10)) + 1) * 10
                    }
                }
            }
        } finally {
            $out.Dispose()
            $in.Dispose()
        }
    } finally {
        $resp.Close()
    }
}

function Invoke-VerifiedDownload {
    <#
    .SYNOPSIS Downloads $Url to $Destination and accepts it only if its SHA-256 matches. Resumes partial files.
    .DESCRIPTION
        - If $Destination already has the right hash, nothing is downloaded.
        - Otherwise the data goes to "$Destination.part"; the file is renamed only after the hash matches.
        - A wrong hash deletes the partial file and tries again; after $Retries attempts it throws.
    #>
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$Sha256,
        [double]$SizeBytes = 0,
        [int]$Retries = 3,
        [int]$RetryDelaySeconds = 5,
        [string]$Label = ''
    )
    if (-not $Label) { $Label = Split-Path -Leaf $Destination }
    if (Test-FileHash -Path $Destination -Sha256 $Sha256) {
        Write-Log -Message "$Label is already downloaded and verified."
        return
    }
    $dir = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $part = "$Destination.part"
    $lastError = $null

    for ($attempt = 1; $attempt -le $Retries; $attempt++) {
        try {
            Write-Log -Message "Downloading $Label$(if ($SizeBytes -gt 0) { " ($(Format-Bytes $SizeBytes))" })"
            Receive-FileResumable -Url $Url -PartPath $part -ExpectedBytes $SizeBytes -Label $Label
            Write-Log -Message "Verifying $Label"
            $actual = Get-Sha256 -Path $part
            if ($actual -ne $Sha256.ToLowerInvariant()) {
                Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
                throw "Checksum mismatch for $Label (expected $Sha256, got $actual)."
            }
            if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
            Move-Item -LiteralPath $part -Destination $Destination
            Write-Log -Level Ok -Message "$Label verified."
            return
        } catch {
            $lastError = $_.Exception.Message
            Write-Log -Level Warn -Message "Attempt $attempt of $Retries failed for ${Label}: $lastError"
            if ($attempt -lt $Retries) { Start-Sleep -Seconds ($RetryDelaySeconds * $attempt) }
        }
    }
    throw "Could not download $Label after $Retries attempts. Last error: $lastError"
}

function Expand-ZipArchive {
    param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (-not (Test-Path -LiteralPath $Destination)) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null }
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
}

function Expand-SevenZipArchive {
    param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Destination, [Parameter(Mandatory)][string]$SevenZipExe)
    if (-not (Test-Path -LiteralPath $Destination)) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null }
    $output = & $SevenZipExe x $Archive "-o$Destination" -y -bso0 -bsp0 2>&1
    if ($LASTEXITCODE -ne 0) { throw "7-Zip failed to extract $Archive (exit code $LASTEXITCODE): $output" }
}

function Get-ComponentMarker {
    param([Parameter(Mandatory)][string]$Directory)
    $f = Join-Path $Directory '.xlw-installed'
    if (Test-Path -LiteralPath $f) { return (Get-Content -LiteralPath $f -Raw).Trim() }
    $null
}

function Install-ArchiveComponent {
    <#
    .SYNOPSIS Downloads a pinned archive and unpacks it into $Destination, once per version.
    .PARAMETER Component the manifest entry (version, url, sha256, sizeBytes, archiveRoot).
    .PARAMETER Preserve paths (relative to $Destination) carried over from an older version, such as model folders.
    .DESCRIPTION
        Extraction goes to a temporary sibling folder and is swapped in at the end, so an interrupted
        install never leaves a half-unpacked program. A marker file records the installed version + hash.
    #>
    param(
        [Parameter(Mandatory)]$Component,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$DownloadDir,
        [Parameter(Mandatory)][string]$Destination,
        [string]$SevenZipExe,
        [string[]]$Preserve = @(),
        [string]$MustExist
    )
    $marker = "$($Component.version)|$($Component.sha256)"
    $installed = Get-ComponentMarker -Directory $Destination
    $present = (-not $MustExist) -or (Test-Path -LiteralPath (Join-Path $Destination $MustExist))
    if ($installed -eq $marker -and $present) {
        Write-Log -Message "$Name $($Component.version) is already installed."
        return
    }

    $ext = [IO.Path]::GetExtension(([uri]$Component.url).AbsolutePath)
    $archive = Join-Path $DownloadDir "$Name-$($Component.version)$ext"
    Invoke-VerifiedDownload -Url $Component.url -Destination $archive -Sha256 $Component.sha256 `
        -SizeBytes $Component.sizeBytes -Label "$Name $($Component.version)"

    $staging = "$Destination.new"
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    $raw = "$Destination.raw"
    if (Test-Path -LiteralPath $raw) { Remove-Item -LiteralPath $raw -Recurse -Force }

    Write-Log -Message "Unpacking $Name"
    if ($ext -eq '.zip') { Expand-ZipArchive -Archive $archive -Destination $raw }
    elseif ($ext -eq '.7z') { Expand-SevenZipArchive -Archive $archive -Destination $raw -SevenZipExe $SevenZipExe }
    else { throw "Unsupported archive type '$ext' for $Name" }

    $root = $raw
    if ($Component.PSObject.Properties['archiveRoot'] -and $Component.archiveRoot) {
        $root = Join-Path $raw $Component.archiveRoot
        if (-not (Test-Path -LiteralPath $root)) { throw "$Name archive does not contain the expected folder '$($Component.archiveRoot)'." }
    }
    Move-Item -LiteralPath $root -Destination $staging
    if (Test-Path -LiteralPath $raw) { Remove-Item -LiteralPath $raw -Recurse -Force }

    foreach ($rel in $Preserve) {
        $old = Join-Path $Destination $rel
        if (Test-Path -LiteralPath $old) {
            $new = Join-Path $staging $rel
            if (Test-Path -LiteralPath $new) { Remove-Item -LiteralPath $new -Recurse -Force }
            $newParent = Split-Path -Parent $new
            if (-not (Test-Path -LiteralPath $newParent)) { New-Item -ItemType Directory -Path $newParent -Force | Out-Null }
            Move-Item -LiteralPath $old -Destination $new
        }
    }

    [IO.File]::WriteAllText((Join-Path $staging '.xlw-installed'), $marker)
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    Move-Item -LiteralPath $staging -Destination $Destination
    Write-Log -Level Ok -Message "$Name $($Component.version) installed."
}

Export-ModuleMember -Function Get-Sha256, Test-FileHash, Receive-FileResumable, Invoke-VerifiedDownload,
    Expand-ZipArchive, Expand-SevenZipArchive, Get-ComponentMarker, Install-ArchiveComponent
