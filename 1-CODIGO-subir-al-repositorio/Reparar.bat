@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Reparar Electron
set "DIST=%~dp0node_modules\electron\dist"
set "ZIP="
for /r "%LOCALAPPDATA%\electron\Cache" %%f in (electron-v*-win32-x64.zip) do set "ZIP=%%f"
if not defined ZIP (
  echo No encontre el zip de Electron en la cache de descargas.
  pause
  exit /b 1
)
echo Extrayendo: %ZIP%
echo Esto tarda uno o dos minutos...
powershell -NoProfile -Command "Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:DIST -Force"
if errorlevel 1 (
  echo Fallo al extraer.
  pause
  exit /b 1
)
powershell -NoProfile -Command "[IO.File]::WriteAllText('node_modules\electron\path.txt','electron.exe')"
if exist "%DIST%\electron.exe" (echo OK: electron.exe presente) else (echo FALTA electron.exe)
echo.
pause
