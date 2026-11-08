@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 4777 -State Listen -ErrorAction SilentlyContinue; if (-not $c) { wscript.exe //B //Nologo scripts\start-daemon-silent.vbs; for ($i=0; $i -lt 20 -and -not (Get-NetTCPConnection -LocalPort 4777 -State Listen -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 } }"
start "" http://127.0.0.1:4777
