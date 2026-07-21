@echo off
rem Startet beide EUL22-Diagnose-Tools (Verbindungs-Monitor + Lasttest).
rem Doppelklick genuegt. Ermittelt den echten pythonw.exe-Pfad ueber den
rem py-Launcher (umgeht den haengenden Windows-Store-Alias "pythonw" und
rem vermeidet Konsolenfenster).
setlocal
cd /d "%~dp0"

set "PYW="
for /f "delims=" %%P in ('py -c "import sys;print(sys.executable)" 2^>nul') do set "PYEXE=%%P"
if defined PYEXE set "PYW=%PYEXE:python.exe=pythonw.exe%"

if defined PYW if exist "%PYW%" (
  start "EUL Monitor"  "%PYW%" "%~dp0eul_conn_monitor.py"
  start "EUL Lasttest" "%PYW%" "%~dp0eul_load_test.py"
  goto :end
)

rem Fallback: py-Launcher direkt (ggf. mit Konsolenfenster)
where py >nul 2>nul
if %errorlevel%==0 (
  start "EUL Monitor"  py "%~dp0eul_conn_monitor.py"
  start "EUL Lasttest" py "%~dp0eul_load_test.py"
  goto :end
)

echo Kein Python 3 gefunden. Bitte von python.org installieren.
pause

:end
