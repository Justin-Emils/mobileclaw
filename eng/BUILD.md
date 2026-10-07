# Building the APK

Verification that runs without a device or an Expo account (all local):

```bash
pnpm check      # typecheck + 114 tests + a real Metro bundle
pnpm doctor     # expo-doctor, expect 21/21
```

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

