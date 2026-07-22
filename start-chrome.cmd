@echo off
setlocal
set PORT=9222
set PROFILE=%~dp0chrome-manual-profile
if not exist "%PROFILE%" mkdir "%PROFILE%"
del /q "%PROFILE%\Singleton*" 2>nul
del /q "%PROFILE%\Lockfile" 2>nul

set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe

if "%CHROME%"=="" (
  echo Chrome not found.
  exit /b 1
)

echo.
echo Starting Chrome (manual login — no Playwright^)
echo   Profile: %PROFILE%
echo.
echo 1^) Log into x.com in the Chrome window
echo 2^) Leave Chrome open
echo 3^) Run: npm run search
echo.

start "" "%CHROME%" --remote-debugging-port=%PORT% --remote-allow-origins=* --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check https://x.com/home
