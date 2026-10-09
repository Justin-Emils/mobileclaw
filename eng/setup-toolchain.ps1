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
    [switch]$Force,
    # Reuse a Gradle home that is already installed and warm, instead of downloading
    # Gradle into .toolchain/gradle-home. For a machine that already builds this repo
    # (or a colleague sharing one), this is the difference between a first build that
    # starts immediately and one that downloads a distribution and every dependency.
    [string]$GradleHome
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "eng/setup-toolchain.ps1 installs a Windows toolchain. On macOS or Linux, install a JDK and the Android SDK however you normally would; eng/toolchain.cjs will find them."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolchainRoot = Join-Path $repoRoot ".toolchain"
$jdkDir = Join-Path $toolchainRoot "jdk"
$sdkDir = Join-Path $toolchainRoot "android-sdk"
$gradleHome = Join-Path $toolchainRoot "gradle-home"

# --- the one place the versions live ----------------------------------------
#
# Read from eng/toolchain-versions.cjs rather than repeated here, so the installer and
# the resolver can never disagree about what "installed" means.
$versionsJson = & node -e "process.stdout.write(JSON.stringify(require(process.argv[1])))" (Join-Path $PSScriptRoot "toolchain-versions.cjs")
if ($LASTEXITCODE -ne 0 -or -not $versionsJson) { throw "could not read eng/toolchain-versions.cjs (is node on PATH?)" }
$V = $versionsJson | ConvertFrom-Json

# The artifact host is throttled, so a stalled socket is expected rather than
# exceptional: long timeouts, and retries that resume instead of starting over.
#
# Declared before the functions below because PowerShell resolves a script-scope
# variable at call time: a constant written after its only reader looks like dead
# code and invites the next person to delete it.
#
# No digit separators (`120_000`): that is PowerShell 7 syntax, and `eng/BUILD.md`
# invokes this file through `powershell.exe`, which on Windows is 5.1. There the
# literal parses as `120` followed by the bare token `_000`, and the script dies with
# "The term '120_000' is not recognized as the name of a cmdlet" before printing a
# single line -- an error that names the *number* and gives no hint that the cause is
# the host's PowerShell version.
$HTTP_TIMEOUT_MS = 120000
$BUFFER_BYTES = 1MB
$PROGRESS_SECONDS = 5
$DOWNLOAD_ATTEMPTS = 4

function Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Note([string]$text) { Write-Host "    $text" -ForegroundColor Gray }
function Warn([string]$text) { Write-Host "!!  $text" -ForegroundColor Yellow }

<#
.SYNOPSIS
    The first line a native tool prints, without letting its stderr abort the script.

.DESCRIPTION
    `java -version` reports itself on **stderr**, and this script runs under
    `$ErrorActionPreference = "Stop"`. In Windows PowerShell 5.1 a native command's
    stderr record is an ErrorRecord, so `2>&1` into a pipeline turns a successful
    version check into a terminating `NativeCommandError` -- the install had already
    succeeded and the script died printing that it had.

    `EAP = "Continue"` is restored in `finally` rather than being assumed: leaving the
    script-wide preference lowered would convert every later failure into a silent
    continuation, which is a much worse bug than the one being fixed.
#>
function Get-NativeBanner([string]$Exe, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $lines = & $Exe @Arguments 2>&1
    } finally {
        $ErrorActionPreference = $previous
    }
    $first = $lines | Select-Object -First 1
    if ($null -eq $first) { return "(no output)" }
    return "$first".Trim()
}

<#
.SYNOPSIS
    Stream a large file to disk, resuming a partial download when one is there.

.DESCRIPTION
    `Invoke-WebRequest` is not usable for these artifacts. Measured on this project's
    network, it sat at 0 bytes for five minutes on the 205 MB JDK while the same URL
    through this function sustained ~560 KB/s -- because it buffers the response before
    writing anything, and because the endpoint redirects to a rate-limited asset host.
    A setup step that appears to hang is worse than one that fails.

    The file is written as it arrives, so an interrupted transfer leaves a partial file
    rather than nothing, and the next run sends a Range header to continue from where it
    stopped. That matters more than speed here: the artifact comes from a throttled host,
    and a stalled socket is a matter of when, not if.

    Returns `Complete` when the expected number of bytes is on disk, otherwise
    `Partial` (safe to retry) or `Failed` (a permanent error, e.g. HTTP 404).
