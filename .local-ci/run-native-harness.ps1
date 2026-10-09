#!/usr/bin/env pwsh
# 原生备份/导入/CSV 逻辑的离线验证台（不依赖设备或模拟器）
# 思路：把 VitalsDbHelper 等类编译到 JVM 上，用 stub 替代 android.database.*，
#       通过反射调用其静态/实例方法，验证 checksum、counts、schema 校验、preview 差异、merge 去重与 CSV 输出。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$harness = Join-Path $root '.local-ci\native-harness'
$java = 'D:\download3\Android Studio\jbr\bin\java.exe'
$javac = 'D:\download3\Android Studio\jbr\bin\javac.exe'
$androidJar = 'D:\download3\AndroidSdk\platforms\android-36\android.jar'
$orgjson = 'D:\download3\Android Studio\plugins\grazie\lib\org.json-json.jar'

if (-not (Test-Path $java)) { throw "未找到 JDK: $java" }
if (-not (Test-Path $androidJar)) { throw "未找到 android.jar: $androidJar" }

Write-Host "原生逻辑验证台"
Write-Host "  JDK   : $java"
Write-Host "  SDK   : $androidJar"
Write-Host "  org.json: $orgjson"
Write-Host ""
Write-Host "用法：由 Lead 在集成阶段填充 harness 源码后运行；当前仅完成环境检查。"
Get-ChildItem $harness -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { "  " + $_.FullName.Substring($harness.Length + 1) }
