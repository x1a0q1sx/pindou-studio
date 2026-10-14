@echo off
chcp 65001 >nul
title PinDou Studio
cd /d "%~dp0.."

rem First run: install dependencies if missing
if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Check your network and retry.
    pause
    exit /b 1
  )
)

rem Build once if dist is missing
if not exist "dist\index.html" (
  echo Building app...
  call npm run build
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
)

rem Launch the full Electron app (physical calibration / fullscreen / keep-awake)
call npm run start