#>
function Save-StreamedFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Path,
        # Bytes to expect. When known, it drives the progress readout, the resume
        # offset and the completeness check; when not, a plain full download is done.
        [long]$ExpectedSize = 0
    )

    # Start from the Range header when a partial file is already here.
    $startAt = 0L
    if (Test-Path $Path) {
        $startAt = (Get-Item $Path).Length
        if ($ExpectedSize -gt 0 -and $startAt -ge $ExpectedSize) {
            Note "already complete ($(Format-Bytes $startAt)), nothing to download"
            return "Complete"
        }
        if ($startAt -gt 0) { Note ("resuming at {0}" -f (Format-Bytes $startAt)) }
    }
    $request = [System.Net.HttpWebRequest]::Create($Uri)
    # Both are the same generous value on purpose: this host stalls, and a timeout here
    # is not a diagnosis, it is an interruption that costs the user the whole download.
    $request.Timeout = $HTTP_TIMEOUT_MS
    $request.ReadWriteTimeout = $HTTP_TIMEOUT_MS
    $request.AllowAutoRedirect = $true
    $request.UserAgent = "mobileclaw-setup-toolchain"
    if ($startAt -gt 0) { $request.AddRange($startAt) }

    try {
        $response = $request.GetResponse()
    } catch {
        if ($startAt -gt 0) {
            Warn "resume request failed ($($_.Exception.Message))"
            return "Partial"
        }
        Warn "request failed: $($_.Exception.Message)"
        return "Failed"
    }

    try {
        $status = [int]$response.StatusCode
        # Asked to resume but the host ignored the Range header: start over rather than
        # appending a second copy to the front of the file.
        if ($startAt -gt 0 -and $status -ne 206) {
            Warn "the host ignored the resume request; downloading in full"
            $startAt = 0
        }

        $length = $response.ContentLength
        # The size is learned from the response rather than pinned: it is a live redirect
        # target whose artifact changes with every JDK patch release, and a constant here
        # would be wrong within weeks.
        if ($length -gt 0) { $ExpectedSize = $startAt + $length }
        if ($ExpectedSize -gt 0 -and $startAt -ge $ExpectedSize) {
            Note "already complete ($(Format-Bytes $startAt)), nothing to download"
            return "Complete"
        }

        $mode = if ($startAt -gt 0) { [System.IO.FileMode]::Append } else { [System.IO.FileMode]::Create }
        $target = [System.IO.File]::Open($Path, $mode, [System.IO.FileAccess]::Write)
        try {
            $stream = $response.GetResponseStream()
            $buffer = New-Object byte[] $BUFFER_BYTES
            $total = $startAt
            # Speed is measured against what *this* transfer moved. Reporting the running
            # total over this run's clock credits the transfer with bytes an earlier run
            # fetched, which is how "195.6 MB in 1s" gets printed for a resumed download.
            $fetched = 0L
            $watch = [System.Diagnostics.Stopwatch]::StartNew()
            $lastReport = $watch.Elapsed

            while ($true) {
                $read = $stream.Read($buffer, 0, $buffer.Length)
                if ($read -le 0) { break }
                $target.Write($buffer, 0, $read)
                $total += $read
                $fetched += $read

                if (($watch.Elapsed - $lastReport).TotalSeconds -ge $PROGRESS_SECONDS) {
                    $lastReport = $watch.Elapsed
                    $speed = if ($watch.Elapsed.TotalSeconds -gt 0) { $fetched / $watch.Elapsed.TotalSeconds } else { 0 }
                    $pct = if ($ExpectedSize -gt 0) { " ({0:N0}%)" -f (100 * $total / $ExpectedSize) } else { "" }
                    Note ("{0}{1} at {2}/s" -f (Format-Bytes $total), $pct, (Format-Bytes $speed))
                }
            }
            $stream.Close()
            $watch.Stop()
        } finally {
            $target.Close()
        }

        $onDisk = (Get-Item $Path).Length
        if ($ExpectedSize -gt 0 -and $onDisk -lt $ExpectedSize) {
            Warn ("incomplete: {0} of {1} - re-run to continue" -f (Format-Bytes $onDisk), (Format-Bytes $ExpectedSize))
            return "Partial"
        }
        Note ("downloaded {0} ({1} fetched) in {2:N0}s" -f (Format-Bytes $onDisk), (Format-Bytes $fetched), $watch.Elapsed.TotalSeconds)
        return "Complete"
    } catch {
        # A socket that stalls or drops leaves the bytes received so far in place for
        # the next run, so this is reported as retryable rather than fatal.
        Warn "transfer interrupted: $($_.Exception.Message)"
        return "Partial"
    } finally {
        $response.Close()
    }
}

