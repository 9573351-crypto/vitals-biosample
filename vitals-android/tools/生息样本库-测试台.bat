@echo off
rem ---------------------------------------------------------------------------
rem  Vitals test bench - single entry point.
rem  Opens on the live emulator window (real-time Android view, mouse-operable),
rem  then shows a menu for rebuild / device tests / restart / screenshot / logcat.
rem  Arg: mirror | rebuild | test | restart | shot | log   (skips the menu)
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

title Vitals test bench

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%vitals-test.ps1" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [FAILED] exit code %CODE%
  echo If the emulator cannot start, install the hypervisor driver as Administrator:
  echo   "%HERE%install-hypervisor.ps1"
  echo.
  pause
)
endlocal
