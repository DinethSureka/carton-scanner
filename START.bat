@echo off
title Carton Scanner server
cd /d "%~dp0server"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed on this PC.
  echo  Install the LTS version from https://nodejs.org first.
  echo.
  pause
  exit /b 1
)
if not exist config.json (
  echo.
  echo  First time here? Run SETUP.bat first.
  echo.
  pause
  exit /b 1
)
if not exist node_modules\express (
  echo Installing packages, one time only...
  call npm install --omit=optional
)
findstr /c:"sqlserver" config.json >nul
if not errorlevel 1 if not exist node_modules\msnodesqlv8 (
  echo Installing the SQL Server driver, one time only...
  call npm install
)
node server.js
pause
