<#
.SYNOPSIS
    构建 Debug APK，并按「Vitals-Android-<版本>.apk」约定输出到 output\。

.DESCRIPTION
    版本号从 app/build.gradle 读取，避免产物文件名与代码版本不一致。
    JAVA_HOME 未设置时自动回退到常见 Android Studio JBR 路径。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$javaExe = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\java.exe' } else { '' }
if (-not $javaExe -or -not (Test-Path -LiteralPath $javaExe)) {
    $javaCandidates = @(
        'D:\download3\Android Studio\jbr',
        'D:\android-studio\Android\jbr',
        (Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Android Studio\jbr')
    )
    $javaHome = $javaCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\java.exe') } | Select-Object -First 1
    if (-not $javaHome) { throw 'JDK 17+ not found. Set JAVA_HOME or install Android Studio.' }
    $env:JAVA_HOME = $javaHome
}
Write-Host "JAVA_HOME = $env:JAVA_HOME"

Push-Location $PSScriptRoot
try {
    $gradle = Get-Content -LiteralPath '.\app\build.gradle' -Raw
    if ($gradle -notmatch "versionName\s+'([^']+)'") { throw 'Cannot read versionName from app/build.gradle.' }
    $versionName = $Matches[1]
    Write-Host "versionName = $versionName"

    & .\gradlew.bat assembleDebug
    if ($LASTEXITCODE -ne 0) { throw 'APK build failed' }

    $built = '.\app\build\outputs\apk\debug\app-debug.apk'
    if (-not (Test-Path -LiteralPath $built)) { throw "Build output not found: $built" }

    New-Item -ItemType Directory -Force .\output | Out-Null
    $target = ".\output\Vitals-Android-$versionName.apk"
    Copy-Item $built $target -Force

    $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
    Write-Host "已输出 $target"
    Write-Host "SHA-256  $hash"
} finally { Pop-Location }
