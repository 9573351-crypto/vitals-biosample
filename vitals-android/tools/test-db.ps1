$ErrorActionPreference='Stop'
# adb 位置按 ANDROID_HOME / ANDROID_SDK_ROOT / 工程 local.properties 的 sdk.dir 推导，最后回退常见安装目录。
function Resolve-Adb {
    $exe = if ($env:OS -eq 'Windows_NT') { 'adb.exe' } else { 'adb' }
    $roots = @()
    foreach ($key in @('ANDROID_HOME','ANDROID_SDK_ROOT')) {
        $value = [Environment]::GetEnvironmentVariable($key)
        if ($value) { $roots += $value }
    }
    $localProperties = Join-Path (Split-Path $PSScriptRoot) 'local.properties'
    if (Test-Path -LiteralPath $localProperties) {
        foreach ($line in Get-Content -LiteralPath $localProperties) {
            $match = [regex]::Match($line, '^\s*sdk\.dir\s*=\s*(.+?)\s*$')
            if ($match.Success) { $roots += ($match.Groups[1].Value -replace '\\\\','\' -replace '\\:',':') }
        }
    }
    $roots += 'D:\android-studio\SDK', 'D:\download3\AndroidSdk', (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
    foreach ($root in $roots) {
        if (-not $root) { continue }
        foreach ($candidate in @((Join-Path $root "platform-tools\$exe"), (Join-Path $root $exe))) {
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    return $null
}
$adb = Resolve-Adb
if (-not $adb) {
    throw '未找到 adb：请设置 ANDROID_HOME 或 ANDROID_SDK_ROOT，或在 vitals-android\local.properties 写入 sdk.dir=<SDK 路径>。'
}
Write-Host "adb = $adb"
# JDK 同样不再写死：仅当 JAVA_HOME 缺失或无效时回退到常见 Android Studio JBR 目录。
if (-not $env:JAVA_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    $jdkCandidates = @(
        'D:\download3\Android Studio\jbr',
        'D:\android-studio\Android\jbr',
        (Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Android Studio\jbr')
    )
    $javaHome = $jdkCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\java.exe') } | Select-Object -First 1
    if (-not $javaHome) { throw '未找到 JDK：请设置 JAVA_HOME 指向 JDK 17+，或安装 Android Studio。' }
    $env:JAVA_HOME = $javaHome
}
Write-Host "JAVA_HOME = $env:JAVA_HOME"
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
