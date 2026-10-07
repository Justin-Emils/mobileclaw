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

# Recorded before any work: the artifact check at the end refuses to hand over an APK
# that predates this run, which is how a "successful" build was found shipping an
# older bundle.
$script:BuildStartedAt = Get-Date

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

# --- test overrides --------------------------------------------------------
#
# Passing these bakes an endpoint into the bundle so the app can run a real agent turn
# on an emulator without a cloud key. See `testOverrides` in
# apps/mobile/src/runtime/bootstrap.ts for the safety gates.
#
# Only meaningful for a throwaway test build: `__DEV__` gates the code, so a release
# bundling removes it — but the values are still visible in the bundle when set, so do
# not point this at a real account. Usage:
#   $env:MOBILECLAW_TEST_BASE_URL='http://10.0.2.2:8787/v1'
#   $env:MOBILECLAW_TEST_MODEL='mock-model'
#   $env:MOBILECLAW_TEST_API_KEY='sk-mock-local-key'
$overrideNames = @("MOBILECLAW_TEST_BASE_URL", "MOBILECLAW_TEST_MODEL", "MOBILECLAW_TEST_API_KEY")
$activeOverrides = $overrideNames | Where-Object { (Get-Item "env:$_" -ErrorAction SilentlyContinue).Value }
if ($activeOverrides.Count -gt 0) {
    Write-Host "test override = $($activeOverrides -join ', ') (baked into the JS bundle)" -ForegroundColor Yellow
    # Metro substitutes process.env.* at bundle time, so these must be set for the
    # Gradle call below, which is a child process.
    foreach ($name in $activeOverrides) {
        Set-Item "env:$name" (Get-Item "env:$name").Value
    }
} else {
    Write-Host "test override = none" -ForegroundColor Gray
}

# --- preflight: config integrity ------------------------------------------
#
# A stray `app.json` next to app.config.ts is dangerous, not cosmetic: Expo merges
# the static file with the dynamic config and static values win, so a 16-byte
# `{"expo": {}}` silently drops `android.permissions`, the `<queries>` block,
# `extra.eas.projectId` and `owner`. The APK then builds fine and is missing the
# all-files permission. One appeared in this repo (committed by a concurrent
# session) and was only caught by reading the generated manifest.
$strayAppJson = Join-Path $appDir "app.json"
if (Test-Path $strayAppJson) {
    $content = (Get-Content $strayAppJson -Raw -ErrorAction SilentlyContinue).Trim()
    Write-Host "`n!! app.json exists next to app.config.ts and overrides parts of it:" -ForegroundColor Red
    Write-Host "   $strayAppJson" -ForegroundColor Red
    Write-Host "   content: $content" -ForegroundColor Red
    Write-Host "   Expo merges static app.json over app.config.ts. Delete it unless intentional:" -ForegroundColor Yellow
    Write-Host "   Remove-Item '$strayAppJson'" -ForegroundColor Yellow
    throw "refusing to build while app.json shadows app.config.ts"
}
Write-Host "app.json    = absent (app.config.ts is the single config source)" -ForegroundColor Gray

# --- preflight: ninja version ---------------------------------------------
#
# ninja 1.10.2 (bundled with the SDK's CMake packages) lacks the
# RtlAreLongPathsEnabled check, so it rejects any path over 260 characters even
# though Windows long paths are enabled -- which is what made this project look
# unbuildable. 1.12.1 has the check and builds fine. The replacement is manual, so
# a `sdkmanager` reinstall of any cmake package silently reverts it and every
# build breaks again with "Filename longer than 260 characters".
$ninjaCandidates = @(
    (Join-Path $sdk "cmake\3.30.5\bin\ninja.exe"),
    (Join-Path $sdk "cmake\3.22.1\bin\ninja.exe")
)
$ninjaOk = $true
foreach ($ninja in $ninjaCandidates) {
    if (-not (Test-Path $ninja)) { continue }
    $ninjaVersion = (& $ninja --version 2>&1 | Select-Object -First 1).ToString().Trim()
    $needsLongPathSupport = $ninjaVersion -match '^1\.(10|11)\.'
    if ($needsLongPathSupport) {
        $ninjaOk = $false
        Write-Host "`n!! ninja $ninjaVersion at $ninja lacks long-path support" -ForegroundColor Red
        Write-Host "   It will fail with 'Filename longer than 260 characters'." -ForegroundColor Red
        Write-Host "   Fix: replace it with 1.12.1, keeping a backup (see docs/dev-environment.md)." -ForegroundColor Yellow
    } else {
        Write-Host "ninja       = $ninjaVersion  ($ninja)" -ForegroundColor Gray
    }
}
if (-not $ninjaOk) { throw "ninja is too old for this project's path lengths" }

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
    # The CLI sits next to the app under pnpm's isolated layout, but at the workspace
    # root once `nodeLinker: hoisted` (pnpm-workspace.yaml) flattens node_modules, so
    # check both instead of assuming one.
    $expoCandidates = @(
        (Join-Path $appDir "node_modules\.bin\expo.cmd"),
        (Join-Path $repoRoot "node_modules\.bin\expo.cmd")
    )
    $expoCli = $expoCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $expoCli) {
        throw "expo CLI not found (looked in: $($expoCandidates -join '; ')); run `pnpm install` at the repo root"
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
#
# Two independent steps, deliberately not nested under one condition:
#
#   1. create the keystore, only if missing
#   2. ensure android/gradle.properties carries the signing entries
#
# They were previously combined as `if ($GenerateKeystore -and -not (Test-Path
# $keystorePath))`, so once the keystore existed the properties were never written
# again. `-Clean` deletes android/ (and with it gradle.properties), after which a
# release build silently fell back to the debug key -- producing a "release" APK
# that could not be installed over an EAS build. Step 2 now runs on every build.
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
    Write-Host "keystore written to $keystorePath" -ForegroundColor Green
}

