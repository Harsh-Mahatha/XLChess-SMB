# Windows power-plan helpers. Locale-independent: values are parsed from powercfg's hex output, not its labels.
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only.

Set-StrictMode -Version 2.0

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

Export-ModuleMember -Function ConvertFrom-PowercfgQuery, Get-AcPowerSettings, Test-AcSleepDisabled
