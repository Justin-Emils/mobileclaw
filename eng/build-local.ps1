#Requires -Version 5.1
<#
.SYNOPSIS
    Build the Android APK locally, using the toolchain in E:\code\Eng.

.DESCRIPTION
    The EAS cloud build works but is slow (queue + ~15 min) and capped by quota.
    This machine already has a complete Android toolchain, so local builds are
    faster and unlimited:

        E:\code\Eng\.jdk21            Temurin 21        (PATH has only Java 8)
        E:\code\Eng\.android-sdk      build-tools 36, platforms/android-36,
                                      ndk 27.1.12297006, platform-tools (adb)
        E:\code\Eng\.gradle-home      warmed Gradle 9.3.1 cache

    The script deliberately does NOT commit the generated android/ directory: it is
    produced by `expo prebuild` from app.config.ts, so the config plugins (the
    <queries> block, the all-files permission, the Play-safe variant) remain the
    single source of truth.

.PARAMETER Variant
    debug    — fastest, debuggable, signed with the debug key
    release  — optimised; signed with a local keystore if one is configured,
               otherwise with the debug key (see -GenerateKeystore)

.PARAMETER Clean
    Wipe android/ and re-run prebuild before building.

.PARAMETER GenerateKeystore
    Create eng/mobileclaw.keystore and the signing entry in android/gradle.properties,
    so local release builds stay signed consistently. Needed because a locally built
    APK cannot be installed *over* the EAS-built one: Android refuses a signature
    change, so switching to local builds requires one uninstall.

.PARAMETER Install
    Install to the connected device with adb after a successful build.
#>
[CmdletBinding()]
param(
    [ValidateSet("debug", "release")]
    [string]$Variant = "debug",
    [switch]$Clean,
    [switch]$GenerateKeystore,
    [switch]$Install
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot "apps\mobile"
$androidDir = Join-Path $appDir "android"

# --- toolchain -------------------------------------------------------------
$jdk = "E:\code\Eng\.jdk21"
$sdk = "E:\code\Eng\.android-sdk"
$gradleHome = "E:\code\Eng\.gradle-home"

foreach ($p in @($jdk, $sdk, $gradleHome)) {
    if (-not (Test-Path $p)) { throw "required toolchain path missing: $p" }
}

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:GRADLE_USER_HOME = $gradleHome
# Git operations inside Gradle/npm must not use the local proxy (it breaks TLS).
$env:NO_PROXY = "*"
$env:no_proxy = "*"
# The Expo Gradle plugin requires NODE_ENV: it decides env-file handling and
# whether the JS bundle is produced, and warns loudly when it is missing.
$env:NODE_ENV = if ($Variant -eq "release") { "production" } else { "development" }

Write-Host "JAVA_HOME   = $env:JAVA_HOME"
Write-Host "ANDROID_HOME= $env:ANDROID_HOME"
Write-Host "GRADLE_HOME = $env:GRADLE_USER_HOME"
Write-Host "variant     = $Variant"

# Fail loudly rather than letting Gradle pick up Java 8 from PATH.
#
# `java -version` writes its banner to stderr and exits 0. Merge the streams so the
# banner is captured, and keep $ErrorActionPreference from turning it into a throw.
$javaVersion = "unknown"
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $banner = & (Join-Path $jdk "bin\java.exe") -version 2>&1
    $first = @($banner) | Where-Object { "$_".Trim() -ne "" } | Select-Object -First 1
    if ($first) { $javaVersion = "$first".Trim() }
} catch {
    $javaVersion = "could not query java: $($_.Exception.Message)"
} finally {
    $ErrorActionPreference = $prevEap
}
Write-Host "java        = $javaVersion"

# --- prebuild --------------------------------------------------------------
if ($Clean -and (Test-Path $androidDir)) {
    Write-Host "removing $androidDir" -ForegroundColor Yellow
    Remove-Item $androidDir -Recurse -Force
}

if (-not (Test-Path $androidDir)) {
    Write-Host "`n=== expo prebuild ===" -ForegroundColor Cyan
    # Invoke the local CLI directly rather than through `npx --no-install`, which
    # fails to resolve the binary in this pnpm workspace layout.
    $expoCli = Join-Path $appDir "node_modules\.bin\expo.cmd"
    if (-not (Test-Path $expoCli)) {
        throw "expo CLI not found at $expoCli (run `pnpm install` at the repo root)"
    }
    Push-Location $appDir
    try {
        # --no-install: dependencies are already installed at the workspace root.
        & $expoCli prebuild --platform android --no-install
        if ($LASTEXITCODE -ne 0) { throw "expo prebuild failed ($LASTEXITCODE)" }
    }
    finally { Pop-Location }
}

# --- keystore --------------------------------------------------------------
$keystorePath = Join-Path $PSScriptRoot "mobileclaw.keystore"
$gradleProps = Join-Path $androidDir "gradle.properties"

