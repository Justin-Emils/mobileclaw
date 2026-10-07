# Building the APK

> **Environment facts, toolchain versions and the Windows path analysis now live in
> [`docs/dev-environment.md`](../docs/dev-environment.md)** — that document is shared
> across projects, so it is the primary reference. This file keeps the build commands
> and the build-specific history.

Verification that runs without a device or an Expo account (all local):

```bash
pnpm check      # typecheck + 130 tests + a real Metro bundle
pnpm doctor     # expo-doctor, expect 21/21
```

> **The repository lives at `E:\code\mobileclaw`.** On 2026-10-07 it was briefly moved to
> `E:\mc\mobileclaw` and moved back: the migration was chasing a path-length problem that
> turned out to be the Android SDK's bundled ninja being too old — see Blocker 2. Commands
> below assume this path.

## Local Android build (`eng/build-local.ps1`)

This machine already has a complete Android toolchain in `E:\code\Eng`, so a local
build needs no EAS quota:

| Component | Path | Version |
| --- | --- | --- |
| JDK | `E:\code\Eng\.jdk21` | Temurin 21.0.12 (PATH only has Java 8 — `JAVA_HOME` must be set) |
| Android SDK | `E:\code\Eng\.android-sdk` | build-tools 36.0.0, platforms/android-36, ndk 27.1.12297006 |
| CMake | `.android-sdk\cmake\3.30.5` | 3.30.5, pinned by `eng/pin-cmake-version.init.gradle` (3.22.1 loops — Blocker 1) |
| ninja | `.android-sdk\cmake\{3.30.5,3.22.1}\bin\ninja.exe` | both swapped to 1.12.1 by hand; each original kept beside it as `ninja-1.10.2.exe.bak` (Blocker 2) |
| adb | `.android-sdk\platform-tools\adb.exe` | 1.0.41 |
| Gradle | `E:\code\Eng\.gradle-home` | 9.3.1, pre-extracted with a warm cache |

The machine's execution policy refuses unsigned scripts, and that error does not land in a
redirected log — it exits silently. Launch it through a Bypass host:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 -Variant debug
powershell -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 -Variant release -GenerateKeystore
powershell -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 -Install   # adb install

Unblock-File eng\build-local.ps1     # after that, plain .\eng\build-local.ps1 works too
```

### Progress: every blocker solved (2026-10-07)

1. **Gradle wrapper tried to download 9.3.1 and timed out.** A complete distribution
   is already extracted under `.gradle-home\wrapper\dists\...\<hash>\gradle-9.3.1`,
   but the wrapper hashes its own directory from `gradle-wrapper.properties` and
   looked in a different (half-downloaded) one. The script now invokes the extracted
   `bin\gradle.bat` directly.
2. **`NODE_ENV` was unset**, which the Expo Gradle plugin refuses to build without.
   The script sets it per variant.
3. **CMake's 250-character object-path message is a warning, not a failure** (252 measured;
   the log says `The build may not work correctly`). The isolated store still cost ~93
   characters before the package name even starts, so it was worth fixing properly:
   `...\.pnpm\react-native-worklets@0.13._82ad66a5…\node_modules\react-native-worklets\…`
   plus CMake's own directory overflowed. Mapping the repo to a short drive helps:
   ```powershell
   subst S: E:\code\mobileclaw      # 252 -> 229 characters
   ```
   Note the flat layout is configured by `nodeLinker: hoisted` in `pnpm-workspace.yaml`,
   **not** by `node-linker=hoisted` in `.npmrc` — pnpm 11 reads layout settings only from
   the workspace file, so the old `.npmrc` entry was inert and was mistaken for pnpm
   dropping the setting. `virtualStoreDir` exists too, but it does not move `.cxx`.
4. **`expo prebuild` must go through a `.cmd` shim, never `npx --no-install expo`** (which
   cannot resolve the binary in this workspace layout). The shim moved when the layout went
   flat: with `nodeLinker: hoisted` it is `node_modules\.bin\expo.cmd` at the repository root,
   not under `apps\mobile`. The script checks both.

### Blocker 1: CMake 3.22's self-regeneration loop — SOLVED

`react-native-screens` / `react-native-worklets` failed with:

```
C/C++: ninja: error: manifest 'build.ninja' still dirty after 100 tries
```

Root cause, read out of the generated file:

```ninja
build CMakeFiles/rebuild_cache.util: CUSTOM_COMMAND
  COMMAND = cmd.exe /C "cd /D <build dir> && cmake.exe --regenerate-during-build -S<src> -B<build>"
  restat = 1
