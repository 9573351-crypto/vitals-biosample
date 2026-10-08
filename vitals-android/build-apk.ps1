$ErrorActionPreference = 'Stop'
$env:JAVA_HOME = 'D:\android-studio\Android\jbr'
Push-Location $PSScriptRoot
try {
    & .\gradlew.bat assembleDebug
    if ($LASTEXITCODE -ne 0) { throw 'APK build failed' }
    New-Item -ItemType Directory -Force .\output | Out-Null
    Copy-Item .\app\build\outputs\apk\debug\app-debug.apk .\output\Vitals-Android-1.10.0.apk
} finally { Pop-Location }
