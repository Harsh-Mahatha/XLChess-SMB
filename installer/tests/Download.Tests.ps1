# Pester 3.x tests for Download.psm1, run against a throwaway HTTP server on localhost.
Set-StrictMode -Version 2.0
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here '..\lib\Common.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $here '..\lib\Download.psm1') -Force -DisableNameChecking

function New-TempDir {
    $d = Join-Path ([IO.Path]::GetTempPath()) ("xlw-test-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $d | Out-Null
    $d
}

# A tiny HTTP server in a background runspace. $Mode: 'range' honours Range, 'norange' always sends the full body.
# It records every Range header it sees in $Log (a synchronized list).
function Start-TestServer {
    param([byte[]]$Payload, [string]$Mode = 'range')
    $port = Get-Random -Minimum 20000 -Maximum 40000
    $log = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
    $listener = New-Object Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$port/")
    $listener.Start()
    $ps = [powershell]::Create()
    [void]$ps.AddScript({
            param($l, $payload, $mode, $log)
            while ($l.IsListening) {
                try { $ctx = $l.GetContext() } catch { break }
                $req = $ctx.Request; $res = $ctx.Response
                $range = $req.Headers['Range']
                [void]$log.Add([string]$range)
                $start = 0
                if ($range -and $mode -eq 'range' -and $range -match 'bytes=(\d+)-') {
                    $start = [int]$Matches[1]
                    if ($start -ge $payload.Length) { $res.StatusCode = 416; $res.Close(); continue }
                    $res.StatusCode = 206
                    $res.AddHeader('Content-Range', "bytes $start-$($payload.Length - 1)/$($payload.Length)")
                }
                $len = $payload.Length - $start
                $res.ContentLength64 = $len
                $res.OutputStream.Write($payload, $start, $len)
                $res.OutputStream.Close()
            }
        }).AddArgument($listener).AddArgument($Payload).AddArgument($Mode).AddArgument($log)
    $handle = $ps.BeginInvoke()
    [pscustomobject]@{ Url = "http://localhost:$port/file.bin"; Port = $port; Log = $log; Ps = $ps; Handle = $handle; Listener = $listener }
}

function Stop-TestServer {
    param($Server)
    $Server.Listener.Stop()
    $Server.Listener.Close()
    $Server.Ps.Dispose()
}

function New-Payload {
    param([int]$Size = 3MB)
    $b = New-Object byte[] $Size
    (New-Object Random 42).NextBytes($b)
    , $b
}

function Get-BytesSha256 {
    param([byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    ([BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '').ToLowerInvariant()
}

Describe 'Invoke-VerifiedDownload' {
    $payload = New-Payload
    $hash = Get-BytesSha256 $payload

    It 'downloads a file and accepts a matching checksum' {
        $d = New-TempDir
        $s = Start-TestServer -Payload $payload
        try {
            $dest = Join-Path $d 'a.bin'
            Invoke-VerifiedDownload -Url $s.Url -Destination $dest -Sha256 $hash -SizeBytes $payload.Length -RetryDelaySeconds 0
            Test-FileHash -Path $dest -Sha256 $hash | Should Be $true
            Test-Path "$dest.part" | Should Be $false
        } finally { Stop-TestServer $s; Remove-Item -Recurse -Force $d }
    }

    It 'resumes a partial file with a Range request instead of starting over' {
        $d = New-TempDir
        $s = Start-TestServer -Payload $payload
        try {
            $dest = Join-Path $d 'b.bin'
            $half = [int]($payload.Length / 2)
            [IO.File]::WriteAllBytes("$dest.part", $payload[0..($half - 1)])
            Invoke-VerifiedDownload -Url $s.Url -Destination $dest -Sha256 $hash -SizeBytes $payload.Length -RetryDelaySeconds 0
            Test-FileHash -Path $dest -Sha256 $hash | Should Be $true
            $s.Log[0] | Should Be "bytes=$half-"
        } finally { Stop-TestServer $s; Remove-Item -Recurse -Force $d }
    }

    It 'restarts cleanly when the server ignores the Range header' {
        $d = New-TempDir
        $s = Start-TestServer -Payload $payload -Mode 'norange'
        try {
            $dest = Join-Path $d 'c.bin'
            [IO.File]::WriteAllBytes("$dest.part", $payload[0..999])
            Invoke-VerifiedDownload -Url $s.Url -Destination $dest -Sha256 $hash -SizeBytes $payload.Length -RetryDelaySeconds 0
            Test-FileHash -Path $dest -Sha256 $hash | Should Be $true
        } finally { Stop-TestServer $s; Remove-Item -Recurse -Force $d }
    }

    It 'does not download again when the file is already verified' {
        $d = New-TempDir
        $s = Start-TestServer -Payload $payload
        try {
            $dest = Join-Path $d 'd.bin'
            [IO.File]::WriteAllBytes($dest, $payload)
            Invoke-VerifiedDownload -Url $s.Url -Destination $dest -Sha256 $hash -SizeBytes $payload.Length -RetryDelaySeconds 0
            $s.Log.Count | Should Be 0
        } finally { Stop-TestServer $s; Remove-Item -Recurse -Force $d }
    }

    It 'rejects a wrong checksum, deletes the bad data and throws' {
        $d = New-TempDir
        $s = Start-TestServer -Payload $payload
        try {
            $dest = Join-Path $d 'e.bin'
            $bad = ('0' * 64)
            { Invoke-VerifiedDownload -Url $s.Url -Destination $dest -Sha256 $bad -SizeBytes $payload.Length -Retries 2 -RetryDelaySeconds 0 } |
                Should Throw
            Test-Path $dest | Should Be $false
            Test-Path "$dest.part" | Should Be $false
        } finally { Stop-TestServer $s; Remove-Item -Recurse -Force $d }
    }
}

Describe 'Install-ArchiveComponent' {
    function New-TestZip {
        param([string]$Dir)
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $src = Join-Path $Dir 'src\toolroot'
        New-Item -ItemType Directory -Path $src -Force | Out-Null
        'hello' | Set-Content -LiteralPath (Join-Path $src 'tool.txt')
        $zip = Join-Path $Dir 'tool.zip'
        [IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $Dir 'src'), $zip)
        $zip
    }

    It 'unpacks into the destination, strips the archive root and writes a version marker' {
        $d = New-TempDir
        $zip = New-TestZip -Dir $d
        $bytes = [IO.File]::ReadAllBytes($zip)
        $s = Start-TestServer -Payload $bytes
        try {
            $comp = [pscustomobject]@{ version = '1.0'; url = $s.Url.Replace('file.bin', 'tool.zip'); sha256 = (Get-BytesSha256 $bytes); sizeBytes = $bytes.Length; archiveRoot = 'toolroot' }
            $dest = Join-Path $d 'out'
            Install-ArchiveComponent -Component $comp -Name 'tool' -DownloadDir (Join-Path $d 'dl') -Destination $dest
            Test-Path (Join-Path $dest 'tool.txt') | Should Be $true
            Get-ComponentMarker -Directory $dest | Should Be "1.0|$($comp.sha256)"
            Test-Path "$dest.new" | Should Be $false
        } finally { Stop-TestServer $s; Remove-Item -Recurse -Force $d }
    }

    It 'skips the download when the same version is already installed' {
        $d = New-TempDir
        $zip = New-TestZip -Dir $d
        $bytes = [IO.File]::ReadAllBytes($zip)
        $s = Start-TestServer -Payload $bytes
        try {
            $comp = [pscustomobject]@{ version = '1.0'; url = $s.Url.Replace('file.bin', 'tool.zip'); sha256 = (Get-BytesSha256 $bytes); sizeBytes = $bytes.Length; archiveRoot = 'toolroot' }
            $dest = Join-Path $d 'out'
            Install-ArchiveComponent -Component $comp -Name 'tool' -DownloadDir (Join-Path $d 'dl') -Destination $dest
            $before = $s.Log.Count
            Install-ArchiveComponent -Component $comp -Name 'tool' -DownloadDir (Join-Path $d 'dl') -Destination $dest
            $s.Log.Count | Should Be $before
        } finally { Stop-TestServer $s; Remove-Item -Recurse -Force $d }
    }

    It 'keeps preserved folders (such as models) when a new version replaces the old one' {
        $d = New-TempDir
        $zip = New-TestZip -Dir $d
        $bytes = [IO.File]::ReadAllBytes($zip)
        $s = Start-TestServer -Payload $bytes
        try {
            $comp = [pscustomobject]@{ version = '2.0'; url = $s.Url.Replace('file.bin', 'tool.zip'); sha256 = (Get-BytesSha256 $bytes); sizeBytes = $bytes.Length; archiveRoot = 'toolroot' }
            $dest = Join-Path $d 'out'
            New-Item -ItemType Directory -Path (Join-Path $dest 'models') -Force | Out-Null
            'weights' | Set-Content -LiteralPath (Join-Path $dest 'models\w.bin')
            [IO.File]::WriteAllText((Join-Path $dest '.xlw-installed'), '1.0|old')
            Install-ArchiveComponent -Component $comp -Name 'tool' -DownloadDir (Join-Path $d 'dl') -Destination $dest -Preserve @('models')
            Test-Path (Join-Path $dest 'models\w.bin') | Should Be $true
            Test-Path (Join-Path $dest 'tool.txt') | Should Be $true
            (Get-ComponentMarker -Directory $dest).StartsWith('2.0|') | Should Be $true
        } finally { Stop-TestServer $s; Remove-Item -Recurse -Force $d }
    }
}
