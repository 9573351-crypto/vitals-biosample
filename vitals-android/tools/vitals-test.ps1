# 生息样本库 · 测试台（唯一入口）
# 打开后会：确保模拟器窗口在运行 → 装机 → 打开应用，然后进入菜单。
#   [1] 实时镜像    打开/聚焦模拟器窗口（真机同款界面，可鼠标直接操作）
#   [2] 重新构建    构建 debug APK → 安装 → 重启应用（改完代码用这个）
#   [3] 设备测试    运行设备级数据库测试（43 条断言）
#   [4] 重启应用    强制停止后重新打开
#   [5] 截图        adb pull 一张当前界面到桌面
#   [6] 日志        实时 logcat（VitalsWeb / VitalsDB / VitalsUpdate）
#   [0] 退出        （模拟器窗口继续保留）
[CmdletBinding()]
param(
    [string]$Action,            # 跳过菜单直接执行：mirror | rebuild | test | restart | shot | log
    [switch]$NoInstall,         # 只确保窗口，不重装 APK
    [switch]$Quiet              # 少输出
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot          # vitals-android/
$avdName = 'vitals-test'
$pkg = 'com.vitals.android'
$activity = "$pkg/.MainActivity"

function Write-Head($text) { Write-Host ''; Write-Host "== $text ==" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [!] $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "  [X] $text" -ForegroundColor Red }

# ---------------- 环境解析 ----------------
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
if (-not $sdk) { Write-Err '找不到带 emulator 的 Android SDK'; exit 1 }
$emulator = Join-Path $sdk 'emulator\emulator.exe'
$adb = Join-Path $sdk 'platform-tools\adb.exe'
if (-not (Test-Path $adb)) { Write-Err "找不到 adb: $adb"; exit 1 }

$javaHome = 'D:\download3\Android Studio\jbr'
if (-not (Test-Path (Join-Path $javaHome 'bin\java.exe'))) {
    $javaHome = @('D:\android-studio\Android\jbr', (Join-Path $env:ProgramFiles 'Android\Android Studio\jbr')) |
        Where-Object { Test-Path (Join-Path $_ 'bin\java.exe') } | Select-Object -First 1
}
$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
if (-not $env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME = 'D:\download3\gradle-home' }

# adb 会把进度/提示写到 stderr（例如 "1 file pulled"），在 $ErrorActionPreference='Stop' 下会被当成
# 致命错误 —— 于是脚本明明成功却以 exit 1 退出。所有 adb 调用统一走这里：临时放宽为 Continue。
function Invoke-Adb {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AdbArgs)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return (& $adb @AdbArgs 2>&1 | Out-String) }
    finally { $ErrorActionPreference = $previous }
}
function Get-Serial {
    $line = (Invoke-Adb devices) -split "`r?`n" | Where-Object { $_ -match '^emulator-\d+\s+device' } | Select-Object -First 1
    if ($line) { return ($line -split '\s+')[0] }
    return $null
}
function Get-ApkPath { Join-Path $repo 'app\build\outputs\apk\debug\app-debug.apk' }

# ---------------- 1) 确保窗口在运行 ----------------
function Ensure-Emulator {
    Write-Head '实时镜像 / 模拟器窗口'
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $accel = (& $emulator -accel-check 2>&1 | Out-String)
    $ErrorActionPreference = $previous
    if ($accel -match 'not installed') {
        Write-Err '硬件加速驱动未安装，模拟器无法启动。'
        Write-Host "  请以管理员运行一次：$PSScriptRoot\install-hypervisor.ps1" -ForegroundColor Yellow
        exit 1
    }
    Write-Ok '硬件加速可用'

    $serial = Get-Serial
    if (-not $serial) {
        Write-Host '  正在打开模拟器窗口（首次会慢一些）…'
        Start-Process -FilePath $emulator -ArgumentList @(
            '-avd', $avdName, '-no-audio', '-no-boot-anim', '-no-snapshot',
            '-gpu', 'auto', '-scale', 'auto'
        ) | Out-Null
        for ($i = 0; $i -lt 90; $i++) {
            Start-Sleep -Seconds 2
            $serial = Get-Serial
            if ($serial) { break }
        }
        if (-not $serial) { Write-Err '模拟器未能上线'; exit 1 }
    } else {
        Write-Ok "模拟器已在运行：$serial"
    }

    for ($i = 0; $i -lt 150; $i++) {
        $boot = (Invoke-Adb -s $serial shell getprop sys.boot_completed).Trim()
        if ($boot -eq '1') { break }
        Start-Sleep -Seconds 2
    }
    Invoke-Adb -s $serial shell wm dismiss-keyguard | Out-Null
    Write-Ok "系统已就绪：$serial"
    return $serial
}

# ---------------- 2) 装机并打开应用 ----------------
function Install-And-Start($serial, $skipInstall) {
    $apk = Get-ApkPath
    if (-not $skipInstall) {
        if (-not (Test-Path $apk)) {
            Write-Warn '还没有 APK，先构建一次…'
            if (-not (Build-Apk)) { return }
        }
        Write-Host '  安装 APK…'
        $install = Invoke-Adb -s $serial install -r -d $apk
        if ($install -match 'Failure') { Write-Warn $install.Trim() } else { Write-Ok 'APK 已安装' }
    }
    Invoke-Adb -s $serial shell am start -n $activity | Out-Null
    Start-Sleep -Seconds 2
    Write-Ok '应用已打开'
}

