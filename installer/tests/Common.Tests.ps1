# Pester 3.x tests for Common.psm1 and Power.psm1.
Set-StrictMode -Version 2.0
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here '..\lib\Common.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $here '..\lib\Power.psm1') -Force -DisableNameChecking

function New-TempDir {
    $d = Join-Path ([IO.Path]::GetTempPath()) ("xlw-test-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $d | Out-Null
    $d
}

Describe 'Get-Manifest' {
    $manifestPath = Join-Path $here '..\manifest.json'
    It 'loads the shipped manifest' { (Get-Manifest -Path $manifestPath).schemaVersion | Should Be 1 }
    It 'has a 64-hex SHA-256 and a size for every download' {
        $m = Get-Manifest -Path $manifestPath
        $items = @()
        foreach ($n in 'node', 'sevenZip', 'winsw', 'ollama', 'comfyui') { $items += $m.components.$n }
        $items += @($m.models.llm.blobs)
        $items += @($m.models.image.files)
        foreach ($i in $items) {
            $i.sha256 | Should Match '^[0-9a-f]{64}$'
            ([double]$i.sizeBytes) | Should BeGreaterThan 0
        }
    }
    It 'pins every Hugging Face file to a commit, not a branch' {
        $m = Get-Manifest -Path $manifestPath
        $m.models.image.revision | Should Match '^[0-9a-f]{40}$'
    }
    It 'only downloads over https' {
        $m = Get-Manifest -Path $manifestPath
        foreach ($n in 'node', 'sevenZip', 'winsw', 'ollama', 'comfyui') { $m.components.$n.url | Should Match '^https://' }
    }
    It 'adds up the download total' {
        $m = Get-Manifest -Path $manifestPath
        (Get-ManifestDownloadBytes -Manifest $m) | Should BeGreaterThan 25GB
    }
    It 'rejects an unknown schema version' {
        $d = New-TempDir
        '{"schemaVersion": 99}' | Set-Content -LiteralPath (Join-Path $d 'm.json')
        { Get-Manifest -Path (Join-Path $d 'm.json') } | Should Throw
        Remove-Item -Recurse -Force $d
    }
}

Describe 'Get-InstallPaths' {
    $p = Get-InstallPaths -ProgramPath 'C:\P' -DataPath 'C:\D'
    It 'puts binaries under the program path' { $p.NodeExe | Should Be 'C:\P\node\node.exe' }
    It 'puts models and secrets under the data path' {
        $p.OllamaModels | Should Be 'C:\D\models\ollama'
        $p.TokenFile | Should Be 'C:\D\secrets\device-token.bin'
    }
}

Describe 'JSON helpers' {
    It 'writes JSON without a byte-order mark so Node.js can read it' {
        $d = New-TempDir
        $f = Join-Path $d 'config.json'
        Write-JsonFile -Path $f -Value ([ordered]@{ apiUrl = 'https://x'; n = 1 })
        $bytes = [IO.File]::ReadAllBytes($f)
        $bytes[0] | Should Be ([byte][char]'{')
        (Read-JsonFile -Path $f).apiUrl | Should Be 'https://x'
        Remove-Item -Recurse -Force $d
    }
    It 'reads a file that has a BOM' {
        $d = New-TempDir
        $f = Join-Path $d 'bom.json'
        [IO.File]::WriteAllText($f, '{"a":1}', (New-Object Text.UTF8Encoding($true)))
        (Read-JsonFile -Path $f).a | Should Be 1
        Remove-Item -Recurse -Force $d
    }
}

Describe 'Install state' {
    It 'records, saves and reloads step results' {
        $d = New-TempDir
        $paths = Get-InstallPaths -ProgramPath (Join-Path $d 'p') -DataPath (Join-Path $d 'd')
        $state = Get-InstallState -Paths $paths
        Test-StepDone -State $state -Step 'node' | Should Be $false
        Set-StepResult -State $state -Step 'node' -Status done
        Set-StepResult -State $state -Step 'ollama' -Status failed -Detail 'boom'
        $state.installerVersion = '0.1.0'
        Save-InstallState -Paths $paths -State $state

        $again = Get-InstallState -Paths $paths
        Test-StepDone -State $again -Step 'node' | Should Be $true
        Test-StepDone -State $again -Step 'ollama' | Should Be $false
        $again.steps.ollama.detail | Should Be 'boom'
        Remove-Item -Recurse -Force $d
    }
    It 'replaces an earlier result for the same step' {
        $state = [pscustomobject]@{ schemaVersion = 1; installerVersion = $null; steps = [pscustomobject]@{} }
        Set-StepResult -State $state -Step 'x' -Status failed
        Set-StepResult -State $state -Step 'x' -Status done
        Test-StepDone -State $state -Step 'x' | Should Be $true
    }
    It 'can clear a step so it runs again' {
        $state = [pscustomobject]@{ schemaVersion = 1; installerVersion = $null; steps = [pscustomobject]@{} }
        Set-StepResult -State $state -Step 'x' -Status done
        Reset-StepResult -State $state -Step 'x'
        Test-StepDone -State $state -Step 'x' | Should Be $false
    }
}

Describe 'Format-Bytes' {
    It 'formats sizes' {
        Format-Bytes 512 | Should Be '512 B'
        Format-Bytes (5.5 * 1GB) | Should Match '^5[.,]5 GB$'
    }
}

Describe 'ConvertFrom-PowercfgQuery' {
    It 'reads AC and DC from the last two hex values regardless of language' {
        $text = @"
  Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (anything)
    Minimum Possible Setting: 0x00000000
    Maximum Possible Setting: 0xffffffff
    Possible Settings increment: 0x00000001
    Current AC Power Setting Index: 0x00000708
    Current DC Power Setting Index: 0x000002d0
"@
        $r = ConvertFrom-PowercfgQuery -Text $text
        $r.Ac | Should Be 1800
        $r.Dc | Should Be 720
    }
    It 'returns nothing for unparseable text' { ConvertFrom-PowercfgQuery -Text 'nope' | Should BeNullOrEmpty }
}

Describe 'Test-AcSleepDisabled' {
    It 'is true when both timeouts are zero' {
        Test-AcSleepDisabled -Settings ([pscustomobject]@{ SleepAfter = 0; HibernateAfter = 0 }) | Should Be $true
    }
    It 'is false when sleep would fire' {
        Test-AcSleepDisabled -Settings ([pscustomobject]@{ SleepAfter = 1800; HibernateAfter = 0 }) | Should Be $false
    }
    It 'treats an unsupported setting as disabled' {
        Test-AcSleepDisabled -Settings ([pscustomobject]@{ SleepAfter = $null; HibernateAfter = 0 }) | Should Be $true
    }
}