function Format-Bytes([long]$value) {
    if ($value -ge 1GB) { return "{0:N2} GB" -f ($value / 1GB) }
    if ($value -ge 1MB) { return "{0:N1} MB" -f ($value / 1MB) }
    if ($value -ge 1KB) { return "{0:N0} KB" -f ($value / 1KB) }
    return "$value B"
}

<#
.SYNOPSIS
    Download to $Path, retrying the parts that are worth retrying.

.DESCRIPTION
    Resuming makes a retry cheap, so this just re-enters until the file is complete or
    a permanent failure is reported. The URL is resolved once and reused: for the JDK it
    is a redirect whose target carries a signed, expiring query string, and re-resolving
    it on every attempt would waste a round trip and can change the expected size.
#>
function Get-Artifact {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Path,
        [long]$ExpectedSize = 0,
        [int]$Attempts = $DOWNLOAD_ATTEMPTS
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $result = Save-StreamedFile -Uri $Uri -Path $Path -ExpectedSize $ExpectedSize
        switch ($result) {
            "Complete" { return $true }
            "Partial" {
                if ($attempt -lt $Attempts) { Note "retrying ($attempt of $Attempts)" }
                continue
            }
            default {
                if ($attempt -lt $Attempts) { Note "retrying ($attempt of $Attempts)" }
                continue
            }
        }
    }

    if (Test-Path $Path) {
        Warn "gave up; $(Format-Bytes (Get-Item $Path).Length) is on disk. Re-run this script to continue from there."
    }
    return $false
}

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
        if (-not (Get-Artifact -Uri $jdkUrl -Path $zip)) {
            throw "the JDK download did not complete; re-run this script to continue from the partial file at $zip"
        }
        $staging = Join-Path $env:TEMP "mobileclaw-jdk"
        if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $staging -Force
        # Adoptium archives wrap everything in a single `jdk-<version>` directory.
        $inner = Get-ChildItem -Path $staging -Directory | Select-Object -First 1
        if (-not $inner) { throw "the JDK archive did not contain a directory; inspect $zip" }
        Get-ChildItem -Path $inner.FullName | Move-Item -Destination $jdkDir -Force
        Remove-Item $zip, $staging -Recurse -Force -ErrorAction SilentlyContinue
        Step "installed"
        Note (Get-NativeBanner (Join-Path $jdkDir "bin\java.exe") @("-version"))
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
        if (-not (Get-Artifact -Uri "$($V.DOWNLOADS.sdkBase)$name" -Path $zip)) {
            throw "the command-line tools download did not complete; re-run this script to continue from the partial file at $zip"
        }
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

