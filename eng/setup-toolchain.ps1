<#
.SYNOPSIS
    Install the Android build toolchain into .toolchain/ beside the repository.

.DESCRIPTION
    A fresh clone cannot build until a JDK and an Android SDK exist somewhere. This
    script puts both in <repo>/.toolchain/, which eng/toolchain.cjs prefers over the
    platform's own locations, so the build then works with no environment setup at all.

    It downloads rather than vendors on purpose: the SDK is several GB, Google's licence
    does not permit redistributing it, and the binaries are platform-specific — so it
    cannot live in the repository. `.toolchain/` is git-ignored; copy it between machines
    if you would rather not download again.

    The script does the mechanical parts and then *reports what it could not verify*.
    One thing it cannot decide for you: the ninja that ships with the SDK's CMake is
    1.10.x, which hardcodes a 260-character path guard this monorepo trips. -FixNinja
    replaces it. See docs/dev-environment.md for the diagnosis and the manual fallback.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File eng\setup-toolchain.ps1 -DryRun

    Show what would be downloaded and installed, and change nothing.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File eng\setup-toolchain.ps1 -FixNinja

    Install, then replace the SDK's ninja with a long-path-aware build.
#>
[CmdletBinding()]
param(
    # Print the plan and exit without downloading anything.
    [switch]$DryRun,
    # Also replace the SDK's bundled ninja (needs GitHub; see -FixNinja docs above).
    [switch]$FixNinja,
    # Reinstall even where a usable component is already present.
    [switch]$Force
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "eng/setup-toolchain.ps1 installs a Windows toolchain. On macOS or Linux, install a JDK and the Android SDK however you normally would; eng/toolchain.cjs will find them."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolchainRoot = Join-Path $repoRoot ".toolchain"
$jdkDir = Join-Path $toolchainRoot "jdk"
$sdkDir = Join-Path $toolchainRoot "android-sdk"

# --- the one place the versions live ----------------------------------------
#
# Read from eng/toolchain-versions.cjs rather than repeated here, so the installer and
# the resolver can never disagree about what "installed" means.
$versionsJson = & node -e "process.stdout.write(JSON.stringify(require(process.argv[1])))" (Join-Path $PSScriptRoot "toolchain-versions.cjs")
if ($LASTEXITCODE -ne 0 -or -not $versionsJson) { throw "could not read eng/toolchain-versions.cjs (is node on PATH?)" }
$V = $versionsJson | ConvertFrom-Json

function Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Note([string]$text) { Write-Host "    $text" -ForegroundColor Gray }
function Warn([string]$text) { Write-Host "!!  $text" -ForegroundColor Yellow }

Write-Host "toolchain   = $toolchainRoot"
Write-Host "jdk         = $jdkDir (JDK $($V.JDK_MAJOR))"
Write-Host "sdk         = $sdkDir"
Note ($(if ($DryRun) { "dry run: nothing will be downloaded" } else { "this downloads several GB" }))

# --- JDK ---------------------------------------------------------------------
$jdkReady = Test-Path (Join-Path $jdkDir "bin\java.exe")
if ($jdkReady -and -not $Force) {
    Step "JDK already present, skipping"
    Note $jdkDir
} else {
    $jdkUrl = $V.DOWNLOADS.jdk.Replace("{major}", "$($V.JDK_MAJOR)").Replace("{os}", "windows").Replace("{arch}", "x64")
    Step "JDK $($V.JDK_MAJOR) (Temurin)"
    Note $jdkUrl
    if (-not $DryRun) {
        # Cleared first: a half-extracted JDK left by an interrupted run would otherwise
        # look installed while `bin\java.exe` is missing.
        if (Test-Path $jdkDir) { Remove-Item $jdkDir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $jdkDir | Out-Null
        $zip = Join-Path $env:TEMP "mobileclaw-jdk.zip"
        Invoke-WebRequest -Uri $jdkUrl -OutFile $zip -UseBasicParsing
        $staging = Join-Path $env:TEMP "mobileclaw-jdk"
        if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $staging -Force
        # Adoptium archives wrap everything in a single `jdk-<version>` directory.
        $inner = Get-ChildItem -Path $staging -Directory | Select-Object -First 1
        if (-not $inner) { throw "the JDK archive did not contain a directory; inspect $zip" }
        Get-ChildItem -Path $inner.FullName | Move-Item -Destination $jdkDir -Force
        Remove-Item $zip, $staging -Recurse -Force -ErrorAction SilentlyContinue
        Step "installed"
        Note (& (Join-Path $jdkDir "bin\java.exe") -version 2>&1 | Select-Object -First 1)
    }
}

# --- Android SDK -------------------------------------------------------------
$sdkManager = Join-Path $sdkDir "cmdline-tools\latest\bin\sdkmanager.bat"
if ((Test-Path $sdkManager) -and -not $Force) {
    Step "cmdline-tools already present, skipping"
    Note $sdkManager
} else {
    Step "Android command-line tools"
    if ($DryRun) {
        Note "would read $($V.DOWNLOADS.sdkIndex) for the current build, then download it"
    } else {
        # The build number changes every few weeks, so it is read from the index rather
        # than pinned — a pinned one is a guaranteed 404 eventually.
        $index = (Invoke-WebRequest -Uri $V.DOWNLOADS.sdkIndex -UseBasicParsing).Content
        $builds = [regex]::Matches($index, 'commandlinetools-win-(\d+)_latest\.zip') |
            ForEach-Object { [int]$_.Groups[1].Value }
        if (-not $builds) { throw "no commandlinetools-win-*_latest.zip found in the SDK index; Google may have reshaped it" }
        $build = ($builds | Sort-Object -Descending | Select-Object -First 1)
        $name = "commandlinetools-win-${build}_latest.zip"
        Note "$($V.DOWNLOADS.sdkBase)$name"
        $zip = Join-Path $env:TEMP $name
        Invoke-WebRequest -Uri "$($V.DOWNLOADS.sdkBase)$name" -OutFile $zip -UseBasicParsing
        $staging = Join-Path $env:TEMP "mobileclaw-cmdline-tools"
        if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $staging -Force
        # The archive contains a bare `cmdline-tools/`; sdkmanager only accepts it under
        # `cmdline-tools/latest/`, which is where the SDK looks for it.
        New-Item -ItemType Directory -Force -Path (Join-Path $sdkDir "cmdline-tools") | Out-Null
        $target = Join-Path $sdkDir "cmdline-tools\latest"
        if (Test-Path $target) { Remove-Item $target -Recurse -Force }
        Move-Item -Path (Join-Path $staging "cmdline-tools") -Destination $target
        Remove-Item $zip, $staging -Recurse -Force -ErrorAction SilentlyContinue
        Step "installed"
    }
}

Step "SDK packages"
foreach ($package in $V.SDK_PACKAGES) { Note $package }
if ($DryRun) {
    Note "would run: sdkmanager --sdk_root=$sdkDir $($V.SDK_PACKAGES -join ' ')"
} elseif (Test-Path $sdkManager) {
    # Licences first: sdkmanager refuses to install without them, and there is no
    # non-interactive flag, so the prompt is answered from the pipeline.
    Note "accepting licences"
    ("y`n" * 40) | & $sdkManager "--sdk_root=$sdkDir" "--licenses" | Out-Null
    & $sdkManager "--sdk_root=$sdkDir" @($V.SDK_PACKAGES)
    if ($LASTEXITCODE -ne 0) { throw "sdkmanager exited $LASTEXITCODE; the packages above were not all installed" }
    Step "installed"
}

# --- ninja -------------------------------------------------------------------
#
# Not fixable automatically with confidence: the SDK's copy is 1.10.x and this repo's
# paths break it, but the replacement has to be a build that knows about long paths.
Step "ninja"
$ninjaPaths = @(
    (Join-Path $sdkDir "cmake\$($V.CMAKE_VERSION)\bin\ninja.exe"),
    (Join-Path $sdkDir "cmake\$($V.CMAKE_TEMPLATE_VERSION)\bin\ninja.exe")
)

if ($FixNinja) {
    Note "downloading $($V.DOWNLOADS.ninja)"
    if (-not $DryRun) {
        $zip = Join-Path $env:TEMP "mobileclaw-ninja.zip"
        try {
            Invoke-WebRequest -Uri $V.DOWNLOADS.ninja -OutFile $zip -UseBasicParsing
        } catch {
            throw "could not download ninja from GitHub ($($_.Exception.Message)). On a network that blocks it, download ninja-win.zip by hand from the URL above and put ninja.exe in the two paths listed below."
        }
        $staging = Join-Path $env:TEMP "mobileclaw-ninja"
        if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $staging -Force
        $ninja = Join-Path $staging "ninja.exe"
        if (-not (Test-Path $ninja)) { throw "the ninja archive did not contain ninja.exe" }
        foreach ($target in $ninjaPaths) {
            if (-not (Test-Path $target)) { Warn "no ninja at $target (is cmake installed?)"; continue }
            # Both copies must be replaced: eng/pin-cmake-version.init.gradle only covers
            # com.android.library, so :app still builds with the template's CMake.
            # Named after what is inside it, which is what the manual procedure in
            # docs/dev-environment.md calls it, so the two agree.
            $backup = Join-Path (Split-Path -Parent $target) "ninja-$($V.NINJA_BUNDLED_VERSION).exe.bak"
            if (-not (Test-Path $backup)) { Copy-Item $target $backup }
            Copy-Item $ninja $target -Force
            Note "replaced $target"
        }
        Remove-Item $zip, $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    $reported = $false
    foreach ($target in $ninjaPaths) {
        if (-not (Test-Path $target)) { continue }
        $reported = $true
        Note $target
    }
    if (-not $reported) {
        Note "no ninja found yet (install the cmake; package first)"
    } else {
        Warn "the SDK's ninja is 1.10.x, which hardcodes a 260-character path guard this monorepo trips."
        Warn "If a native build fails with 'Filename longer than 260 characters', re-run with -FixNinja,"
        Warn "or replace both copies by hand. The diagnosis and a manual fallback are in docs/dev-environment.md."
    }
}

# --- what the build will now find -------------------------------------------
if (-not $DryRun) {
    Step "resolving the toolchain the way eng/build-local.ps1 does"
    & node (Join-Path $PSScriptRoot "toolchain.cjs") "print"
    if ($LASTEXITCODE -ne 0) { throw "the toolchain still does not resolve; see the list above" }
}

Write-Host ""
Write-Host "done." -ForegroundColor Green
if ($DryRun) { Write-Host "  (dry run: re-run without -DryRun to install)" -ForegroundColor Gray }
