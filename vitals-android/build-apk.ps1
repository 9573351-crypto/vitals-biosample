$ErrorActionPreference = 'Stop'
$javaExe = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\java.exe' } else { '' }
if (-not $javaExe -or -not (Test-Path -LiteralPath $javaExe)) {
    $javaCandidates = @(
        'D:\android-studio\Android\jbr',
        (Join-Path $env:ProgramFiles 'Android\Android Studio\jbr')
    )
    $javaHome = $javaCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\java.exe') } | Select-Object -First 1
    if (-not $javaHome) { throw 'JDK 17+ not found. Set JAVA_HOME or install Android Studio.' }
    $env:JAVA_HOME = $javaHome
}
Push-Location $PSScriptRoot
try {
    $gradle = Get-Content -LiteralPath '.\app\build.gradle' -Raw
    if ($gradle -notmatch "versionName\s+'([^']+)'") { throw 'Cannot read versionName from app/build.gradle.' }
    $versionName = $Matches[1]
    & .\gradlew.bat assembleDebug
    if ($LASTEXITCODE -ne 0) { throw 'APK build failed' }
    New-Item -ItemType Directory -Force .\output | Out-Null
    Copy-Item .\app\build\outputs\apk\debug\app-debug.apk ".\output\Vitals-Android-$versionName.apk"
} finally { Pop-Location }
