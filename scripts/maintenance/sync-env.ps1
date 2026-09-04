[CmdletBinding()]
param([switch]$Yes)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$examplePath = Join-Path $root ".env.example"
$localPath = Join-Path $root ".env.local"

function Read-EnvFile([string]$Path) {
    if (Test-Path -LiteralPath $Path) { return @(Get-Content -LiteralPath $Path -Encoding UTF8) }
    return @()
}
function Get-EnvEntries([string[]]$Lines) {
    $entries = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $Lines) { if ($line -match '^\uFEFF?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=') { $entries[$matches[1]] = $line } }
    return ,$entries
}
function Test-SensitiveKey([string]$Key) { return $Key -match 'KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|WEBHOOK|COOKIE' }
function Get-DisplayValue([string]$Key, [string]$Line) {
    $value = $Line.Substring($Line.IndexOf('=') + 1)
    if ((Test-SensitiveKey $Key) -and $value.Length -gt 0) { return "<REDACTED>" }
    return $value
}
function Get-CommentSuggestion([string]$Key) {
    if (Test-SensitiveKey $Key) { return "# $Key (sensitive credential; do not commit a real value)" }
    if ($Key -match 'TIMEOUT') { return "# $Key timeout in milliseconds" }
    if ($Key -match 'CONCURRENCY|MAX|COUNT|LIMIT|DAYS|HOURS|RETRIES') { return "# $Key numeric setting" }
    if ($Key -match '^ENABLE_|^ALLOW_|^DEBUG_|^USE_') { return "# $Key boolean switch" }
    return "# $Key setting (please document its purpose)"
}
function Get-ExampleLine([string]$Key, [string]$LocalLine) {
    if (Test-SensitiveKey $Key) { return "$Key=" }
    return $LocalLine
}

if (-not (Test-Path -LiteralPath $examplePath)) { throw "Missing .env.example: $examplePath" }
$exampleEntries = Get-EnvEntries (Read-EnvFile $examplePath)
$localEntries = Get-EnvEntries (Read-EnvFile $localPath)
$localMissing = @($exampleEntries.Keys | Where-Object { -not $localEntries.ContainsKey($_) } | Sort-Object)
$exampleMissing = @($localEntries.Keys | Where-Object { -not $exampleEntries.ContainsKey($_) } | Sort-Object)

Write-Host "Environment key synchronization preview"
Write-Host "  .env.example: $($exampleEntries.Count) keys"
Write-Host "  .env.local:   $($localEntries.Count) keys"
Write-Host "Append to .env.local: $($localMissing.Count)"
foreach ($key in $localMissing) { Write-Host "  + $key = $(Get-DisplayValue $key $exampleEntries[$key])" }
Write-Host "Append to .env.example: $($exampleMissing.Count)"
foreach ($key in $exampleMissing) { Write-Host "  + $key = $(Get-DisplayValue $key $localEntries[$key]) ; $(Get-CommentSuggestion $key)" }

if ($localMissing.Count -eq 0 -and $exampleMissing.Count -eq 0) { Write-Host "Key sets already match; no changes needed."; exit 0 }
if ($exampleMissing.Count -gt 0) { Write-Warning "local -> example keys have only generated comment suggestions; review them before committing." }
if (-not $Yes) { $answer = Read-Host "Proceed? Type exactly YES to create backups and append missing keys"; if ($answer -cne "YES") { Write-Host "Cancelled; no files changed."; exit 0 } }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (Test-Path -LiteralPath $localPath) { Copy-Item -LiteralPath $localPath -Destination "$localPath.backup.$stamp" -ErrorAction Stop }
Copy-Item -LiteralPath $examplePath -Destination "$examplePath.backup.$stamp" -ErrorAction Stop
if ($localMissing.Count -gt 0) {
    if (-not (Test-Path -LiteralPath $localPath)) { New-Item -ItemType File -Path $localPath -Force | Out-Null }
    Add-Content -LiteralPath $localPath -Value @("", "# Appended from .env.example by sync-env.ps1") -Encoding UTF8
    foreach ($key in $localMissing) { Add-Content -LiteralPath $localPath -Value $exampleEntries[$key] -Encoding UTF8 }
}
if ($exampleMissing.Count -gt 0) {
    Add-Content -LiteralPath $examplePath -Value @("", "# Appended from .env.local; review before committing") -Encoding UTF8
    foreach ($key in $exampleMissing) { Add-Content -LiteralPath $examplePath -Value @((Get-CommentSuggestion $key), (Get-ExampleLine $key $localEntries[$key])) -Encoding UTF8 }
}
Write-Host "Synchronization complete. Backups use suffix .backup.$stamp"
Write-Host "Existing lines and values were not overwritten."
