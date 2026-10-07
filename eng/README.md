# eng/ — repository automation

Two scripts, one shared implementation of "commit and push this repo".

## Periodic commits

```powershell
.\eng\schedule.ps1                      # commit+push every 30 minutes when dirty
.\eng\schedule.ps1 -IntervalMinutes 60  # hourly
.\eng\schedule.ps1 -IntervalMinutes 10  # chatty (minimum 5)
.\eng\schedule.ps1 -Remove              # stop periodic commits
```

Registers a Windows scheduled task named **MobileClaw auto-commit** that runs
`commit.ps1` headlessly every interval. It runs as the current user, so commits use
this account's git identity and SSH key — a task running as SYSTEM would not.

Commits only happen when the working tree is dirty, so an idle repository produces no
empty commits. Output goes to `.logs/auto-commit.log` (git-ignored).

**Credential requirement:** a scheduled task cannot answer a prompt. The push must work
non-interactively, which here means an SSH key on the GitHub account with no passphrase.

## Manual checkpoints

```powershell
.\eng\commit.ps1 -Checkpoint "feat: add Shizuku UserService bridge"
.\eng\commit.ps1 -Checkpoint "fix: guard empty path" -NoPush
.\eng\commit.ps1                       # scheduled-style: generated message, then push
```

Exits non-zero on failure, so a caller (or an agent) notices instead of silently
believing the push succeeded.

## Guard rails in `commit.ps1`

| Guard | Why |
| --- | --- |
| Lock file with staleness timeout | A scheduled tick cannot overlap a slow push. |
| Git identity assertion | Commits would otherwise fail or be misattributed. |
| `-MaxFiles` (default 500) | Refuses to commit a generated tree that escaped `.gitignore`. |
| Native-command runner | With `$ErrorActionPreference = 'Stop'`, git's stderr would throw and skip error handling entirely. |
| Explicit push exit-code check | An unchecked `git push` is how a "successful" run silently never uploads. |
| Local commit survives push failure | The commit is kept; the log says it is local-only so it can be pushed later. |
