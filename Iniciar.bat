@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Lyrics Overlay
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instala la version LTS desde https://nodejs.org y vuelve a abrir este archivo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias, puede tardar un par de minutos...
  call npm install
  if errorlevel 1 (
    echo Fallo npm install. Copia el error de arriba.
    pause
    exit /b 1
  )
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Preparando Electron con Windows...
  call Reparar.bat
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo No se pudo preparar Electron. Copia el error de arriba.
  pause
  exit /b 1
)
echo Iniciando Lyrics Overlay. Deja esta ventana abierta; al cerrarla se cierra la app.
call npm start
pause
