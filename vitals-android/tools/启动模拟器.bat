@echo off
rem ---------------------------------------------------------------------------
rem  Vitals - launch the Android emulator and install the current APK.
rem  Double-click this file (or the desktop shortcut pointing to it).
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

echo Launching Vitals emulator...
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%emulator-launch.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" (
  echo [FAILED] exit code %CODE%
  echo If this is the first run, install the hypervisor driver as Administrator:
  echo   %HERE%install-hypervisor.ps1
) else (
  echo [OK] emulator is ready. Close this window when finished.
)
echo.
pause
endlocal