if ($GenerateKeystore -and -not (Test-Path $keystorePath)) {
    Write-Host "`n=== generating a local release keystore ===" -ForegroundColor Cyan
    $keytool = Join-Path $jdk "bin\keytool.exe"
    & $keytool -genkeypair -v `
        -keystore $keystorePath `
        -alias mobileclaw `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass mobileclaw -keypass mobileclaw `
        -dname "CN=MobileClaw, OU=local, O=MobileClaw, L=, S=, C=CN"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed ($LASTEXITCODE)" }

    $entry = @"

# --- local release signing (added by eng/build-local.ps1) -------------------
MOBILECLAW_UPLOAD_STORE_FILE=$($keystorePath -replace '\\','\\')
MOBILECLAW_UPLOAD_KEY_ALIAS=mobileclaw
MOBILECLAW_UPLOAD_STORE_PASSWORD=mobileclaw
MOBILECLAW_UPLOAD_KEY_PASSWORD=mobileclaw
"@
    Add-Content -Path $gradleProps -Value $entry -Encoding UTF8
    Write-Host "keystore written to $keystorePath and wired into gradle.properties" -ForegroundColor Green
    Write-Host "NOTE: local builds cannot upgrade an EAS-built install; uninstall once." -ForegroundColor Yellow
}

# --- build -----------------------------------------------------------------
#
# Use the Gradle that is already extracted in the shared GRADLE_USER_HOME instead
# of android/gradlew. The wrapper hashes its own path from gradle-wrapper.properties
# and would re-download the distribution, which times out on this network — even
# though a complete copy sits right there with a .ok marker.
$gradleBat = Get-ChildItem -Path (Join-Path $gradleHome "wrapper\dists") -Filter "gradle.bat" -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\bin\\gradle\.bat$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

if ($gradleBat) {
    $gradleCmd = $gradleBat.FullName
    Write-Host "gradle      = $gradleCmd" -ForegroundColor Gray
} else {
    $gradleCmd = Join-Path $androidDir "gradlew.bat"
    Write-Host "gradle      = $gradleCmd (wrapper; may need to download)" -ForegroundColor Yellow
}
if (-not (Test-Path $gradleCmd)) { throw "no usable gradle found" }

$task = if ($Variant -eq "release") { "assembleRelease" } else { "assembleDebug" }
Write-Host "`n=== gradle $task ===" -ForegroundColor Cyan

# Pin CMake 3.30.5: the SDK's default 3.22.1 emits a self-regeneration rule with no
# declared inputs and `restat = 1`, so ninja re-runs CMake until it aborts with
# "build.ninja still dirty after 100 tries". See eng/pin-cmake-version.init.gradle.
$initScript = Join-Path $PSScriptRoot "pin-cmake-version.init.gradle"
$initArgs = @()
if (Test-Path $initScript) {
    $initArgs = @("-I", $initScript)
    Write-Host "cmake pin   = via $([System.IO.Path]::GetFileName($initScript))" -ForegroundColor Gray
} else {
    Write-Host "cmake pin   = MISSING (build will likely fail on CMake 3.22)" -ForegroundColor Yellow
}

Push-Location $androidDir
try {
    # No --no-daemon: on Windows it makes Gradle's file handling interact badly with
    # ninja, and the warm daemon is substantially faster.
    #
    # $ErrorActionPreference must be relaxed for the call: Gradle and javac write
    # ordinary progress and deprecation warnings to stderr, and with 'Stop' the first
    # one aborts the build as a NativeCommandError — which silently truncated this
    # build midway through Java compilation.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $gradleCmd $task --console=plain @initArgs
        $gradleExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if ($gradleExit -ne 0) { throw "gradle $task failed ($gradleExit)" }
}
finally { Pop-Location }

# --- locate the artifact ---------------------------------------------------
$apkDir = Join-Path $androidDir "app\build\outputs\apk\$Variant"
$apk = Get-ChildItem $apkDir -Filter "*.apk" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $apk) { throw "no APK produced under $apkDir" }

$outDir = Join-Path $repoRoot "artifacts"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$target = Join-Path $outDir "mobileclaw-local-$Variant.apk"
Copy-Item $apk.FullName $target -Force

Write-Host "`n=== build ok ===" -ForegroundColor Green
Write-Host "apk    : $target"
Write-Host "size   : $([math]::Round((Get-Item $target).Length / 1MB, 2)) MB"
Write-Host "elapsed: see timestamps above (Gradle cache is warm; first run downloads)"

if ($Install) {
    $adb = Join-Path $sdk "platform-tools\adb.exe"
    Write-Host "`n=== adb install ===" -ForegroundColor Cyan
    & $adb install -r $target
    if ($LASTEXITCODE -ne 0) {
        Write-Host "install failed. If this is a signature mismatch against the EAS build," -ForegroundColor Yellow
        Write-Host "uninstall once and retry:  adb uninstall dev.mobileclaw.app" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "installed" -ForegroundColor Green
}
