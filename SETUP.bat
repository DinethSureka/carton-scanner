@echo off
title Carton Scanner - setup
cd /d "%~dp0server"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed on this PC.
  echo  Install the LTS version from https://nodejs.org and run SETUP.bat again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules\express (
  echo Installing packages, one time only...
  call npm install --omit=optional
)
node setup.js
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo Starting the server...
call "%~dp0START.bat"
