@echo off
rem Launch Task Manager 2 elevated so it can end processes owned by other users
rem and by Windows services. Windows shows a UAC prompt.
setlocal
cd /d "%~dp0"

if exist "node_modules\electron\dist\electron.exe" (
  powershell -NoProfile -Command "Start-Process -FilePath '%~dp0node_modules\electron\dist\electron.exe' -ArgumentList '\"%~dp0\"' -Verb RunAs"
  exit /b 0
)

powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','node server\index.mjs' -Verb RunAs -WorkingDirectory '%~dp0'"
