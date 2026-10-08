<#
.SYNOPSIS
    构建 Android APK 并发布到 GitHub Release，供应用内置的「一键更新」使用。

.DESCRIPTION
    1) 读取 app/build.gradle 中的 versionName / versionCode；
    2) 调 gradlew assembleDebug 构建；
    3) 按约定命名 Vitals-Android-<versionName>.apk；
    4) 用 gh 创建或更新同名 Release 并上传 APK 资产。

    约定命名很重要：应用内更新会在 Release 资产中优先匹配文件名包含版本号的 .apk。

.PARAMETER SkipBuild
    跳过构建，直接上传 output 目录中已存在的 APK。

.PARAMETER Notes
    Release 说明；默认使用 CHANGELOG 中该版本的条目。

.EXAMPLE
    .\release.ps1
    .\release.ps1 -SkipBuild -Notes "修复扫码枪解析"
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$Notes,
    [string]$Repo = '9573351-crypto/vitals-biosample'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$android = Join-Path $root 'vitals-android'
# JDK：优先用 JAVA_HOME，否则回退 Android Studio 自带 JBR
if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    $candidates = @('D:\download3\Android Studio\jbr', 'D:\android-studio\Android\jbr', "$env:LOCALAPPDATA\Programs\Android Studio\jbr")
    $found = $candidates | Where-Object { Test-Path (Join-Path $_ 'bin\java.exe') } | Select-Object -First 1
    if (-not $found) { throw '未找到 JDK，请设置 JAVA_HOME 指向 JDK 17+' }
    $env:JAVA_HOME = $found
}
Write-Host "JAVA_HOME = $env:JAVA_HOME"

$gradleFile = Join-Path $android 'app\build.gradle'
$gradleText = Get-Content $gradleFile -Raw
$versionName = [regex]::Match($gradleText, "versionName\s+'([^']+)'").Groups[1].Value
$versionCode = [regex]::Match($gradleText, "versionCode\s+(\d+)").Groups[1].Value
if (-not $versionName) { throw "无法从 $gradleFile 读取 versionName" }
Write-Host "版本：$versionName (versionCode $versionCode)"

$outputDir = Join-Path $android 'output'
$apkName = "Vitals-Android-$versionName.apk"
$apkPath = Join-Path $outputDir $apkName

if (-not $SkipBuild) {
    Push-Location $android
    try {
        if (Test-Path '.\gradlew.bat') { & .\gradlew.bat assembleDebug } else { & gradle assembleDebug }
        if ($LASTEXITCODE -ne 0) { throw 'APK 构建失败' }
    } finally { Pop-Location }

    $built = Join-Path $android 'app\build\outputs\apk\debug\app-debug.apk'
    if (-not (Test-Path $built)) { throw "未找到构建产物：$built" }
    New-Item -ItemType Directory -Force $outputDir | Out-Null
    Copy-Item $built $apkPath -Force
} elseif (-not (Test-Path $apkPath)) {
    throw "未找到 $apkPath，请先去掉 -SkipBuild 构建一次"
}

if (-not $Notes) {
    $changelog = Join-Path $root 'CHANGELOG.md'
    if (Test-Path $changelog) {
        $lines = Get-Content $changelog
        $start = ($lines | Select-String -Pattern "^##\s+v?$([regex]::Escape($versionName))\s*$" | Select-Object -First 1).LineNumber
        if ($start) {
            $rest = $lines[$start..($lines.Count - 1)]
            $end = ($rest | Select-String -Pattern '^##\s' | Select-Object -First 1).LineNumber
            $Notes = if ($end) { ($rest[0..($end - 2)] -join "`n") } else { ($rest -join "`n") }
        }
    }
}
if (-not $Notes) { $Notes = "Vitals 生息 $versionName" }

$tag = "v$versionName"
Write-Host "创建/更新 Release $tag → $apkName"
$exists = gh release view $tag --repo $Repo 2>$null
if ($LASTEXITCODE -eq 0) {
    gh release upload $tag $apkPath --repo $Repo --clobber
} else {
    gh release create $tag $apkPath --repo $Repo --title $tag --notes $Notes
}
if ($LASTEXITCODE -ne 0) { throw 'Release 发布失败' }
Write-Host "完成：https://github.com/$Repo/releases/tag/$tag"
