#Requires -Version 5.1
<#
.SYNOPSIS
    One way to commit and push MobileClaw: a human checkpoint, or the unattended
    scheduled job.

.DESCRIPTION
    Two modes, one implementation, because the logic must not drift between them:

      -Checkpoint "feat: add native module"
          Conventional-commit style message supplied by hand (or by an agent).
          Exits non-zero on failure so a caller notices.

      (no -Checkpoint)
          The scheduled mode. Stages everything, and commits with a generated
          "chore: checkpoint <timestamp>" message, but only when something
          actually changed. Pushes unless -NoPush is given.

    Why a script instead of a bare `git commit`: it serialises runs with a lock
    (a slow push must not overlap the next tick), asserts the git identity is
    configured, refuses to commit a suspiciously large tree, and appends to a log
    file so unattended failures are diagnosable after the fact.

.PARAMETER Checkpoint
    Commit message for a manual checkpoint. Implies push.

.PARAMETER NoPush
    Skip the push. Used for dry runs and for the local plumbing test.

.PARAMETER MaxFiles
    Refuse to stage more than this many files in one unattended commit. Guards
    against accidentally committing node_modules or a generated build tree.

.PARAMETER Quiet
    Suppress console output (the scheduled task runs headless).
#>
[CmdletBinding()]
param(
    [string]$Checkpoint,
    [switch]$NoPush,
    [int]$MaxFiles = 500,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# Resolve the repository root from this script's location (eng/ -> repo root),
# so the script behaves identically no matter which directory the caller is in.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoRoot '.logs'
$LogFile = Join-Path $LogDir 'auto-commit.log'
$LockFile = Join-Path $LogDir 'auto-commit.lock'
$LockStaleMinutes = 15

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$stamp] [$Level] $Message"
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    if (-not $Quiet) {
        $color = switch ($Level) {
            'ERROR' { 'Red' }
            'WARN' { 'Yellow' }
            'OK' { 'Green' }
            default { 'Gray' }
        }
        Write-Host $line -ForegroundColor $color
    }
}

function Fail {
    param([string]$Message)
    Write-Log $Message 'ERROR'
    exit 1
}

# Run a native command and return its output plus exit code.
#
# Deliberately not `& git ... 2>&1`: with $ErrorActionPreference = 'Stop', any
# stderr output from a native tool (git writes progress AND errors there) becomes
# a terminating NativeCommandError, so the caller's error handling never runs.
# .NET gives us both streams as plain text and the real exit code.
function Invoke-Native {
    param([string]$File, [string[]]$Arguments)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $File
    $psi.Arguments = ($Arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $psi.WorkingDirectory = (Get-Location).Path
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($psi)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $text = (@($stdout, $stderr) | Where-Object { $_ }) -join "`n"
    return [pscustomobject]@{ Code = $process.ExitCode; Output = $text.Trim() }
}

# --------------------------------------------------------------------------- lock
# A scheduled task can fire while the previous run is still pushing. Rather than
# waiting, the second run simply exits: the first one will pick up its changes.
if (Test-Path $LockFile) {
    $age = (Get-Date) - (Get-Item $LockFile).LastWriteTime
    if ($age.TotalMinutes -lt $LockStaleMinutes) {
        Write-Log "another run is in progress (lock age $([math]::Round($age.TotalSeconds))s); skipping" 'WARN'
        exit 0
    }
    Write-Log "removing stale lock (age $([math]::Round($age.TotalMinutes))min)" 'WARN'
    Remove-Item $LockFile -Force
}
New-Item -ItemType File -Path $LockFile -Force | Out-Null

try {
    # ------------------------------------------------------------------- sanity
    Push-Location $RepoRoot
    try {
        git rev-parse --is-inside-work-tree 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "$RepoRoot is not a git work tree" }

        $name = git config user.name
        $email = git config user.email
        if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($email)) {
            Fail 'git user.name / user.email are not configured; commits would fail or be unattributed'
        }

        $remote = git remote get-url origin 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Log 'no "origin" remote configured; committing locally only' 'WARN'
            $NoPush = $true
        }

        # ------------------------------------------------------------- changes
        $dirty = git status --porcelain
        if (-not $dirty) {
            Write-Log 'no changes to commit'
            exit 0
        }

        $changed = @($dirty | Where-Object { $_ -match '\S' })
        git add -A
        if ($LASTEXITCODE -ne 0) { Fail 'git add failed' }

        # Count what is actually staged: this is what would enter history.
        $staged = @(git diff --cached --name-only)
        if ($staged.Count -eq 0) {
            Write-Log 'nothing staged after add (only ignored paths changed?)' 'WARN'
            exit 0
        }
        if ($staged.Count -gt $MaxFiles) {
            git reset -q
            Fail "refusing to commit $($staged.Count) files (limit $MaxFiles): check .gitignore before committing a generated tree"
        }

        # -------------------------------------------------------------- message
        if ($Checkpoint) {
            $message = $Checkpoint
        } else {
            $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
            $summary = ($staged | ForEach-Object { Split-Path -Leaf $_ }) -join ', '
            if ($summary.Length -gt 60) { $summary = $summary.Substring(0, 57) + '...' }
            $message = "chore: checkpoint $stamp`n`n$($staged.Count) file(s): $summary"
        }

        git commit -q -m $message
        if ($LASTEXITCODE -ne 0) { Fail 'git commit failed' }
        $sha = (git rev-parse --short HEAD).Trim()
        Write-Log "committed $sha ($($staged.Count) file(s))" 'OK'

        # ----------------------------------------------------------------- push
        if ($NoPush) {
            Write-Log 'push skipped (-NoPush)'
            exit 0
        }
        if (-not $remote) { exit 0 }

        $push = Invoke-Native -File 'git' -Arguments @('push', 'origin', 'HEAD')
        foreach ($line in ($push.Output -split "`n")) {
            if ($line.Trim() -ne '') { Write-Log "push: $($line.Trim())" 'INFO' }
        }
        if ($push.Code -ne 0) {
            # The commit is safe locally; report so a human can push later.
            Fail "push to $remote failed (exit $($push.Code)); commit $sha is local only"
        }
        Write-Log "pushed $sha to $remote" 'OK'
    }
    finally {
        Pop-Location
    }
}
finally {
    if (Test-Path $LockFile) { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue }
}
