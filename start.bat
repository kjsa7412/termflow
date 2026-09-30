@echo off
rem TermFlow one-click start (design 12.6, T11.3). Double-click this file.
rem Runs start.ps1 with the same steps and options, bypassing the default
rem PowerShell execution policy (Restricted) for this process only (CR-11a C6).
rem   start.bat                  normal start
rem   start.bat -Build           rebuild app image (upgrade)
rem   start.bat -Migrate no      skip the migration question
setlocal
where powershell >nul 2>nul
if errorlevel 1 (
  echo [TermFlow] powershell.exe not found. Windows PowerShell 5.1 is required.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo [TermFlow] start failed ^(exit code %RC%^). See the messages above.
  pause
)
endlocal & exit /b %RC%
