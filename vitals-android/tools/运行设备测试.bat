@echo off
rem ---------------------------------------------------------------------------
rem  Vitals - run the device-level database tests (connectedDebugAndroidTest).
rem  Requires a running emulator; this script starts one if needed.
rem  Result is written to docs\database-test-results.txt
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"
set "PROJECT=%~dp0.."
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

set "JAVA_HOME=D:\download3\Android Studio\jbr"
if not exist "%JAVA_HOME%\bin\java.exe" (
  if exist "D:\android-studio\Android\jbr\bin\java.exe" set "JAVA_HOME=D:\android-studio\Android\jbr"
)
set "ANDROID_HOME=D:\download3\AndroidSdk"
if not exist "%ANDROID_HOME%\platform-tools\adb.exe" (
  if defined ANDROID_SDK_ROOT set "ANDROID_HOME=%ANDROID_SDK_ROOT%"
)
set "ADB=%ANDROID_HOME%\platform-tools\adb.exe"

if not exist "%ADB%" (
  echo [FAILED] adb not found: %ADB%
  pause
  exit /b 1
)

"%ADB%" devices | findstr /r "^emulator-[0-9][0-9]*[ ]*device" >nul
if errorlevel 1 (
  echo No running emulator. Launching one first...
  "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%emulator-launch.ps1" -NoInstall
  if errorlevel 1 ( echo [FAILED] emulator not available & pause & exit /b 1 )
)

echo Running connectedDebugAndroidTest ...
pushd "%PROJECT%"
call gradlew.bat connectedDebugAndroidTest --offline --console=plain
set "CODE=%ERRORLEVEL%"
popd

echo.
if "%CODE%"=="0" (
  echo [OK] device tests passed. See docs\database-test-results.txt
) else (
  echo [FAILED] device tests exit code %CODE%
)
pause
endlocal
