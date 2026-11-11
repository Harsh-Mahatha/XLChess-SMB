# Pester 3.x tests for Service.psm1 / Power.psm1 pure logic and for every script in the installer.
Set-StrictMode -Version 2.0
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
foreach ($m in 'Common', 'Power', 'Download', 'Service') {
    Import-Module (Join-Path $root "lib\$m.psm1") -Force -DisableNameChecking
}

function New-TempDir {
    $d = Join-Path ([IO.Path]::GetTempPath()) ("xlw-test-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $d | Out-Null
    $d
}

Describe 'New-WinswXml' {
    $paths = Get-InstallPaths -ProgramPath 'C:\Program Files\XLChessWorker' -DataPath 'C:\ProgramData\XLChessWorker'
    $xmlText = New-WinswXml -Paths $paths
    $xml = [xml]$xmlText

    It 'is well-formed XML with the service id' { $xml.service.id | Should Be 'XLChessWorker' }
    It 'starts the bundled worker with the portable Node and the config file' {
        $xml.service.executable | Should Be 'C:\Program Files\XLChessWorker\node\node.exe'
        $xml.service.arguments | Should Match 'worker\.cjs'
        $xml.service.arguments | Should Match '--config'
    }
    It 'starts automatically at boot' { $xml.service.startmode | Should Be 'Automatic' }
    It 'restarts after 10, 30 and 60 seconds and resets the counter after a day' {
        $delays = @($xml.service.onfailure | ForEach-Object { $_.delay })
        ($delays -join ',') | Should Be '10 sec,30 sec,60 sec'
        @($xml.service.onfailure | ForEach-Object { $_.action } | Select-Object -Unique) | Should Be 'restart'
        $xml.service.resetfailure | Should Be '1 day'
    }
    It 'rolls its logs' {
        $xml.service.log.mode | Should Be 'roll-by-size'
        $xml.service.log.keepFiles | Should Be '14'
    }
    It 'escapes special characters in paths' {
        $p = Get-InstallPaths -ProgramPath 'C:\R&D <x>' -DataPath 'C:\D'
        $ok = $true
        try { [void]([xml](New-WinswXml -Paths $p)) } catch { $ok = $false }
        $ok | Should Be $true
    }
}

Describe 'Get-WatchdogDecision' {
    It 'does nothing when the service is not installed' {
        (Get-WatchdogDecision -ServiceStatus 'Missing' -HealthAgeSeconds $null -UptimeSeconds 0).Action | Should Be 'none'
    }
    It 'starts a stopped service' {
        (Get-WatchdogDecision -ServiceStatus 'Stopped' -HealthAgeSeconds $null).Action | Should Be 'start'
    }
    It 'waits while the service is starting or stopping' {
        (Get-WatchdogDecision -ServiceStatus 'StartPending' -HealthAgeSeconds $null).Action | Should Be 'none'
        (Get-WatchdogDecision -ServiceStatus 'StopPending' -HealthAgeSeconds $null).Action | Should Be 'none'
    }
    It 'leaves a freshly started service alone even without a heartbeat' {
        (Get-WatchdogDecision -ServiceStatus 'Running' -HealthAgeSeconds $null -UptimeSeconds 60).Action | Should Be 'none'
    }
    It 'restarts a running service that never wrote a heartbeat' {
        (Get-WatchdogDecision -ServiceStatus 'Running' -HealthAgeSeconds $null -UptimeSeconds 900).Action | Should Be 'restart'
    }
    It 'restarts a hung worker (heartbeat older than 3 minutes)' {
        $d = Get-WatchdogDecision -ServiceStatus 'Running' -HealthAgeSeconds 400 -UptimeSeconds 9000
        $d.Action | Should Be 'restart'
        $d.Reason | Should Match 'hung'
    }
    It 'does nothing for a healthy worker' {
        (Get-WatchdogDecision -ServiceStatus 'Running' -HealthAgeSeconds 20 -UptimeSeconds 9000).Action | Should Be 'none'
    }
}

Describe 'Get-HealthAgeSeconds' {
    It 'returns nothing when there is no health file' {
        $p = Get-InstallPaths -ProgramPath 'C:\nope\P' -DataPath 'C:\nope\D'
        Get-HealthAgeSeconds -Paths $p | Should BeNullOrEmpty
    }
    It 'measures the age from the "at" time in the file' {
        $d = New-TempDir
        $p = Get-InstallPaths -ProgramPath (Join-Path $d 'P') -DataPath (Join-Path $d 'D')
        $now = [DateTime]::Parse('2026-11-11T10:00:00Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        Write-JsonFile -Path $p.Health -Value ([ordered]@{ at = '2026-11-11T09:58:30.000Z'; version = '0.1.0' })
        [int](Get-HealthAgeSeconds -Paths $p -Now $now) | Should Be 90
        Remove-Item -Recurse -Force $d
    }
    It 'treats a corrupt file as no heartbeat' {
        $d = New-TempDir
        $p = Get-InstallPaths -ProgramPath (Join-Path $d 'P') -DataPath (Join-Path $d 'D')
        New-Item -ItemType Directory -Path (Split-Path $p.Health) -Force | Out-Null
        'not json' | Set-Content -LiteralPath $p.Health
        Get-HealthAgeSeconds -Paths $p | Should BeNullOrEmpty
        Remove-Item -Recurse -Force $d
    }
}

Describe 'ConvertTo-PowercfgMinutes' {
    It 'converts seconds to whole minutes, rounding up' {
        ConvertTo-PowercfgMinutes 1800 | Should Be 30
        ConvertTo-PowercfgMinutes 90 | Should Be 2
    }
    It 'keeps "never" as 0' { ConvertTo-PowercfgMinutes 0 | Should Be 0 }
    It 'passes through an unsupported setting' { ConvertTo-PowercfgMinutes $null | Should BeNullOrEmpty }
}

Describe 'Resolve-InstallPaths' {
    It 'reads a custom location from install.json' {
        $d = New-TempDir
        New-Item -ItemType Directory -Path (Join-Path $d 'prog\scripts') -Force | Out-Null
        Write-JsonFile -Path (Join-Path $d 'prog\install.json') -Value ([ordered]@{ programPath = (Join-Path $d 'prog'); dataPath = 'D:\Models' })
        $p = Resolve-InstallPaths -ScriptRoot (Join-Path $d 'prog\scripts')
        $p.Data | Should Be 'D:\Models'
        $p.Program | Should Be (Join-Path $d 'prog')
        Remove-Item -Recurse -Force $d
    }
    It 'falls back to the default locations' {
        $p = Resolve-InstallPaths -ScriptRoot 'C:\nope\none\scripts'
        $p.Data | Should Be (Join-Path $env:ProgramData 'XLChessWorker')
    }
}

Describe 'Register-Shortcuts' {
    It 'creates the restart and status shortcuts that run as administrator' {
        $d = New-TempDir
        $p = Get-InstallPaths -ProgramPath 'C:\Program Files\XLChessWorker' -DataPath 'C:\ProgramData\XLChessWorker'
        Register-Shortcuts -Paths $p -Folder $d
        $restart = Join-Path $d 'Restart XLChess Worker.lnk'
        $status = Join-Path $d 'XLChess Worker Status.lnk'
        Test-Path $restart | Should Be $true
        Test-Path $status | Should Be $true
        $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($restart)
        $lnk.Arguments | Should Match 'repair-xlchess-worker\.ps1'
        $lnk.Arguments | Should Match '-Restart'
        $bytes = [IO.File]::ReadAllBytes($restart)
        ($bytes[0x15] -band 0x20) | Should Be 0x20
        Remove-Item -Recurse -Force $d
    }
}

Describe 'Installer scripts' {
    $files = @(Get-ChildItem -Path $root -Recurse -Include *.ps1, *.psm1, *.cmd | Where-Object { $_.FullName -notmatch '\\tests\\' })
    It 'finds the scripts' { $files.Count | Should BeGreaterThan 8 }
    foreach ($f in $files) {
        It "parses without errors: $($f.Name)" {
            if ($f.Extension -eq '.cmd') { return }
            $errors = $null
            [void][Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errors)
            @($errors).Count | Should Be 0
        }
        It "is plain ASCII so Windows PowerShell 5.1 reads it correctly: $($f.Name)" {
            $bytes = [IO.File]::ReadAllBytes($f.FullName)
            @($bytes | Where-Object { $_ -gt 127 }).Count | Should Be 0
        }
    }
}