```

The rule declares **no inputs**, so ninja considers `build.ninja` permanently stale: it
re-runs CMake, CMake rewrites the file (verified — the timestamp does advance), ninja
restarts, and it gives up after 100 attempts. Not a stale file, not clock skew, not a
future-dated source: the rule can never converge.

`CMAKE_SUPPRESS_REGENERATION=ON` cannot be injected — AGP 9 removed `arguments` from
`CmakeOptions` (verified by dumping the object: only `path`, `version`,
`buildStagingDirectory` remain). **`version` is the one usable property**, so the fix is
to use a CMake that does not emit that rule:

```powershell
E:\code\Eng\.android-sdk\cmdline-tools\latest\bin\sdkmanager.bat "cmake;3.30.5"
```

pinned by `eng/pin-cmake-version.init.gradle` (pass `-I` to Gradle). With this,
`react-native-screens` and most of `expo-modules-core` compile successfully.

### Blocker 2: ninja's 260-character guard — SOLVED (two independent fixes)

With the CMake fix in place, the failure moved to:

```
ninja: error: rebuilding 'build.ninja':
  Stat(.../react-native-workletsConfigVersion.cmake): Filename longer than 260 characters
```

That 260 is **ninja's own hard-coded guard, not a Windows limit**, and it only exists in old
ninja builds. Upstream `src/disk_interface.cc` now writes it as
`if (!path.empty() && !AreLongPathsEnabled() && path[0] != '\\' && path.size() > MAX_PATH)`,
where `AreLongPathsEnabled()` probes ntdll's `RtlAreLongPathsEnabled`. This machine already
has long paths on (registry `LongPathsEnabled=1`, `RtlAreLongPathsEnabled()==1`) — but the
SDK's CMake 3.30.5 bundles **ninja 1.10.2**, which predates that probe: its binary carries
the literal error text and no `RtlAreLongPathsEnabled` at all. Two fixes, both applied:

1. **ninja 1.10.2 -> 1.12.1** at `E:\code\Eng\.android-sdk\cmake\3.30.5\bin\ninja.exe`
   (the exact path AGP invokes; the original sits beside it as `ninja-1.10.2.exe.bak`).
   A/B on one `build.ninja` with a 340-character input path: 1.10.2 exits 1 with the error
   above, 1.12.1 exits 0 and runs the command.
2. **`nodeLinker: hoisted`** in `pnpm-workspace.yaml`, which deletes the
   `node_modules/.pnpm/<name>@<version>_<hash>/node_modules/` prefix. Worst measured prefab
   path: **265 -> 181 characters**, below both ninja's old 260 and CMake's 250 warning line.
   That also shortens what NDK `clang.exe` and CMake itself must open, and neither of those
   carries a long-path manifest.

The earlier "even a drive root leaves 262, so this is impossible" note was based on the
isolated layout plus the old ninja; it is wrong. Details, measurements and the revert
commands are in [`docs/dev-environment.md`](../docs/dev-environment.md).

## Trap: a "successful" build that ships a stale JS bundle

**Read this before trusting any release APK.**

`createBundleReleaseJsAndAssets` does not treat the workspace packages
(`packages/core`, `packages/capabilities`) as its inputs — they arrive through
tsconfig paths and pnpm links, which Gradle does not follow. Editing core code
therefore leaves that task `UP-TO-DATE`:

```
> Task :app:createBundleReleaseJsAndAssets UP-TO-DATE
```

Gradle then repackages an APK containing the *previous* bundle and exits 0. The result
installs, runs, and silently behaves like the code from an earlier commit. This
actually happened: a release APK was handed over missing changes committed minutes
before it, and it was only caught by searching the packaged bundle for the new
strings.

Two guards now live in `eng/build-local.ps1`, so a plain run is safe:

1. Before Gradle runs, the newest `*.ts`/`*.tsx` mtime under `apps/mobile/app`,
   `apps/mobile/src`, `packages/core/src` and `packages/capabilities/src` is compared
   against the existing bundle. If sources are newer, the bundle and its merged copies
   are deleted so Gradle must re-run the task. (`--rerun-tasks` would work too but
   rebuilds every native module as well.)
2. After Gradle finishes, the APK must be newer than the moment the script started, or
   it throws instead of copying a stale artifact. The script prints `apk built = …` so
   the timestamp is visible without digging.

If you build by invoking Gradle directly, neither guard applies — add `-Clean`, or
delete `apps/mobile/android/app/build/generated/assets/react/<variant>/index.android.bundle`
first. To confirm a package really contains your change:

```powershell
node eng\axml-manifest.cjs <apk>            # permissions/queries
# and for JS: search the packaged bundle for a string you just added.
```

Cloud builds still work and remain a useful fallback — see below.

## Cloud build (no Android SDK needed)

```bash
cd apps/mobile
npx eas-cli login          # interactive, browser-based; cannot be scripted
npx eas-cli init           # created project 2f118dc0-… ; writes extra.eas.projectId
pnpm --filter @mobileclaw/mobile run build:apk      # preview profile -> .apk
```

`preview` and `development` set `android.buildType: "apk"`; `production` builds an
`.aab` for stores. Free tier: 15 Android builds, low-priority queue, 45-minute cap.

`eas.json` pins `pnpm: "11.22.0"` and `node: "22.23.1"` per profile, so the builder uses
the same package manager that wrote the lockfile. Those are real schema fields
(`pnpm`/`node`/`yarn`/`bun`); `buildProfile` does **not** exist and makes `eas.json`
invalid.

### Successful build

| | |
| --- | --- |
| Build | `9299de3c-845b-4892-b79f-3e6882bb7088` (FINISHED, ~19 min) |
| Artifact | https://expo.dev/artifacts/eas/hEg3VK0hEFmGIhk9ygCxE08I1U1qZAdGh97Ux1Lhpv0.apk |
| Size | 102.97 MB (4 ABIs, unstripped debug symbols — expected for `preview`) |
| Package | `dev.mobileclaw.app`, versionCode 1, minSdk 24, targetSdk 36 |

Install: copy to the phone and open it (sideload), or `adb install -r <file>.apk`.

### The failure that cost four builds

`Install dependencies` finished adding 619 packages and *then* exited 1:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.21.5
pnpm install --frozen-lockfile exited with non-zero code: 1
```