# The component each package must leave behind, so "installed" can be checked instead
# of believed. `SDK_PACKAGES` and this table are the two halves of the same claim, and
# the key set is asserted below so adding a package without a path to verify fails loudly.
$sdkProof = @{
    "platform-tools"        = "platform-tools\adb.exe"
    "platforms;android-36"  = "platforms\android-36\android.jar"
    "build-tools;36.0.0"    = "build-tools\36.0.0\aapt2.exe"
    "ndk;27.1.12297006"     = "ndk\27.1.12297006\source.properties"
    "cmake;3.30.5"          = "cmake\3.30.5\bin\ninja.exe"
}
foreach ($package in $V.SDK_PACKAGES) {
    if (-not $sdkProof.ContainsKey($package)) {
        throw "SDK_PACKAGES lists '$package' but there is no path to verify it with; add one to `$sdkProof"
    }
}

if ($DryRun) {
    Note "would install each of the above through the SDK's command-line tools, then verify the files listed in `$sdkProof"
} else {
    # Which CLI to drive is detected, not assumed. Recent cmdline-tools ship
    # `sdkmanager` as a deprecation shim that forwards to a new `android` CLI, and the
    # shim *splits `platforms;android-36` into two arguments* at the semicolon -- so it
    # reports "Package platforms not found. Package android-36 not found." and still
    # exits 0. Trusting that exit code is how this step previously "succeeded" while
    # installing nothing.
    $androidCli = Join-Path (Split-Path -Parent $sdkManager) "android.exe"
    $useAndroidCli = Test-Path $androidCli

    Note ($(if ($useAndroidCli) { "using the current CLI: android sdk install" } else { "using sdkmanager" }))
    if ($useAndroidCli) {
        # `--licenses` is accepted as a no-op by the shim but unnecessary here: the CLI
        # no longer gates installation on it.
        foreach ($package in $V.SDK_PACKAGES) {
            $proof = Join-Path $sdkDir $sdkProof[$package]
            if (Test-Path $proof) { Note "already present: $package"; continue }

            Note "installing $package"
            # One package per invocation on purpose: the new CLI takes a single
            # `<package>[@<version>]` positional, and this keeps a mid-list failure from
            # hiding which package it was.
            & $androidCli "--sdk=$sdkDir" "sdk" "install" $package
            if ($LASTEXITCODE -ne 0) { throw "android sdk install exited $LASTEXITCODE on '$package'" }
            if (-not (Test-Path $proof)) {
                throw "'$package' reported success but $proof is missing; the package did not install"
            }
        }
    } elseif (Test-Path $sdkManager) {
        # Licences first: sdkmanager refuses to install without them, and there is no
        # non-interactive flag, so the prompt is answered from the pipeline.
        Note "accepting licences"
        ("y`n" * 40) | & $sdkManager "--sdk_root=$sdkDir" "--licenses" | Out-Null
        foreach ($package in $V.SDK_PACKAGES) {
            $proof = Join-Path $sdkDir $sdkProof[$package]
            if (Test-Path $proof) { Note "already present: $package"; continue }
            Note "installing $package"
            & $sdkManager "--sdk_root=$sdkDir" $package
            if ($LASTEXITCODE -ne 0) { throw "sdkmanager exited $LASTEXITCODE on '$package'" }
            if (-not (Test-Path $proof)) {
                throw "'$package' reported success but $proof is missing; the package did not install"
            }
        }
    } else {
        throw "no SDK package installer found under $sdkDir\cmdline-tools (neither android.exe nor sdkmanager.bat)"
    }
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
        # Still a hard failure, because this one comes from GitHub and a network that
        # cannot reach it needs the manual fallback in docs/dev-environment.md rather
        # than a fourth retry.
        if (-not (Get-Artifact -Uri $V.DOWNLOADS.ninja -Path $zip -Attempts 2)) {
            throw "could not download ninja from GitHub. On a network that blocks it, download ninja-win.zip by hand from $($V.DOWNLOADS.ninja) and put ninja.exe in the two paths listed below."
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

# --- gradle ------------------------------------------------------------------
#
# The JDK, SDK and ninja above are enough to *compile*, but `eng/build-local.ps1` also needs
# an extracted Gradle: it looks for `gradle.bat` under `<gradleHome>/wrapper/dists` and falls
# back to `android/gradlew.bat`, which downloads the distribution on first use. On a slow or
# proxied network that download is the step that appears to hang, so this stage removes it by
# unzipping the pinned distribution into the wrapper layout Gradle expects.
#
# Not done by downloading with `gradle wrapper`: that needs the very distribution it would be
# fetching. The URL comes from the project's own `gradle-wrapper.properties`, so this cannot
# drift from what the build asks for.
Step "gradle $($V.GRADLE_VERSION)"

if ($GradleHome) {
    # A colleague's or a previous install's home. Point the resolver at it and stop.
    if (-not (Test-Path (Join-Path $GradleHome "wrapper\dists"))) {
        Warn "$GradleHome has no wrapper\dists, so it holds no Gradle to reuse"
        Warn "pass a home that has been used for a build, or omit -GradleHome to install one here"
    } else {
        Note "reusing the Gradle home at $GradleHome"
        Note "set MOBILECLAW_GRADLE_HOME=$GradleHome, or pass -GradleHome to eng/build-local.ps1"
        $env:MOBILECLAW_GRADLE_HOME = $GradleHome
    }
} else {
    $wrapperProperties = Join-Path $repoRoot "apps\mobile\android\gradle\wrapper\gradle-wrapper.properties"
    if (-not (Test-Path $wrapperProperties)) {
        Warn "no gradle-wrapper.properties yet (android/ is generated by prebuild);"
        Warn "run 'npx expo prebuild -p android' first, then re-run this script for the Gradle step"
    } else {
        $distributionUrl = (Select-String -Path $wrapperProperties -Pattern '^distributionUrl=' |
            Select-Object -First 1).Line -replace '^distributionUrl=', ''
        # The property escapes the colon as `\:`; Gradle accepts it either way but the file
        # name derived from it must not contain the backslash.
        $distributionUrl = $distributionUrl -replace '\\:', ':'

        $alreadyExtracted = Get-ChildItem -Path (Join-Path $gradleHome "wrapper\dists") -Filter "gradle.bat" `
            -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match "\\bin\\gradle\.bat$" } |
            Select-Object -First 1

        if ($alreadyExtracted -and -not $Force) {
            Step "already extracted, skipping"
            Note $alreadyExtracted.FullName
        } elseif ($DryRun) {
            Note "would download $distributionUrl"
            Note "and extract it to $gradleHome\wrapper\dists"
        } else {
            Note "downloading $distributionUrl"
            $zip = Join-Path $env:TEMP "mobileclaw-gradle.zip"
            if (-not (Get-Artifact -Uri $distributionUrl -Path $zip -Attempts 3)) {
                throw ("could not download Gradle from $distributionUrl. On a network that blocks it, " +
                    "download the distribution by hand, then either pass -GradleHome <a home that has " +
                    "wrapper\dists> or extract it into $gradleHome\wrapper\dists.")
            }
            # Gradle's own cache layout is wrapper/dists/<name>-<hash>/<random>/<name>/. The
            # hash is derived from the URL, and recomputing it here would be guesswork, so the
            # archive is unpacked one level down and the resolver's recursive search finds
            # gradle.bat wherever it lands. That search is depth-independent.
            $staging = Join-Path $env:TEMP "mobileclaw-gradle"
            if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
            Expand-Archive -Path $zip -DestinationPath $staging -Force
            $inner = Get-ChildItem -Path $staging -Directory | Select-Object -First 1
            if (-not $inner) { throw "the Gradle archive did not contain a directory" }
            $target = Join-Path $gradleHome "wrapper\dists\$($inner.Name)"
            New-Item -ItemType Directory -Force -Path $target | Out-Null
            Move-Item -Path $inner.FullName -Destination $target -Force
            Remove-Item $zip, $staging -Recurse -Force -ErrorAction SilentlyContinue
            Step "installed"
            Note (Join-Path $target "$($inner.Name)\bin\gradle.bat")
        }
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
