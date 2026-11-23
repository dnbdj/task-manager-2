@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Task Manager 2 needs Node.js 20 or newer: https://nodejs.org
  echo.
  pause
  exit /b 1
)

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" "%~dp0"
  exit /b 0
)

echo.
echo   Electron is not installed, opening Task Manager 2 in your browser instead.
echo   Run: npm install   to get the desktop window.
echo.
set TM2_OPEN=1
node server\index.mjs
