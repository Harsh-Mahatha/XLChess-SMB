@echo off
rem XLChess worker installer entry point.
rem Double-click this file (or run it from a terminal). It asks for administrator rights, then runs
rem setup-xlchess-worker.ps1 with the PowerShell that ships with Windows. Any arguments are passed on,
rem for example:  install.cmd -ApiUrl https://smb.example.com
setlocal
set "HERE=%~dp0"

if /i "%~1"=="-CheckOnly" goto run

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator rights...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
    exit /b
)

:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%setup-xlchess-worker.ps1" %*
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" (
    echo Setup did not finish ^(exit code %RC%^). See the messages above.
) else (
    echo Done.
)
pause
exit /b %RC%
