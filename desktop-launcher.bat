@echo off
setlocal
title Jini Agent Setup
set "SETUP=%USERPROFILE%\jini-agent\setup.ps1"
set "RAW=https://raw.githubusercontent.com/choijinyi/jini_agent/main/setup.ps1"

if not exist "%SETUP%" (
  set "SETUP=%TEMP%\jini-setup.ps1"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing '%RAW%' -OutFile '%TEMP%\jini-setup.ps1' } catch { exit 1 }"
  if errorlevel 1 (
    echo Setup script not found. See: %RAW%
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SETUP%" %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
