@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing packages, first run only...
  call npm install
)
if not exist config.json copy config.example.json config.json >nul
node server.js
pause
