$ErrorActionPreference='Stop'
$env:JAVA_HOME='D:\android-studio\Android\jbr'
$adb='D:\android-studio\SDK\platform-tools\adb.exe'
Push-Location (Split-Path $PSScriptRoot)
try {
    & .\gradlew.bat assembleDebug assembleDebugAndroidTest
    if($LASTEXITCODE -ne 0){throw 'Build failed'}
    & $adb -s emulator-5554 install -r .\app\build\outputs\apk\debug\app-debug.apk
    if($LASTEXITCODE -ne 0){throw 'App install failed'}
    & $adb -s emulator-5554 install -r .\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk
    if($LASTEXITCODE -ne 0){throw 'Test install failed'}
    $report=& $adb -s emulator-5554 shell am instrument -w com.vitals.android.test/com.vitals.android.DatabaseInstrumentation
    $report | Set-Content .\docs\database-test-results.txt
    $report
    if(($report -join "`n") -notmatch 'TOTAL \d+ passed' -or ($report -join "`n") -match '(?m)^FAIL\s'){throw 'Native database tests failed'}
} finally {Pop-Location}
