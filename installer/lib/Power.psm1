# Windows power-plan helpers. Locale-independent: values are parsed from powercfg's hex output, not its labels.
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only.

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'Common.psm1')

# powercfg aliases: STANDBYIDLE = "Sleep after", HIBERNATEIDLE = "Hibernate after".
$script:PowerSettings = @(
    [pscustomobject]@{ Key = 'SleepAfter'; Sub = 'SUB_SLEEP'; Setting = 'STANDBYIDLE' }
    [pscustomobject]@{ Key = 'HibernateAfter'; Sub = 'SUB_SLEEP'; Setting = 'HIBERNATEIDLE' }
)

function ConvertFrom-PowercfgQuery {
    <#
    .SYNOPSIS Returns @{ Ac; Dc } (seconds) from `powercfg /query` text, or $null if it can't be parsed.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $hex = [regex]::Matches($Text, '0x[0-9a-fA-F]{8}') | ForEach-Object { $_.Value }
    if (@($hex).Count -lt 2) { return $null }
    $hex = @($hex)
    [pscustomobject]@{
        Ac = [Convert]::ToInt64($hex[$hex.Count - 2].Substring(2), 16)
        Dc = [Convert]::ToInt64($hex[$hex.Count - 1].Substring(2), 16)
    }
}

function Get-AcPowerSettings {
    <#
    .SYNOPSIS Current-plan AC timeouts in seconds (0 = never). A value is $null when the PC doesn't expose it.
    #>
    $result = [ordered]@{}
    foreach ($s in $script:PowerSettings) {
        $text = (& powercfg.exe /query SCHEME_CURRENT $s.Sub $s.Setting 2>$null | Out-String)
        $parsed = ConvertFrom-PowercfgQuery -Text $text
        $result[$s.Key] = $(if ($parsed) { $parsed.Ac } else { $null })
    }
    [pscustomobject]$result
}

function Test-AcSleepDisabled {
    <# True when neither sleep nor hibernate would fire on AC power. $null settings count as disabled. #>
    param([Parameter(Mandatory)]$Settings)
    foreach ($v in @($Settings.SleepAfter, $Settings.HibernateAfter)) {
        if ($null -ne $v -and $v -ne 0) { return $false }
    }
    $true
}


function ConvertTo-PowercfgMinutes {
    <# powercfg /change takes minutes; the plan stores seconds. 0 stays 0 (never). #>
    param($Seconds)
    if ($null -eq $Seconds) { return $null }
    [int][math]::Ceiling([double]$Seconds / 60.0)
}

function Set-AcSleepNever {
    <#
    .SYNOPSIS Turns off sleep and hibernate on AC power. The previous values are saved once so uninstall can restore them.
    #>
    param([Parameter(Mandatory)][string]$BackupPath)
    $current = Get-AcPowerSettings
    if (-not (Test-Path -LiteralPath $BackupPath)) {
        Write-JsonFile -Path $BackupPath -Value ([ordered]@{ SleepAfter = $current.SleepAfter; HibernateAfter = $current.HibernateAfter })
    }
    & powercfg.exe /change standby-timeout-ac 0 | Out-Null
    & powercfg.exe /change hibernate-timeout-ac 0 | Out-Null
}

function Restore-AcSleep {
    param([Parameter(Mandatory)][string]$BackupPath)
    if (-not (Test-Path -LiteralPath $BackupPath)) { return $false }
    $b = Read-JsonFile -Path $BackupPath
    $sleep = ConvertTo-PowercfgMinutes $b.SleepAfter
    $hib = ConvertTo-PowercfgMinutes $b.HibernateAfter
    if ($null -ne $sleep) { & powercfg.exe /change standby-timeout-ac $sleep | Out-Null }
    if ($null -ne $hib) { & powercfg.exe /change hibernate-timeout-ac $hib | Out-Null }
    Remove-Item -LiteralPath $BackupPath -Force
    $true
}

Export-ModuleMember -Function ConvertFrom-PowercfgQuery, Get-AcPowerSettings, Test-AcSleepDisabled,
    ConvertTo-PowercfgMinutes, Set-AcSleepNever, Restore-AcSleep
