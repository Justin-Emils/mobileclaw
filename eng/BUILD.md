# Building the APK

Verification that runs without a device or an Expo account (all local):

```bash
pnpm check      # typecheck + 114 tests + a real Metro bundle
pnpm doctor     # expo-doctor, expect 21/21
```

## Local Android build (`eng/build-local.ps1`)

This machine already has a complete Android toolchain in `E:\code\Eng`, so a local
build needs no EAS quota:

| Component | Path | Version |
| --- | --- | --- |
| JDK | `E:\code\Eng\.jdk21` | Temurin 21.0.12 (PATH only has Java 8 — `JAVA_HOME` must be set) |
| Android SDK | `E:\code\Eng\.android-sdk` | build-tools 36.0.0, platforms/android-36, ndk 27.1.12297006, cmake 3.22.1 |
| adb | `.android-sdk\platform-tools\adb.exe` | 1.0.41 |
| Gradle | `E:\code\Eng\.gradle-home` | 9.3.1, pre-extracted with a warm cache |

```powershell
.\eng\build-local.ps1 -Variant debug          # fastest, debug-signed
.\eng\build-local.ps1 -Variant release -GenerateKeystore
.\eng\build-local.ps1 -Install                # adb install when it succeeds
```

### Progress: four of five blockers solved

1. **Gradle wrapper tried to download 9.3.1 and timed out.** A complete distribution
   is already extracted under `.gradle-home\wrapper\dists\...\<hash>\gradle-9.3.1`,
   but the wrapper hashes its own directory from `gradle-wrapper.properties` and
   looked in a different (half-downloaded) one. The script now invokes the extracted
   `bin\gradle.bat` directly.
2. **`NODE_ENV` was unset**, which the Expo Gradle plugin refuses to build without.
   The script sets it per variant.
3. **CMake object paths exceeded its 250-character limit** (252 measured): pnpm's
   isolated store costs ~93 characters before the package name even starts, so
   `...\.pnpm\react-native-worklets@0.13._82ad66a5…\node_modules\react-native-worklets\…`
   plus CMake's own directory overflowed. Mapping the repo to a short drive helps:
   ```powershell
   subst S: E:\code\mobileclaw      # 252 -> 229 characters
   ```
   Note `node-linker=hoisted` and `virtual-store-dir` are both ignored by pnpm 11,
   so moving `.npmrc` to the workspace root does not flatten the tree.
4. **`expo prebuild` must be invoked as `node_modules\.bin\expo.cmd`**; `npx
   --no-install expo` fails to resolve the binary in this workspace layout.

### Remaining blocker: CMake 3.22's self-regeneration loop

Every local build still fails the two C++ targets with:

```
> Task :react-native-screens:buildCMakeDebug[arm64-v8a] FAILED
C/C++: ninja: error: manifest 'build.ninja' still dirty after 100 tries
```

Root cause, confirmed by reading the generated file:

```ninja
build CMakeFiles/rebuild_cache.util: CUSTOM_COMMAND
  COMMAND = cmd.exe /C "cd /D <build dir> && cmake.exe --regenerate-during-build -S<src> -B<build>"
  restat = 1
```

The rule declares **no inputs**, so ninja considers `build.ninja` permanently stale;
it re-runs CMake, CMake rewrites `build.ninja` (verified: the timestamp does advance),
ninja restarts, and gives up after 100 attempts. It is not a stale file, a stale
timestamp or a future-dated source — the rule itself can never converge.

`CMAKE_SUPPRESS_REGENERATION=ON` is the documented switch, but it could not be
injected: AGP 9 removed `arguments` from `CmakeOptions` (verified by dumping the
object's members — only `path`, `version`, `buildStagingDirectory` remain), so the
Gradle-property routes and a `subprojects {}` block both fail to reach CMake. Patching
`build.ninja` to remove that one command was not enough either; a second regeneration
hook remains.

**The promising fix to try next: use an older CMake.** This `restat = 1`
regeneration loop is a known CMake 3.22/Ninja interaction that 3.18 and 3.20 do not
have, and the SDK ships only 3.22.1:

```powershell
E:\code\Eng\.android-sdk\cmdline-tools\latest\bin\sdkmanager.bat "cmake;3.18.1"
```

Then pin it for all native modules and rebuild. `sdkmanager` needs network, so the
proxy problem applies (`NO_PROXY=*`).

Until that is resolved, **cloud builds remain the way to produce an APK** — see below.
Local tooling is otherwise ready, and the JS/TS side of a local build is unaffected.

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

