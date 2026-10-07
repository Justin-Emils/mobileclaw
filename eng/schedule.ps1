#Requires -Version 5.1
<#
.SYNOPSIS
    Registers (or removes) the Windows scheduled task that periodically commits
    and pushes MobileClaw.

.DESCRIPTION
    The task runs eng/commit.ps1 headlessly. Commits only happen when the working
    tree is dirty, so an idle repository produces no empty commits and no noise.

    Cadence is configurable:
        .\eng\schedule.ps1 -IntervalMinutes 30     # default
        .\eng\schedule.ps1 -IntervalMinutes 1440   # once a day
        .\eng\schedule.ps1 -Remove                 # stop periodic commits

    Note on credentials: a scheduled task cannot answer a credential prompt, so
    the push must work non-interactively. That means either an SSH key with no
    passphrase (chosen here) or a stored PAT.

.PARAMETER IntervalMinutes
    How often to attempt a commit/push. Minimum 5.

.PARAMETER TaskName
    Scheduled task name, so several checkouts can coexist.

.PARAMETER Remove
    Unregister the task instead of creating it.

.PARAMETER RunNow
    Start the task immediately after registering, to prove it works.
#>
[CmdletBinding()]
param(
    [int]$IntervalMinutes = 30,
    [string]$TaskName = 'MobileClaw auto-commit',
    [switch]$Remove,
    [switch]$RunNow
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "task '$TaskName' is not registered" -ForegroundColor Yellow
        exit 0
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "removed scheduled task '$TaskName'" -ForegroundColor Green
    exit 0
}

if ($IntervalMinutes -lt 5) {
    Write-Host '-IntervalMinutes must be at least 5' -ForegroundColor Red
    exit 1
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CommitScript = Join-Path $RepoRoot 'eng\commit.ps1'
if (-not (Test-Path $CommitScript)) {
    Write-Host "cannot find $CommitScript" -ForegroundColor Red
    exit 1
}

# -WindowStyle Hidden keeps the console from flashing every interval. The script
# writes to .logs/auto-commit.log instead, which is the place to look on failure.
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$CommitScript`""

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

# Built by property assignment rather than parameters: the battery switches are
# not exposed by New-ScheduledTaskSettingsSet on Windows PowerShell 5.1, and the
# object models them as the *negative* (DisallowStartIfOnBatteries).
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "replacing existing task '$TaskName'" -ForegroundColor Yellow
}

# CurrentUser (not SYSTEM) so commits use this user's git identity and SSH key.
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Commit and push MobileClaw every $IntervalMinutes minute(s) when the working tree is dirty." `
    -Force | Out-Null

Write-Host "registered '$TaskName': every $IntervalMinutes minute(s), first run in 5 minutes" -ForegroundColor Green
Write-Host "log: $RepoRoot\.logs\auto-commit.log"

if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host 'started the task now; check the log in a few seconds' -ForegroundColor Green
}
