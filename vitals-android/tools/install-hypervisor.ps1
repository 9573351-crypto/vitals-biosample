# 安装 Android 模拟器硬件加速驱动（AEHD / gvm）
# 必须以管理员身份运行：右键「以管理员身份运行 PowerShell」，然后执行：
#   powershell -ExecutionPolicy Bypass -File tools\install-hypervisor.ps1
# 脚本会在结束时做一次 -accel-check 自检并打印结果。
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'This script must run as Administrator.' -ForegroundColor Red
    Write-Host 'Right-click PowerShell -> Run as administrator, then re-run this file.' -ForegroundColor Red
    exit 1
}

# 定位 SDK
$sdkCandidates = @()
if ($env:ANDROID_HOME) { $sdkCandidates += $env:ANDROID_HOME }
if ($env:ANDROID_SDK_ROOT) { $sdkCandidates += $env:ANDROID_SDK_ROOT }
$sdkCandidates += 'D:\download3\AndroidSdk', 'D:\android-studio\SDK'
$sdk = $sdkCandidates | Where-Object { $_ -and (Test-Path (Join-Path $_ 'emulator\emulator.exe')) } | Select-Object -First 1
if (-not $sdk) { throw 'Android SDK not found.' }

$driverDir = Join-Path $sdk 'extras\google\Android_Emulator_Hypervisor_Driver'
$emulator = Join-Path $sdk 'emulator\emulator.exe'

if (-not (Test-Path $driverDir)) {
    Write-Host "Driver package missing: $driverDir" -ForegroundColor Yellow
    Write-Host 'Download it first (no admin needed):' -ForegroundColor Yellow
    $sdkManager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
    Write-Host "  `"$sdkManager`" --sdk_root=`"$sdk`" `"extras;google;Android_Emulator_Hypervisor_Driver`"" -ForegroundColor Yellow
    exit 1
}

Write-Host "SDK        : $sdk"
Write-Host "Driver dir : $driverDir"
Write-Host ''
Write-Host 'Stopping any running emulator processes...'
Get-Process -Name emulator, qemu-system-x86_64 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 优先用 safe 版本：它兼容启用 Hyper-V / 内核隔离（内存完整性）的机器
foreach ($script in @('silent_install_safe.bat', 'silent_install.bat')) {
    $path = Join-Path $driverDir $script
    if (-not (Test-Path $path)) { continue }
    Write-Host "Running $script ..."
    $process = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$path`"" -WorkingDirectory $driverDir -Wait -PassThru
    Write-Host "  exit code: $($process.ExitCode)"
    Start-Sleep -Seconds 3
    $install = (& $emulator -accel-check 2>&1 | Out-String)
    Write-Host $install.Trim()
    if ($install -match 'is installed' -and $install -notmatch 'not installed') {
        Write-Host ''
        Write-Host 'Hardware acceleration is ready.' -ForegroundColor Green
        exit 0
    }
}

Write-Host ''
Write-Host 'AEHD could not be verified. Alternative: enable Windows Hypervisor Platform' -ForegroundColor Yellow
Write-Host '(requires a reboot):' -ForegroundColor Yellow
Write-Host '  Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All' -ForegroundColor Yellow
Write-Host ''
& $emulator -accel-check
exit 1
