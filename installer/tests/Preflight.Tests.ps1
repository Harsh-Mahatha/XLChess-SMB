# Pester tests for the preflight decision logic. Written for the Pester 3.x that ships with Windows PowerShell 5.1:
#   Invoke-Pester installer\tests
Set-StrictMode -Version 2.0
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here '..\lib\Common.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $here '..\lib\Power.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $here '..\lib\Preflight.psm1') -Force -DisableNameChecking

$manifest = Get-Manifest -Path (Join-Path $here '..\manifest.json')
$req = $manifest.requirements

Describe 'Compare-VersionString' {
    It 'orders driver versions numerically, not alphabetically' {
        Compare-VersionString '596.36' '560.76' | Should Be 1
        Compare-VersionString '560.76' '560.76' | Should Be 0
        Compare-VersionString '99.9' '560.76' | Should Be -1
    }
    It 'handles three-part versions' {
        Compare-VersionString '0.1.0' '0.1.1' | Should Be -1
        Compare-VersionString '1.0' '0.9.9' | Should Be 1
    }
}

Describe 'Get-ElevationCheck' {
    It 'passes when admin' { (Get-ElevationCheck -IsAdmin $true).Status | Should Be 'Pass' }
    It 'fails when not admin during an install' { (Get-ElevationCheck -IsAdmin $false).Status | Should Be 'Fail' }
    It 'only warns when not admin during -CheckOnly' {
        (Get-ElevationCheck -IsAdmin $false -CheckOnly $true).Status | Should Be 'Warn'
    }
}

Describe 'Get-OsCheck' {
    It 'passes Windows 11' { (Get-OsCheck -Build 26200 -Is64Bit $true -Requirements $req).Status | Should Be 'Pass' }
    It 'warns on Windows 10 22H2' { (Get-OsCheck -Build 19045 -Is64Bit $true -Requirements $req).Status | Should Be 'Warn' }
    It 'fails on older Windows 10' { (Get-OsCheck -Build 19044 -Is64Bit $true -Requirements $req).Status | Should Be 'Fail' }
    It 'fails on 32-bit' { (Get-OsCheck -Build 26200 -Is64Bit $false -Requirements $req).Status | Should Be 'Fail' }
}

Describe 'Get-GpuChecks' {
    $good = [pscustomobject]@{ Found = $true; Name = 'NVIDIA GeForce RTX 4070'; VramMiB = 12282; Driver = '572.16'; Count = 1 }
    It 'passes an RTX 4070 with a current driver' {
        $r = Get-GpuChecks -Gpu $good -Requirements $req
        $r[0].Status | Should Be 'Pass'
        $r[1].Status | Should Be 'Pass'
    }
    It 'fails a 6 GB card' {
        $gpu = [pscustomobject]@{ Found = $true; Name = 'RTX 4050 Laptop'; VramMiB = 6141; Driver = '596.36'; Count = 1 }
        (Get-GpuChecks -Gpu $gpu -Requirements $req)[0].Status | Should Be 'Fail'
    }
    It 'fails an old driver' {
        $gpu = [pscustomobject]@{ Found = $true; Name = 'RTX 4070'; VramMiB = 12282; Driver = '531.79'; Count = 1 }
        (Get-GpuChecks -Gpu $gpu -Requirements $req)[1].Status | Should Be 'Fail'
    }
    It 'fails when no NVIDIA GPU is found' {
        $gpu = [pscustomobject]@{ Found = $false; Name = $null; VramMiB = 0; Driver = '0'; Count = 0 }
        $r = Get-GpuChecks -Gpu $gpu -Requirements $req
        $r[0].Status | Should Be 'Fail'
        $r[1].Status | Should Be 'Fail'
    }
}

Describe 'Get-RamCheck' {
    It 'passes 64 GB (reported as 63.8)' { (Get-RamCheck -TotalGB 63.8 -Requirements $req).Status | Should Be 'Pass' }
    It 'warns between 15 and 60 GB' { (Get-RamCheck -TotalGB 32 -Requirements $req).Status | Should Be 'Warn' }
    It 'accepts a nominal 16 GB PC (reported as 15.8)' { (Get-RamCheck -TotalGB 15.8 -Requirements $req).Status | Should Be 'Warn' }
    It 'fails below 15 GB' { (Get-RamCheck -TotalGB 8 -Requirements $req).Status | Should Be 'Fail' }
}

