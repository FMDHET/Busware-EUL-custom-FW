@echo off
rem Startet beide EUL22-Diagnose-Tools (Verbindungs-Monitor + Lasttest).
rem Doppelklick genuegt. Nutzt pythonw (ohne Konsolenfenster), sonst python.
setlocal
cd /d "%~dp0"
where pythonw >nul 2>nul && (set "PY=pythonw") || (set "PY=python")
echo Starte Tools mit %PY% ...
start "EUL Monitor"  %PY% eul_conn_monitor.py
start "EUL Lasttest" %PY% eul_load_test.py
