[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Get-Keys([string]$Path) {
    $keys = [System.Collections.Generic.Dictionary[string,bool]]::new([System.StringComparer]::OrdinalIgnoreCase)
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in @(Get-Content -LiteralPath $Path -Encoding UTF8)) {
            if ($line -match '^\uFEFF?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=') { $keys[$matches[1]] = $true }
        }
    }
    return ,$keys
}

$local = Get-Keys (Join-Path $root ".env.local")
$example = Get-Keys (Join-Path $root ".env.example")
$localOnly = @($local.Keys | Where-Object { -not $example.ContainsKey($_) } | Sort-Object)
$exampleOnly = @($example.Keys | Where-Object { -not $local.ContainsKey($_) } | Sort-Object)

Write-Host ".env.local keys:   $($local.Count)"
Write-Host ".env.example keys: $($example.Count)"
Write-Host ""
Write-Host "Only in .env.local ($($localOnly.Count)):"
if ($localOnly.Count) { $localOnly | ForEach-Object { Write-Host "  $_" } } else { Write-Host "  (none)" }
Write-Host "Only in .env.example ($($exampleOnly.Count)):"
if ($exampleOnly.Count) { $exampleOnly | ForEach-Object { Write-Host "  $_" } } else { Write-Host "  (none)" }
if ($localOnly.Count -eq 0 -and $exampleOnly.Count -eq 0) { exit 0 }
exit 1