# ---------------- 3) 构建 ----------------
function Build-Apk {
    Write-Head '构建 debug APK'
    Push-Location $repo
    try {
        $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $out = & .\gradlew.bat assembleDebug --console=plain 2>&1
        $code = $LASTEXITCODE
        $ErrorActionPreference = $previous
        if ($code -ne 0) { $out | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" }; Write-Err 'BUILD FAILED'; return $false }
        Write-Ok 'BUILD SUCCESSFUL'
        return $true
    } finally { Pop-Location }
}

# ---------------- 4) 设备测试 ----------------
function Run-DeviceTests($serial) {
    Write-Head '设备级数据库测试'
    Push-Location $repo
    try {
        $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & .\gradlew.bat assembleDebug assembleDebugAndroidTest --console=plain 2>&1 | Out-Null
        $ErrorActionPreference = $previous
    } finally { Pop-Location }

    $testApk = Join-Path $repo 'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk'
    if (-not (Test-Path $testApk)) { Write-Err '测试 APK 不存在'; return }
    Invoke-Adb -s $serial install -r -d (Get-ApkPath) | Out-Null
    Invoke-Adb -s $serial install -r -d $testApk | Out-Null
    $raw = Invoke-Adb -s $serial shell am instrument -w "$pkg.test/com.vitals.android.DatabaseInstrumentation"
    $pass = ($raw -split "`r?`n" | Where-Object { $_ -match '^PASS' }).Count
    $fail = ($raw -split "`r?`n" | Where-Object { $_ -match '^FAIL' }).Count
    ($raw -split "`r?`n" | Where-Object { $_ -match '^FAIL' } | Select-Object -First 5) | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    if ($fail -eq 0) { Write-Ok "设备测试通过：$pass / $($pass + $fail)" } else { Write-Err "设备测试失败：PASS=$pass FAIL=$fail" }
}

# ---------------- 5) 截图 ----------------
function Save-Screenshot($serial) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $name = '生息样本库-界面-' + (Get-Date -Format 'HHmmss') + '.png'
    $target = Join-Path $desktop $name
    $remote = '/sdcard/vitals-shot.png'
    Invoke-Adb -s $serial shell screencap -p $remote | Out-Null
    Invoke-Adb -s $serial pull $remote $target | Out-Null
    Invoke-Adb -s $serial shell rm -f $remote | Out-Null
    if (Test-Path $target) { Write-Ok "截图已保存到桌面：$name" } else { Write-Err '截图失败' }
}

# ---------------- 6) 日志 ----------------
function Show-Log($serial) {
    Write-Head '实时日志（Ctrl+C 返回菜单）'
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $adb -s $serial logcat -s VitalsWeb VitalsDB VitalsUpdate }
    finally { $ErrorActionPreference = $previous }
}

# ---------------- 聚焦窗口 ----------------
function Focus-Emulator {
    $procs = Get-Process -Name qemu-system-x86_64 -ErrorAction SilentlyContinue
    if (-not $procs) { Write-Warn '没有找到模拟器窗口进程'; return }
    if (-not ('Win32.EmulatorWindow' -as [type])) {
        Add-Type -Namespace Win32 -Name EmulatorWindow -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
    }
    foreach ($p in $procs) {
        if ($p.MainWindowHandle -ne 0) {
            [Win32.EmulatorWindow]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
            [Win32.EmulatorWindow]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
            Write-Ok '已聚焦模拟器窗口（这就是安卓端的实时画面，可直接用鼠标操作）'
            return
        }
    }
    Write-Warn '模拟器窗口没有可见句柄（可能是无窗口模式启动的）：关掉模拟器后重开本测试台即可'
}

# ---------------- 菜单 ----------------
function Show-Menu($serial) {
    Write-Host ''
    Write-Host '  ┌────────────────────────────────────────────┐' -ForegroundColor DarkGray
    Write-Host '  │  生息样本库 · 测试台                        │' -ForegroundColor White
    Write-Host '  ├────────────────────────────────────────────┤' -ForegroundColor DarkGray
    Write-Host '  │  1  实时镜像   聚焦模拟器窗口（默认动作）   │' -ForegroundColor White
    Write-Host '  │  2  重新构建   构建 → 安装 → 重启应用        │' -ForegroundColor White
    Write-Host '  │  3  设备测试   数据库断言（43 条）           │' -ForegroundColor White
    Write-Host '  │  4  重启应用                                │' -ForegroundColor White
    Write-Host '  │  5  截图       保存到桌面                    │' -ForegroundColor White
    Write-Host '  │  6  日志       实时 logcat                   │' -ForegroundColor White
    Write-Host '  │  0  退出       模拟器窗口保持打开             │' -ForegroundColor White
    Write-Host '  └────────────────────────────────────────────┘' -ForegroundColor DarkGray
    Write-Host "   设备 $serial   包名 $pkg" -ForegroundColor DarkGray
}

# ---------------- 主流程 ----------------
$serial = Ensure-Emulator
if (-not $NoInstall) { Install-And-Start $serial $false }

switch ($Action) {
    'mirror'  { Focus-Emulator; exit 0 }
    'rebuild' { if (Build-Apk) { Install-And-Start $serial $false }; exit 0 }
    'test'    { Run-DeviceTests $serial; exit 0 }
    'restart' { Install-And-Start $serial $true; exit 0 }
    'shot'    { Save-Screenshot $serial; exit 0 }
    'log'     { Show-Log $serial; exit 0 }
}

Focus-Emulator
while ($true) {
    Show-Menu $serial
    $choice = Read-Host '  选择'
    switch ($choice) {
        '1' { Focus-Emulator }
        '2' { if (Build-Apk) { Install-And-Start $serial $false } }
        '3' { Run-DeviceTests $serial }
        '4' { Install-And-Start $serial $true }
        '5' { Save-Screenshot $serial }
        '6' { Show-Log $serial }
        '0' { Write-Host '  已退出（模拟器窗口仍在运行）。' -ForegroundColor DarkGray; exit 0 }
        default { Write-Warn '请输入 0-6' }
    }
}
