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
npx eas-cli init           # writes extra.eas.projectId into app.config.ts
pnpm --filter @mobileclaw/mobile run build:apk      # preview profile -> .apk
```

`preview` and `development` set `android.buildType: "apk"`; `production` builds an
`.aab` for stores. Free tier: 15 Android builds, low-priority queue, 45-minute cap.

## Local native project (optional, for inspecting generated config)

```bash
cd apps/mobile
npx expo prebuild --platform android --no-install
```

This generates `android/` (git-ignored) without needing the SDK, and is the only way to
verify `app.config.ts` plugins short of a full build. Check the results in
`android/app/src/main/AndroidManifest.xml`:

- `<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE"/>`
  (absent when `MOBILECLAW_PLAY_SAFE=1`)
- `<uses-permission android:name="com.termux.permission.RUN_COMMAND"/>`
- a `<queries>` block containing `com.termux`, `com.android.calendar`,
  `com.android.documentsui`, and the SEND/VIEW intents

## Network gotcha on this machine

git and the Expo CLI route through a local proxy (`http.proxy = 127.0.0.1:7892`, set
globally) which fails the TLS handshake to GitHub. `eng/commit.ps1` sets `NO_PROXY=*`
on its child processes. For manual commands, do the same:

```powershell
$env:NO_PROXY='*'; $env:no_proxy='*'
```
