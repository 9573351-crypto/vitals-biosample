@echo off
rem ---------------------------------------------------------------------------
rem  Vitals - rebuild the debug APK, install it into the running emulator,
rem  relaunch the app, and store a screenshot next to this script.
rem  Use this after changing code under app\src.
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

echo [1/4] Building APK...
pushd "%PROJECT%"
call gradlew.bat assembleDebug --offline --console=plain
if errorlevel 1 (
  echo [FAILED] build error
  popd
  pause
  exit /b 1
)
popd

if not exist "%ADB%" (
  echo [FAILED] adb not found: %ADB%
  pause
  exit /b 1
)

echo [2/4] Checking emulator...
"%ADB%" devices | findstr /r "^emulator-[0-9][0-9]*[ ]*device" >nul
if errorlevel 1 (
  echo No running emulator. Launching one first...
  "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%emulator-launch.ps1" -NoInstall
  if errorlevel 1 ( echo [FAILED] emulator not available & pause & exit /b 1 )
)

echo [3/4] Installing APK...
"%ADB%" install -r -d "%PROJECT%\app\build\outputs\apk\debug\app-debug.apk"
if errorlevel 1 ( echo [FAILED] install error & pause & exit /b 1 )

echo [4/4] Launching app and taking a screenshot...
"%ADB%" shell am start -n com.vitals.android/.MainActivity >nul
timeout /t 6 /nobreak >nul
"%ADB%" shell screencap -p /sdcard/vitals-shot.png
"%ADB%" pull /sdcard/vitals-shot.png "%HERE%最新界面.png"
"%ADB%" shell rm -f /sdcard/vitals-shot.png

echo.
echo [OK] Done. Screenshot: %HERE%最新界面.png
echo      Logcat: "%ADB%" logcat -s VitalsWeb VitalsDB VitalsUpdate
echo.
pause
endlocal