# Always reconcile gradle.properties with the keystore on disk. Prebuild regenerates
# android/ from the template, so these entries do not survive on their own.
if (Test-Path $keystorePath) {
    if (-not (Test-Path $gradleProps)) { throw "gradle.properties missing at $gradleProps" }
    $props = Get-Content $gradleProps -Raw
    if ($props -notmatch 'MOBILECLAW_UPLOAD_STORE_FILE') {
        $entry = @"

# --- local release signing (added by eng/build-local.ps1) -------------------
# Backslashes are escaped because this is read as Java properties, where a lone \
# is an escape character. The matching Gradle wiring lives in
# apps/mobile/app.config.ts as the withLocalReleaseSigning config plugin, so it
# survives `expo prebuild`.
MOBILECLAW_UPLOAD_STORE_FILE=$($keystorePath -replace '\\','\\')
MOBILECLAW_UPLOAD_KEY_ALIAS=mobileclaw
MOBILECLAW_UPLOAD_STORE_PASSWORD=mobileclaw
MOBILECLAW_UPLOAD_KEY_PASSWORD=mobileclaw
"@
        Add-Content -Path $gradleProps -Value $entry -Encoding UTF8
        Write-Host "signing  = eng/mobileclaw.keystore wired into android/gradle.properties" -ForegroundColor Green
    } else {
        Write-Host "signing  = eng/mobileclaw.keystore (already wired)" -ForegroundColor Gray
    }
    if ($Variant -eq "release") {
        Write-Host "NOTE: a locally signed release cannot upgrade an EAS-signed install; uninstall once." -ForegroundColor Yellow
    }
} elseif ($Variant -eq "release") {
    Write-Host "`n!! release build without a keystore: the APK will be signed with the DEBUG" -ForegroundColor Yellow
    Write-Host "   key and cannot be installed over an EAS build. Re-run with -GenerateKeystore." -ForegroundColor Yellow
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

# --- force a fresh JS bundle when the JS/TS sources changed ----------------
#
# Gradle does not treat the workspace packages (`packages/*`, imported through
# tsconfig paths and pnpm links) as inputs of `createBundleReleaseJsAndAssets`, so
# editing core code leaves that task UP-TO-DATE and the APK is packaged with the
# *previous* bundle. The build then reports success while shipping stale code — which
# is how a release APK came out missing changes that were committed minutes earlier.
#
# Rather than always re-bundling (slow), compare newest source mtime against the
# existing bundle and invalidate the bundling outputs only when sources are newer.
$bundlePath = Join-Path $androidDir "app\build\generated\assets\react\$Variant\index.android.bundle"
$sourceRoots = @(
    (Join-Path $repoRoot "apps\mobile\app"),
    (Join-Path $repoRoot "apps\mobile\src"),
    (Join-Path $repoRoot "packages\core\src"),
    (Join-Path $repoRoot "packages\capabilities\src")
)
$newestSource = $null
foreach ($sourceRoot in $sourceRoots) {
    if (-not (Test-Path $sourceRoot)) { continue }
    $candidate = Get-ChildItem $sourceRoot -Recurse -File -Include "*.ts", "*.tsx", "*.js", "*.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($candidate -and (-not $newestSource -or $candidate.LastWriteTime -gt $newestSource.LastWriteTime)) {
        $newestSource = $candidate
    }
}
if (Test-Path $bundlePath) {
    $bundleTime = (Get-Item $bundlePath).LastWriteTime
    if ($newestSource -and $newestSource.LastWriteTime -gt $bundleTime) {
        Write-Host "bundle      = stale (source $($newestSource.Name) newer than bundle); forcing re-bundle" -ForegroundColor Yellow
        # Deleting the bundle and its merged copy is what actually makes Gradle re-run
        # the task; --rerun-tasks would rebuild every native module too.
        Remove-Item $bundlePath -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $androidDir "app\build\intermediates\assets\$Variant\mergeReleaseAssets\index.android.bundle") -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $androidDir "app\build\intermediates\assets\$Variant\mergeDebugAssets\index.android.bundle") -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "bundle      = up to date" -ForegroundColor Gray
    }
} else {
    Write-Host "bundle      = not built yet" -ForegroundColor Gray
}

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

# Refuse to hand over an APK that predates this build. A stale artifact plus a
# successful-looking log is the worst outcome: it installs and behaves like the code
# from an earlier run.
$buildStart = $script:BuildStartedAt
if ($buildStart -and $apk.LastWriteTime -lt $buildStart) {
    throw "APK at $($apk.FullName) is older than this build (started $buildStart). Gradle reported success without repackaging; re-run with -Clean."
}
Write-Host "apk built   = $($apk.LastWriteTime)" -ForegroundColor Gray

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
