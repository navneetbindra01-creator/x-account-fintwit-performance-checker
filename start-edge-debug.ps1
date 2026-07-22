# Start Microsoft Edge with remote debugging so Playwright can attach
# after you log in manually. Does NOT log you in.

$ErrorActionPreference = "Stop"

$edgePaths = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)

$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) {
  Write-Error "Microsoft Edge not found. Install Edge or update the path in this script."
  exit 1
}

$port = 9222
$profileDir = Join-Path $PSScriptRoot "edge-debug-profile"

# Isolated profile so we don't fight your everyday Edge session.
# Log into x.com once in this window; session is reused next time.
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

Write-Host ""
Write-Host "Starting Edge with remote debugging on port $port"
Write-Host "Profile: $profileDir"
Write-Host ""
Write-Host "1) Log into x.com in the Edge window that opens"
Write-Host "2) Leave Edge open"
Write-Host "3) In another terminal run:  npm run search"
Write-Host ""

# --remote-debugging-port lets Playwright connect
# --user-data-dir keeps cookies/session for this automation profile
Start-Process -FilePath $edge -ArgumentList @(
  "--remote-debugging-port=$port",
  "--user-data-dir=$profileDir",
  "https://x.com/home"
)
