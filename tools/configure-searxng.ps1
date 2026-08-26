[CmdletBinding()]
param(
  [string]$SettingsPath,
  [string]$SearxngDirectory,
  [switch]$Apply,
  [switch]$ShowCompose
)

$ErrorActionPreference = "Stop"
$engines = @("google", "bing", "duckduckgo", "baidu", "yandex")

function Resolve-CandidatePath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $null }
  try {
    $resolved = Resolve-Path -LiteralPath $PathValue -ErrorAction Stop
    if ((Get-Item -LiteralPath $resolved).PSIsContainer) {
      $settings = Join-Path $resolved "settings.yml"
      if (Test-Path -LiteralPath $settings) { return (Resolve-Path -LiteralPath $settings).Path }
      return $null
    }
    return $resolved.Path
  } catch { return $null }
}

$candidatePaths = @()
if ($SettingsPath) { $candidatePaths += $SettingsPath }
if ($env:SEARXNG_SETTINGS_PATH) { $candidatePaths += $env:SEARXNG_SETTINGS_PATH }
if ($SearxngDirectory) { $candidatePaths += (Join-Path $SearxngDirectory "settings.yml") }
$candidatePaths += @(
  ".\searxng\settings.yml",
  ".\docker\searxng\settings.yml",
  (Join-Path $PSScriptRoot "..\searxng\settings.yml")
)

$resolvedSettings = $candidatePaths | ForEach-Object { Resolve-CandidatePath $_ } | Where-Object { $_ } | Select-Object -First 1
if (-not $resolvedSettings) {
  Write-Warning "SearXNG settings.yml was not found. Pass -SettingsPath or -SearxngDirectory."
  Write-Host "Common Docker paths: .\searxng\settings.yml, /etc/searxng/settings.yml, or a Docker bind mount."
} else {
  Write-Host "Using settings: $resolvedSettings"
  $content = Get-Content -LiteralPath $resolvedSettings -Raw
  foreach ($engine in $engines) {
    $match = [regex]::Match($content, "(?im)^\s*-\s*name:\s*$([regex]::Escape($engine))\s*$")
    if (-not $match.Success) {
      Write-Warning "Missing engine entry: $engine"
      continue
    }
    $blockStart = $match.Index
    $nextBlock = [regex]::Match($content.Substring($blockStart + $match.Length), "(?m)^\s*-\s*name:\s*")
    $blockLength = if ($nextBlock.Success) { $nextBlock.Index } else { $content.Length - $blockStart - $match.Length }
    $block = $content.Substring($blockStart, $match.Length + $blockLength)
    if ($block -match "(?im)^\s*disabled:\s*true\s*$") { Write-Warning "$engine is explicitly disabled" } else { Write-Host "$engine is present and not explicitly disabled" }
  }
  if ($content -notmatch "(?im)^\s*-\s*json\s*$") { Write-Warning "search.formats does not visibly include json; SearXNG JSON is required by this project." }

  if ($Apply) {
    $backup = "$resolvedSettings.$(Get-Date -Format yyyyMMddHHmmss).bak"
    Copy-Item -LiteralPath $resolvedSettings -Destination $backup
    $lines = Get-Content -LiteralPath $resolvedSettings
    $currentTarget = $false
    $changed = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match "^(\s*)-\s*name:\s*(google|bing|duckduckgo|baidu|yandex)\s*$") {
        $currentTarget = $true
      } elseif ($lines[$i] -match "^\s*-\s*name:\s*" -or ($currentTarget -and $lines[$i] -match "^\S")) {
        $currentTarget = $false
      }
      if ($currentTarget -and $lines[$i] -match "^(\s*)disabled:\s*true\s*$") {
        $lines[$i] = $lines[$i] -replace "disabled:\s*true", "disabled: false"
        $changed = $true
      }
    }
    if ($changed) { Set-Content -LiteralPath $resolvedSettings -Value $lines -Encoding utf8; Write-Host "Enabled existing target entries. Backup: $backup" } else { Write-Host "No existing disabled target entries changed. Backup: $backup" }
  }
}

$snippetPath = Join-Path (Get-Location) "searxng-recommended-engines.yml"
@"
# Merge these entries into the engines: list in SearXNG settings.yml.
# Google may require cookies or additional anti-bot configuration.
search:
  formats:
    - html
    - json

engines:
  - name: google
    engine: google
    shortcut: go
  - name: bing
    engine: bing
    shortcut: bi
  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg
  - name: baidu
    engine: baidu
    shortcut: bd
  - name: yandex
    engine: yandex
    shortcut: ya
"@ | Set-Content -LiteralPath $snippetPath -Encoding utf8
Write-Host "Recommended merge snippet written to $snippetPath"

if ($ShowCompose) {
  Write-Host @"

Docker Compose example:
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "8080:8080"
    volumes:
      - ./searxng:/etc/searxng:rw
    restart: unless-stopped

Then place settings.yml at ./searxng/settings.yml and restart:
  docker compose restart searxng
"@
}