Describe 'Get-DiskCheck' {
    It 'passes with enough space plus headroom' {
        $v = @([pscustomobject]@{ Root = 'C:\'; FreeBytes = 100GB; NeededBytes = 40GB })
        (Get-DiskCheck -Volumes $v -Requirements $req).Status | Should Be 'Pass'
    }
    It 'fails when headroom would be eaten' {
        $v = @([pscustomobject]@{ Root = 'C:\'; FreeBytes = 45GB; NeededBytes = 40GB })
        (Get-DiskCheck -Volumes $v -Requirements $req).Status | Should Be 'Fail'
    }
    It 'names the drive that is short' {
        $v = @(
            [pscustomobject]@{ Root = 'C:\'; FreeBytes = 100GB; NeededBytes = 5GB },
            [pscustomobject]@{ Root = 'D:\'; FreeBytes = 1GB; NeededBytes = 40GB })
        $r = Get-DiskCheck -Volumes $v -Requirements $req
        $r.Status | Should Be 'Fail'
        $r.Message | Should Match 'D:\\'
    }
}

Describe 'Get-VolumeRequirement' {
    It 'uses one entry when both folders share a drive' {
        $paths = Get-InstallPaths -ProgramPath 'C:\Program Files\X' -DataPath 'C:\ProgramData\X'
        @(Get-VolumeRequirement -Manifest $manifest -Paths $paths).Count | Should Be 1
    }
    It 'splits across drives when -DataPath is elsewhere' {
        $paths = Get-InstallPaths -ProgramPath 'C:\Program Files\X' -DataPath 'D:\X'
        @(Get-VolumeRequirement -Manifest $manifest -Paths $paths).Count | Should Be 2
    }
}

Describe 'Get-NetworkCheck and Get-ApiCheck' {
    It 'passes when every host is reachable' {
        $h = @([pscustomobject]@{ Host = 'a.com'; Reachable = $true; Error = $null })
        (Get-NetworkCheck -Hosts $h).Status | Should Be 'Pass'
    }
    It 'names the unreachable host' {
        $h = @(
            [pscustomobject]@{ Host = 'a.com'; Reachable = $true; Error = $null },
            [pscustomobject]@{ Host = 'huggingface.co'; Reachable = $false; Error = 'timed out' })
        $r = Get-NetworkCheck -Hosts $h
        $r.Status | Should Be 'Fail'
        $r.Message | Should Match 'huggingface.co'
    }
    It 'warns when no API url was given' { (Get-ApiCheck -Api $null).Status | Should Be 'Warn' }
    It 'fails when the API is down' {
        (Get-ApiCheck -Api ([pscustomobject]@{ Url = 'https://x'; Reachable = $false; Error = 'boom' })).Status | Should Be 'Fail'
    }
}

Describe 'Get-PortCheck' {
    It 'passes when nothing listens' { (Get-PortCheck -InUse @()).Status | Should Be 'Pass' }
    It 'fails when a foreign program holds a port' {
        $p = @([pscustomobject]@{ Port = 11434; ProcessName = 'ollama'; Path = 'C:\Users\x\AppData\Local\Programs\Ollama\ollama.exe' })
        $r = Get-PortCheck -InUse $p -OwnedPathPrefixes @('C:\Program Files\XLChessWorker')
        $r.Status | Should Be 'Fail'
        $r.Message | Should Match 'ollama'
    }
    It 'allows our own runtime on its port' {
        $p = @([pscustomobject]@{ Port = 11434; ProcessName = 'ollama'; Path = 'C:\Program Files\XLChessWorker\ollama\ollama.exe' })
        (Get-PortCheck -InUse $p -OwnedPathPrefixes @('C:\Program Files\XLChessWorker')).Status | Should Be 'Pass'
    }
}

Describe 'Get-ExistingInstallCheck' {
    $steps = @('a', 'b')
    function New-State($version, $done) {
        $s = [pscustomobject]@{ schemaVersion = 1; installerVersion = $version; steps = [pscustomobject]@{} }
        foreach ($d in $done) { $s.steps | Add-Member -NotePropertyName $d -NotePropertyValue ([pscustomobject]@{ status = 'done' }) }
        $s
    }
    It 'passes on a clean PC' { (Get-ExistingInstallCheck -State $null -NewVersion '0.1.0' -ExpectedSteps $steps).Status | Should Be 'Pass' }
    It 'fails when a newer version is installed' {
        (Get-ExistingInstallCheck -State (New-State '0.2.0' @('a', 'b')) -NewVersion '0.1.0' -ExpectedSteps $steps).Status | Should Be 'Fail'
    }
    It 'warns about a partial install' {
        (Get-ExistingInstallCheck -State (New-State '0.1.0' @('a')) -NewVersion '0.1.0' -ExpectedSteps $steps).Status | Should Be 'Warn'
    }
    It 'passes an update of a complete older install' {
        (Get-ExistingInstallCheck -State (New-State '0.0.9' @('a', 'b')) -NewVersion '0.1.0' -ExpectedSteps $steps).Status | Should Be 'Pass'
    }
}

Describe 'Get-PreflightExitCode' {
    It 'is 0 with only passes and warnings' {
        $r = @((New-CheckResult 'a' 'Pass' 'x'), (New-CheckResult 'b' 'Warn' 'y'))
        Get-PreflightExitCode -Results $r | Should Be 0
    }
    It 'is 1 with any failure' {
        $r = @((New-CheckResult 'a' 'Pass' 'x'), (New-CheckResult 'b' 'Fail' 'y'))
        Get-PreflightExitCode -Results $r | Should Be 1
    }
}
