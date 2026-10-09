# eng/ — repository automation

Two scripts, one shared implementation of "commit and push this repo". The Android build toolchain
lives here too — see below.

## Android toolchain

| Script | What it does |
| --- | --- |
| `toolchain.cjs` | Resolves the JDK / Android SDK / Gradle home: explicit `-Jdk`/`-Sdk`/`-GradleHome` → environment variables → a git-ignored `<repo>/.toolchain/` → the platform's usual locations. `node eng/toolchain.cjs print` shows the result. |
| `toolchain-versions.cjs` | The single source for the component versions (JDK 21, the `sdkmanager` package list, CMake 3.30.5, ninja ≥ 1.12.1, Gradle 9.3.1). |
| `setup-toolchain.ps1` | Installs a JDK and the Android SDK into `<repo>/.toolchain/`; `-DryRun` prints the plan, `-FixNinja` also replaces the SDK's bundled ninja. |
| `build-local.ps1` | Builds the APK locally, resolving the toolchain through `toolchain.cjs`. |

The versions, the ninja/path-length traps and the fourteen environment quirks are written up in
[`BUILD.md`](./BUILD.md) and [`../docs/dev-environment.md`](../docs/dev-environment.md).

## Periodic commits

```powershell
.\eng\schedule.ps1                      # commit+push every 30 minutes when dirty
.\eng\schedule.ps1 -IntervalMinutes 60  # hourly
.\eng\schedule.ps1 -IntervalMinutes 10  # chatty (minimum 5)
.\eng\schedule.ps1 -Remove              # stop periodic commits
```

Registers a Windows scheduled task named **MobileClaw auto-commit** that runs
`commit.ps1` headlessly every interval. It runs as the current user, so commits use
this account's git identity and stored credentials — a task running as SYSTEM would not.

Commits only happen when the working tree is dirty, so an idle repository produces no
empty commits. Output goes to `.logs/auto-commit.log` (git-ignored).

**Credential requirement:** a scheduled task cannot answer a prompt, so the push must work
non-interactively. Here that is satisfied by HTTPS + Git Credential Manager, which already
holds a credential for this account (`credential.helper = manager`, set system-wide).
An SSH key would work too, provided it is registered on the GitHub account and has no
passphrase — the key on this machine is *not* registered, which is why HTTPS is used.

Verify the loop end to end without waiting for a tick:

```powershell
Start-ScheduledTask -TaskName 'MobileClaw auto-commit'
Start-Sleep -Seconds 20
Get-Content .logs\auto-commit.log -Tail 5     # expect 'pushed <sha> to <remote>'
(Get-ScheduledTaskInfo -TaskName 'MobileClaw auto-commit').LastTaskResult   # expect 0
```

## Manual checkpoints

```powershell
.\eng\commit.ps1 -Checkpoint "feat: add Shizuku UserService bridge"
.\eng\commit.ps1 -Checkpoint "fix: guard empty path" -NoPush
.\eng\commit.ps1                       # scheduled-style: generated message, then push
```

Exits non-zero on failure, so a caller (or an agent) notices instead of silently
believing the push succeeded.

Use `-Checkpoint` for anything a human will read later. The scheduled mode generates
`chore: checkpoint <time>` messages, which are fine as a safety net but are not a
substitute for a real commit message.

## Guard rails in `commit.ps1`

| Guard | Why |
| --- | --- |
| Lock file with staleness timeout | A scheduled tick cannot overlap a slow push. |
| Git identity assertion | Commits would otherwise fail or be misattributed. |
| `-MaxFiles` (default 500) | Refuses to commit a generated tree that escaped `.gitignore`. |
| Native-command runner | With `$ErrorActionPreference = 'Stop'`, git's stderr would throw and skip error handling entirely. |
| Explicit push exit-code check | An unchecked `git push` is how a "successful" run silently never uploads. |
| Local commit survives push failure | The commit is kept; the log says it is local-only so it can be pushed later. |