pnpm 11 renamed `onlyBuiltDependencies` to a **map** named `allowBuilds`, and the old key
is silently ignored. The fix is in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  esbuild: true
```

To reproduce locally (a warm `node_modules` hides this completely, because pnpm skips the
approval check when nothing needs building):

```powershell
Remove-Item node_modules,apps/mobile/node_modules,packages/*/node_modules -Recurse -Force
pnpm install --frozen-lockfile --store-dir .logs/probe-store   # exit 1 before the fix, 0 after
```

## Verifying a built APK without the Android SDK

`eng/axml-manifest.cjs` decodes the compiled `AndroidManifest.xml` inside an APK (no
dependencies, no `aapt2` needed):

```bash
node eng/axml-manifest.cjs artifacts/mobileclaw-preview.apk MANAGE_EXTERNAL_STORAGE
```

Confirmed present in the shipped preview APK: 37 permissions including
`MANAGE_EXTERNAL_STORAGE` and `com.termux.permission.RUN_COMMAND`, plus a `<queries>`
block with `com.termux`, `com.android.calendar`, `com.android.documentsui` and the
SEND/VIEW intents.

## Local native project (for inspecting generated config)

```bash
cd apps/mobile
npx expo prebuild --platform android --no-install
```

Generates `android/` (git-ignored) without the SDK. Check
`android/app/src/main/AndroidManifest.xml` for the same set of permissions and queries.
This is how the Play-safe variant was verified: with `MOBILECLAW_PLAY_SAFE=1`,
`MANAGE_EXTERNAL_STORAGE` count is 0 (the `android.blockedPermissions` list alone does
**not** remove a permission declared in `android.permissions` — it only filters library
contributions — so a manifest modifier does it).

## Network gotcha on this machine

git and the Expo CLI route through a local proxy (`http.proxy = 127.0.0.1:7892`, set
globally) which fails the TLS handshake to GitHub. `eng/commit.ps1` sets `NO_PROXY=*`
on its child processes. For manual commands, do the same:

```powershell
$env:NO_PROXY='*'; $env:no_proxy='*'
```

GitHub pushes also intermittently fail with `Connection was reset` or a 21-second
connect timeout; retrying a few times works.

