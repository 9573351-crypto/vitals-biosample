# 生息样本库 — 模拟器启动器
# 用法：双击桌面快捷方式，或在 PowerShell 中运行：
#   powershell -ExecutionPolicy Bypass -File tools\emulator-launch.ps1
# 做了什么：确保模拟器在运行 → 等待系统启动完成 → 安装最新 APK → 打开应用。
# 说明：默认无窗口运行（不需要显卡加速渲染），用 adb 截图查看界面即可。
#       想看图形窗口，加 -Window 参数。
[CmdletBinding()]
param(
    [switch]$Window,
    [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

# ---------- 路径解析 ----------
$repo = Split-Path -Parent $PSScriptRoot          # vitals-android/
$avdName = 'vitals-test'
$sdkCandidates = @()
if ($env:ANDROID_HOME) { $sdkCandidates += $env:ANDROID_HOME }
if ($env:ANDROID_SDK_ROOT) { $sdkCandidates += $env:ANDROID_SDK_ROOT }
$localProps = Join-Path $repo 'local.properties'
if (Test-Path $localProps) {
    foreach ($line in Get-Content $localProps) {
        $m = [regex]::Match($line, '^\s*sdk\.dir\s*=\s*(.+?)\s*$')
        if ($m.Success) { $sdkCandidates += ($m.Groups[1].Value -replace '\\\\', '\' -replace '\\:', ':') }
    }
}
$sdkCandidates += 'D:\download3\AndroidSdk', 'D:\android-studio\SDK'
$sdk = $sdkCandidates | Where-Object { $_ -and (Test-Path (Join-Path $_ 'emulator\emulator.exe')) } | Select-Object -First 1
if (-not $sdk) { throw 'No Android SDK with emulator found. Set ANDROID_HOME or edit local.properties.' }

$emulator = Join-Path $sdk 'emulator\emulator.exe'
$adb = Join-Path $sdk 'platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "adb not found: $adb" }

Write-Host "SDK      : $sdk"
Write-Host "AVD      : $avdName"

# ---------- 1) 加速能力自检 ----------
$accel = (& $emulator -accel-check 2>&1 | Out-String)
if ($accel -match 'not installed|not found' -or $accel -match '^accel:\s*\r?\n6') {
    Write-Host ''
    Write-Host 'WARNING: hardware acceleration is NOT available on this machine.' -ForegroundColor Yellow
    Write-Host 'The emulator needs a hypervisor driver. Run once as Administrator:' -ForegroundColor Yellow
    Write-Host "  $PSScriptRoot\install-hypervisor.ps1" -ForegroundColor Yellow
    Write-Host 'Continuing anyway; startup will be very slow and may fail.' -ForegroundColor Yellow
    Write-Host ''
}

# ---------- 2) 启动模拟器（若未运行） ----------
function Get-EmulatorSerial {
    $lines = & $adb devices | Select-Object -Skip 1
    $serial = $lines | Where-Object { $_ -match '^emulator-\d+\s+device' } | Select-Object -First 1
    if ($serial) { return ($serial -split '\s+')[0] }
    return $null
}

$serial = Get-EmulatorSerial
if (-not $serial) {
    $arguments = @('-avd', $avdName, '-no-audio', '-no-boot-anim', '-no-snapshot', '-gpu', 'swiftshader_indirect')
    if (-not $Window) { $arguments += '-no-window' }
    Write-Host 'Starting emulator (headless)...'
    Start-Process -FilePath $emulator -ArgumentList $arguments -WindowStyle Hidden | Out-Null

    Write-Host 'Waiting for the device to appear...'
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 2
        $serial = Get-EmulatorSerial
        if ($serial) { break }
    }
    if (-not $serial) { throw 'Emulator did not come online. Check the hypervisor driver, then retry.' }
}
Write-Host "Device   : $serial"

# ---------- 3) 等待系统启动完成 ----------
Write-Host 'Waiting for boot to complete...'
$booted = $false
for ($i = 0; $i -lt 150; $i++) {
    $value = (& $adb -s $serial shell getprop sys.boot_completed 2>$null | Out-String).Trim()
    if ($value -eq '1') { $booted = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $booted) { throw 'Boot did not complete within 5 minutes.' }
Write-Host 'Boot completed.'

# 解锁屏幕，保证应用界面可用
& $adb -s $serial shell input keyevent 82 2>$null | Out-Null
& $adb -s $serial shell wm dismiss-keyguard 2>$null | Out-Null

# ---------- 4) 安装 APK ----------
if (-not $NoInstall) {
    $apk = Get-ChildItem (Join-Path $repo 'app\build\outputs\apk\debug\app-debug.apk') -ErrorAction SilentlyContinue
    if ($apk) {
        Write-Host "Installing $($apk.Name) ..."
        & $adb -s $serial install -r -d $apk.FullName | ForEach-Object { Write-Host "  $_" }
    } else {
        Write-Host 'No APK found at app\build\outputs\apk\debug\app-debug.apk' -ForegroundColor Yellow
        Write-Host 'Build it first:  .\gradlew.bat assembleDebug' -ForegroundColor Yellow
    }
}

# ---------- 5) 打开应用 ----------
Write-Host 'Launching com.vitals.android ...'
& $adb -s $serial shell am start -n com.vitals.android/.MainActivity | Out-Null

Write-Host ''
Write-Host "READY. Device: $serial" -ForegroundColor Green
Write-Host 'Useful commands:'
Write-Host "  screenshot : & '$adb' -s $serial exec-out screencap -p > shot.png"
Write-Host "  logcat     : & '$adb' -s $serial logcat -s VitalsWeb VitalsDB VitalsUpdate"
Write-Host "  shell      : & '$adb' -s $serial shell"
