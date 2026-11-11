# Pester 3.x tests for Pairing.psm1, including a real run of the bundled worker against a local mock API.
Set-StrictMode -Version 2.0
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
foreach ($m in 'Common', 'Pairing') {
    Import-Module (Join-Path $root "lib\$m.psm1") -Force -DisableNameChecking
}

function New-TempDir {
    $d = Join-Path ([IO.Path]::GetTempPath()) ("xlw-test-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $d | Out-Null
    $d
}

$bundle = Join-Path $root '..\apps\worker\bundle\worker.cjs'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$canRunWorker = (Test-Path $bundle) -and ($null -ne $node)

Describe 'Device token storage' {
    It 'round-trips through DPAPI' {
        $secret = 'tok_' + ('x' * 40)
        $enc = Protect-DeviceToken -Token $secret
        $enc | Should Not Match 'tok_'
        Unprotect-DeviceToken -Base64 $enc | Should Be $secret
    }
    It 'saves an encrypted file and never the plain token' {
        $d = New-TempDir
        $p = Get-InstallPaths -ProgramPath (Join-Path $d 'P') -DataPath (Join-Path $d 'D')
        Test-DeviceTokenPresent -Paths $p | Should Be $false
        Save-DeviceToken -Paths $p -Token 'tok_super_secret_value_123456'
        Test-DeviceTokenPresent -Paths $p | Should Be $true
        (Get-Content -LiteralPath $p.TokenFile -Raw) | Should Not Match 'super_secret'
        Unprotect-DeviceToken -Base64 (Get-Content -LiteralPath $p.TokenFile -Raw) | Should Be 'tok_super_secret_value_123456'
        Remove-Item -Recurse -Force $d
    }
}

Describe 'Pairing helpers' {
    It 'explains each server error in plain words' {
        Get-PairingAdvice -Code 'pairing_code_expired' -Message '' | Should Match '10 minutes'
        Get-PairingAdvice -Code 'pairing_code_used' -Message '' | Should Match 'already used'
        Get-PairingAdvice -Code 'network' -Message '' | Should Match 'could not be reached'
        Get-PairingAdvice -Code 'weird' -Message 'boom' | Should Match 'boom'
    }
    It 'only retries errors a new code can fix' {
        Test-PairingCodeRetryable -Code 'pairing_code_invalid' | Should Be $true
        Test-PairingCodeRetryable -Code 'network' | Should Be $false
    }
    It 'takes the last JSON result from mixed output' {
        $out = @('{"time":"x","level":"info","msg":"hello"}', '{"ok":false,"error":"a"}', '{"ok":true,"workerId":"w"}')
        (ConvertFrom-PairingOutput -Output $out).workerId | Should Be 'w'
    }
    It 'returns nothing when there is no result line' {
        ConvertFrom-PairingOutput -Output @('garbage') | Should BeNullOrEmpty
    }
}

Describe 'Invoke-WorkerPairing against a mock API' {
    function Start-MockApi {
        $port = Get-Random -Minimum 20000 -Maximum 40000
        $listener = New-Object Net.HttpListener
        $listener.Prefixes.Add("http://localhost:$port/")
        $listener.Start()
        $ps = [powershell]::Create()
        [void]$ps.AddScript({
                param($l)
                while ($l.IsListening) {
                    try { $ctx = $l.GetContext() } catch { break }
                    $reader = New-Object IO.StreamReader($ctx.Request.InputStream)
                    $body = $reader.ReadToEnd() | ConvertFrom-Json
                    if ($ctx.Request.Url.AbsolutePath -eq '/worker/v1/pair' -and $body.pairingCode -eq 'GOOD-CODE') {
                        $json = '{"workerId":"w_pester","deviceToken":"tok_pester_0123456789abcdef"}'
                        $ctx.Response.StatusCode = 200
                    } else {
                        $json = '{"error":{"code":"pairing_code_invalid","message":"not valid"}}'
                        $ctx.Response.StatusCode = 400
                    }
                    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
                    $ctx.Response.ContentType = 'application/json'
                    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                    $ctx.Response.Close()
                }
            }).AddArgument($listener)
        [void]$ps.BeginInvoke()
        [pscustomobject]@{ Port = $port; Listener = $listener; Ps = $ps }
    }
    function Stop-MockApi($m) { $m.Listener.Stop(); $m.Listener.Close(); $m.Ps.Dispose() }

    function New-WorkerPaths($dir, $port) {
        $p = Get-InstallPaths -ProgramPath (Join-Path $dir 'P') -DataPath (Join-Path $dir 'D')
        $p.NodeExe = $node.Source
        $p.WorkerJs = (Resolve-Path $bundle).Path
        Write-JsonFile -Path $p.Config -Value ([ordered]@{
                schemaVersion = 1; programDir = $p.Program; dataDir = $p.Data; apiUrl = "http://localhost:$port"
            })
        $p
    }

    It 'pairs with a good code and stores the token encrypted' -Skip:(-not $canRunWorker) {
        $d = New-TempDir
        $m = Start-MockApi
        try {
            $p = New-WorkerPaths $d $m.Port
            $id = Invoke-WorkerPairing -Paths $p -PairingCode 'GOOD-CODE'
            $id | Should Be 'w_pester'
            Unprotect-DeviceToken -Base64 (Get-Content -LiteralPath $p.TokenFile -Raw) | Should Be 'tok_pester_0123456789abcdef'
        } finally { Stop-MockApi $m; Remove-Item -Recurse -Force $d }
    }

    It 'asks again after a wrong code, then succeeds' -Skip:(-not $canRunWorker) {
        $d = New-TempDir
        $m = Start-MockApi
        try {
            $p = New-WorkerPaths $d $m.Port
            $script:asked = 0
            $reader = { $script:asked++; 'GOOD-CODE' }
            $id = Invoke-WorkerPairing -Paths $p -PairingCode 'WRONG' -ReadCode $reader
            $id | Should Be 'w_pester'
            $script:asked | Should Be 1
        } finally { Stop-MockApi $m; Remove-Item -Recurse -Force $d }
    }

    It 'gives up after three wrong codes and stores no token' -Skip:(-not $canRunWorker) {
        $d = New-TempDir
        $m = Start-MockApi
        try {
            $p = New-WorkerPaths $d $m.Port
            { Invoke-WorkerPairing -Paths $p -PairingCode 'BAD1' -ReadCode { 'BAD2' } } | Should Throw
            Test-DeviceTokenPresent -Paths $p | Should Be $false
        } finally { Stop-MockApi $m; Remove-Item -Recurse -Force $d }
    }
}
