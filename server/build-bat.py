# Rebuilds start-server-powershell.bat from server.ps1 (script embedded in the .bat,
# so it still works where .ps1 files are removed or blocked).
import pathlib
here = pathlib.Path(__file__).parent
ps = (here / 'server.ps1').read_text(encoding='utf-8')
head = r'''@echo off
title Carton Scanner server
set "CS_BAT=%~f0"
set "CS_HERE=%~dp0"
if "%CS_HERE:~-1%"=="\" set "CS_HERE=%CS_HERE:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:CS_BAT); $i=$s.IndexOf('#'+'#PS-START'); & ([ScriptBlock]::Create($s.Substring($i)))"
pause
exit /b
'''
bat = head + '##PS-START\n' + ps
(here / 'start-server-powershell.bat').write_bytes(bat.replace('\r\n', '\n').replace('\n', '\r\n').encode('ascii'))
print('ok', len(bat))
