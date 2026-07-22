# Start Google Chrome yourself (no Playwright). Log into x.com here.
# Then run:  npm run search
#
# Why: X often blocks login in Playwright-launched browsers.
# This window is a normal Chrome; the search script only attaches later.

$ErrorActionPreference = "Stop"

$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
  Write-Error "Google Chrome not found."
  exit 1
}

$port = 9222
$profileDir = Join-Path $PSScriptRoot "chrome-manual-profile"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

# Clear stale locks if Chrome was force-closed last time
Remove-Item (Join-Path $profileDir "Singleton*") -ErrorAction SilentlyContinue
Remove-Item (Join-Path $profileDir "Lockfile") -ErrorAction SilentlyContinue

# Fail clearly if something else already owns 9222
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Port $port is already in use. Either:"
  Write-Host "  - Use that browser (if you already started this script), or"
  Write-Host "  - Close the other debug Chrome and re-run this script."
  Write-Host ""
  try {
    $v = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 2
    Write-Host "CDP already reachable — you can run: npm run search"
    Write-Host $v.Content
  } catch {
    Write-Host "Port busy but CDP not responding. Close processes on port $port and retry."
  }
  exit 0
}

Write-Host ""
Write-Host "Starting Chrome (manual login profile)"
Write-Host "  Profile: $profileDir"
Write-Host "  Debug:   http://127.0.0.1:$port"
Write-Host ""
Write-Host "1) Log into x.com in the Chrome window"
Write-Host "2) Leave Chrome open"
Write-Host "3) In another terminal:  cd $PSScriptRoot ; npm run search"
Write-Host ""

# Important: Playwright is NOT involved here — normal Chrome process.
# Dedicated --user-data-dir so this process actually stays up with CDP
# even if your everyday Chrome is also running.
Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=$port",
  "--remote-allow-origins=*",
  "--user-data-dir=$profileDir",
  "--no-first-run",
  "--no-default-browser-check",
  "https://x.com/home"
)

Start-Sleep -Seconds 2
try {
  $v = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 5
  Write-Host "CDP OK — Chrome is ready for login."
} catch {
  Write-Host "Chrome started but CDP not ready yet. Wait a few seconds, then npm run search."
}
