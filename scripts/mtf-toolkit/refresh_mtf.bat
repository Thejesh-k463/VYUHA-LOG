@echo off
REM ===========================================================================
REM  refresh_mtf.bat - India MTF approved-scrip refresher (Windows wrapper)
REM
REM  Double-click to run, or schedule via Task Scheduler.
REM  Any arguments you pass are forwarded to the Python script, e.g.
REM      refresh_mtf.bat --brokers dhan,upstox
REM      refresh_mtf.bat --history 30
REM ===========================================================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

REM --- pick a python interpreter -------------------------------------------
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY (
    where python >nul 2>&1 && set "PY=python"
)
if not defined PY (
    echo [ERROR] Python not found on PATH. Install Python 3.10+ and retry.
    pause
    exit /b 3
)

REM --- timestamped log ------------------------------------------------------
if not exist "logs" mkdir "logs"
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set "LDT=%%I"
set "STAMP=%LDT:~0,8%_%LDT:~8,6%"
set "LOG=logs\mtf_refresh_%STAMP%.log"

echo.
echo  ============================================================
echo   MTF refresh starting - log: %LOG%
echo  ============================================================
echo.

REM Tee via PowerShell so progress streams live AND lands in the log,
REM while $LASTEXITCODE carries the script's real exit code back to cmd.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "& { %PY% refresh_mtf.py %* 2>&1 | Tee-Object -FilePath '%LOG%'; exit $LASTEXITCODE }"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo  [OK] Refresh complete. Output in .\output\
) else if "%RC%"=="1" (
    echo  [FAIL] A broker feed could not be fetched. Check your connection,
    echo         then look for the endpoint block in refresh_mtf.py - a broker
    echo         may have moved their feed.
) else if "%RC%"=="2" (
    echo  [FAIL] Validation gate rejected the data. NOTHING was written.
    echo         Read the log above: a feed came back truncated or malformed.
) else if "%RC%"=="3" (
    echo  [FAIL] Bad arguments, or openpyxl is missing.
    echo         Install it with:  %PY% -m pip install openpyxl
) else (
    echo  [FAIL] Unexpected exit code %RC%.
)
echo.

REM Comment out the next line if running unattended via Task Scheduler.
pause
exit /b %RC%
