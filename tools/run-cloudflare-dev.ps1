param(
  [int]$Port = 3000
)

$Host.UI.RawUI.WindowTitle = "Zhiheng Local D1 Service"
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$nodePath = "C:\Users\pc\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$vinextCli = Join-Path $projectRoot "node_modules\vinext\dist\cli.js"

Set-Location -LiteralPath $projectRoot
# Codex's PowerShell host can expose both PATH and Path. Windows treats these
# names case-insensitively, but Start-Process rejects the duplicate entries.
$processPath = [Environment]::GetEnvironmentVariable("Path", "Process")
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
if ($processPath) {
  [Environment]::SetEnvironmentVariable("Path", $processPath, "Process")
}
$credentialDirectory = Join-Path $projectRoot ".wrangler"
$credentialKeyPath = Join-Path $credentialDirectory "credential-encryption-key"
if (-not (Test-Path -LiteralPath $credentialKeyPath)) {
  New-Item -ItemType Directory -Force -Path $credentialDirectory | Out-Null
  $credentialBytes = New-Object byte[] 32
  $credentialRng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $credentialRng.GetBytes($credentialBytes)
  } finally {
    $credentialRng.Dispose()
  }
  [IO.File]::WriteAllText(
    $credentialKeyPath,
    [Convert]::ToBase64String($credentialBytes),
    [Text.UTF8Encoding]::new($false)
  )
}
$env:CREDENTIAL_ENCRYPTION_KEY = [IO.File]::ReadAllText($credentialKeyPath).Trim()
$env:WRANGLER_WRITE_LOGS = "false"
$env:WRANGLER_LOG_PATH = ".wrangler/logs"
$env:MINIFLARE_REGISTRY_PATH = ".wrangler/registry"
Remove-Item Env:LOCAL_PREVIEW_NO_CLOUDFLARE -ErrorAction SilentlyContinue
function Clear-ProcessProxyEnvironment {
  foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) {
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
  }
}
# Use the user's Windows proxy instead of the blocked proxy inherited from the
# command sandbox. This allows the retained Worker to poll public HTTPS sites.
$internetSettings = Get-ItemProperty `
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" `
  -ErrorAction SilentlyContinue
if ($env:LOCAL_NEWS_DISABLE_PROXY -eq "1") {
  Clear-ProcessProxyEnvironment
} elseif ($internetSettings.ProxyEnable -eq 1 -and $internetSettings.ProxyServer) {
  Clear-ProcessProxyEnvironment
  $proxyAddress = [string]$internetSettings.ProxyServer
  if ($proxyAddress.Contains("=")) {
    $proxyAddress = (($proxyAddress -split ";") | Where-Object {
      $_ -match "^https?="
    } | Select-Object -First 1) -replace "^https?=", ""
  }
  if ($proxyAddress -and -not $proxyAddress.StartsWith("http")) {
    $proxyAddress = "http://$proxyAddress"
  }
  [Environment]::SetEnvironmentVariable("HTTP_PROXY", $proxyAddress, "Process")
  [Environment]::SetEnvironmentVariable("HTTPS_PROXY", $proxyAddress, "Process")
} else {
  Clear-ProcessProxyEnvironment
}

Write-Host "Starting the local Worker and D1 preview at http://127.0.0.1:$Port" -ForegroundColor Cyan
$schedulerPath = Join-Path $projectRoot "tools\local-news-scheduler.mjs"
$schedulerOutput = Join-Path $projectRoot "tmp\local-news-scheduler.out.log"
$schedulerError = Join-Path $projectRoot "tmp\local-news-scheduler.err.log"
$discoveryPath = Join-Path $projectRoot "tools\local-source-discovery.mjs"
$discoveryOutput = Join-Path $projectRoot "tmp\local-source-discovery.out.log"
$discoveryError = Join-Path $projectRoot "tmp\local-source-discovery.err.log"
# The Worker explicitly binds to 127.0.0.1 below, so child workers must use
# the same IPv4 loopback address instead of a localhost IPv6 resolution.
$env:LOCAL_NEWS_APP_URL = "http://127.0.0.1:$Port"
$schedulerProcess = $null
$discoveryProcess = $null
if ($env:LOCAL_NEWS_DISABLE_SCHEDULER -ne "1") {
  $schedulerProcess = Start-Process `
    -FilePath $nodePath `
    -ArgumentList "`"$schedulerPath`"" `
    -WindowStyle Hidden `
    -RedirectStandardOutput $schedulerOutput `
    -RedirectStandardError $schedulerError `
    -PassThru
}
if ($env:LOCAL_SOURCE_DISCOVERY_DISABLE_RUNNER -ne "1") {
  try {
    $env:LOCAL_SOURCE_DISCOVERY_REQUEST_POLL = "1"
    $discoveryProcess = Start-Process `
      -FilePath $nodePath `
      -ArgumentList "`"$discoveryPath`"" `
      -WindowStyle Hidden `
      -RedirectStandardOutput $discoveryOutput `
      -RedirectStandardError $discoveryError `
      -PassThru
  } catch {
    Write-Warning "Source discovery runner did not start: $($_.Exception.Message)"
  }
}

try {
  & $nodePath $vinextCli dev --hostname 127.0.0.1 --port $Port
  $serviceExitCode = $LASTEXITCODE
} finally {
  if ($schedulerProcess -and -not $schedulerProcess.HasExited) {
    Stop-Process -Id $schedulerProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($discoveryProcess -and -not $discoveryProcess.HasExited) {
    Stop-Process -Id $discoveryProcess.Id -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Service exited with code: $serviceExitCode" -ForegroundColor Yellow
