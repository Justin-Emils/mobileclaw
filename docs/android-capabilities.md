# Android capabilities: what is actually possible

This document is the honest version. It records what Android allows, what it forbids, and what the
app therefore does. Everything here was checked against current platform behaviour and package
versions; where something is a policy risk rather than a technical limit, that is stated.

## 1. Files: paths vs. permissions

Android 11+ (API 30) scoped storage means a normal app gets:

- its **own** directories (`Paths.document`, `Paths.cache`, app-private external dir) — always;
- **MediaStore** items it owns, with `READ_MEDIA_IMAGES/VIDEO/AUDIO` (13+);
- **SAF tree URIs** the user explicitly granted via `ACTION_OPEN_DOCUMENT_TREE` +
  `takePersistableUriPermission`, which are URI-based, not path-based, and do not extend to sibling
  directories;
- **all-file paths** only with `MANAGE_EXTERNAL_STORAGE`.

`MANAGE_EXTERNAL_STORAGE` has **no runtime permission dialog**. The user must enable it in system
settings; the app can only deep-link them there:

```kotlin
if (!Environment.isExternalStorageManager()) {
  startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
    Uri.parse("package:$packageName")))
}
```

It also requires a manifest declaration plus `tools:ignore="ScopedStorage"`.

**Play policy:** all-files access is restricted to narrow categories (file managers, backup/restore,
antivirus, document management, on-device file search, disk encryption, device-to-device migration)
with a declaration form. An AI agent does not qualify. Distribution is therefore sideload / F-Droid /
GitHub releases. `MOBILECLAW_PLAY_SAFE=1` builds without the permission for anyone who wants to try
a Play-style build.

Because the agent works in **real paths**, `PathGuard` containment is what keeps it honest: the
configured roots are the contract, and everything outside them is refused with an explanation.

## 2. Executing commands and binaries

Two hard constraints:

1. **W^X.** Since Android 10, apps targeting API 29+ cannot `execve()` a file in their writable data
   directory (SELinux gives `untrusted_app` no execute on `app_data_file`). `Runtime.exec()` on
   something in `files/` fails. You cannot download a binary and run it.
2. **Therefore: bundled tools ship inside the APK** as `jniLibs/<abi>/lib*.so`. They are unpacked to
   `applicationInfo.nativeLibraryDir`, which *is* executable. Requirements: real PIE ELF, `lib*.so`
   name, correct ABI, and 16 KB page alignment for Android 15+ targets.

The app does not bundle a busybox/python today; it delegates instead.

### Shell backends, in preference order

| Backend | How it works | Setup the user must do | Limits |
| --- | --- | --- | --- |
| **Shizuku** | A Shizuku **UserService** (our own AIDL `Stub`) runs our code as uid 2000/0. | Install Shizuku, enable wireless debugging, grant the app permission — **after every reboot**. | Shell identity, **not root**: cannot read other apps' `/data/data`, cannot use root-only APIs. Binder dies with the Shizuku server. |
| **Termux** | `Intent(com.termux.RUN_COMMAND)` to `com.termux/com.termux.app.RunCommandService`, result via `PendingIntent`. | Install Termux; grant `com.termux.permission.RUN_COMMAND`; set `allow-external-apps=true` in `~/.termux/termux.properties`; declare `<queries><package android:name="com.termux"/></queries>`. | Result bundle truncated at ~100 KB (else `TransactionTooLargeException`); no interactive tty; a foreground session needs draw-over-other-apps to start without a tap. |
| **None** | `MemoryShellService` | — | `shell_run` returns a blocked result explaining exactly what to enable. |

**`Shizuku.newProcess` is deprecated as of 13.1.1 and slated for removal** — the replacement is a
UserService. Dependencies (Maven Central): `dev.rikka.shizuku:api:13.1.5` and
`:provider:13.1.5`; provider authority `${applicationId}.shizuku`; 13.1.0+ needs core library
desugaring when `minSdk < 24`.

There is **no React Native wrapper** for Shizuku (`react-native-shizuku` does not exist on npm), so
the bridge is a local Expo module with an AIDL interface.

## 3. Python and Node on device

- **Chaquopy 17** is the only credible in-app Python. Gradle plugin, `minSdk ≥ 24`, mandatory
  `abiFilters`, allowed in exactly one module. No `curses`/`tkinter`/`readline`; `multiprocessing` is
  broken. Two real EAS risks: `buildPython` must be the *exact* matching minor version on the build
  machine for pip/static proxy, and Expo's SDK 57 build image documents Node/JDK/NDK but **not**
  Python. Licence terms need checking before committing.
- **No maintained in-app Node.** `nodejs-mobile-react-native` last shipped in Oct 2024 against Node
  18 (EOL), with unproven New Architecture support. Treat it as a dead end.
- **Hermes is not a script engine.** It ships with RN but does not evaluate arbitrary runtime
  strings in production, so "run this JS the model wrote" is not a feature you get for free.
  QuickJS/JSC embedding works if you are willing to own the JSI bridge and sandbox.

Consequence: the `python_*` tools reach an interpreter **through the shell backend** (Termux today,
Chaquopy later) and send the snippet over **stdin**, so no quoting can break it. When nothing is
available they report precisely how to enable it.

## 4. Cross-app automation

| Capability | Mechanism | Requirement |
| --- | --- | --- |
| Open URL / app | `Intent` (`expo-intent-launcher`) | Android 11+ needs `<queries>` to resolve third-party packages; `QUERY_ALL_PACKAGES` is Play-restricted. |
| Share text | `Share` sheet | None — the safest hand-off. |
| Clipboard | `expo-clipboard` | None; the most reliable cross-app text channel. |
| Calendar event | `expo-calendar`, `CalendarContract` | `READ_CALENDAR`/`WRITE_CALENDAR` runtime prompt. |
| Notification | `POST_NOTIFICATIONS` (13+) | Runtime prompt. |
| Background activity start | — | Blocked on Android 10+ unless the app is in the foreground. |

Out of scope on purpose:

- **AccessibilityService UI automation.** Play's policy requires the core purpose to be
  accessibility and explicitly excludes "automation tools"; Android 17's opt-in Advanced Protection
  Mode blocks the Accessibility API for apps that are not accessibility tools. Sideloading avoids
  review, not AAPM.
- **Notification reading** (`NotificationListenerService`, user-granted via Settings + Play
  justification), **exact alarms** (`USE_EXACT_ALARM` is Play-limited to alarm/calendar apps), and
  **SMS / call log** (default-handler apps only).

## 5. Background work

A continuously running agent loop needs a **foreground service with a declared type plus a persistent
notification** (`FOREGROUND_SERVICE_DATA_SYNC` or `..._SPECIAL_USE` with Play justification on
Android 14+; `dataSync` is time-capped on 15+). `expo-background-task` is coarse periodic only — a
15-minute floor, network and battery required, and it stops when the user kills the app.

Current design: runs happen while the app is in the foreground, and a **notification reports
completion**. A foreground service is roadmap item 2, not a claim made today.

## 6. Secrets

`expo-secure-store` is Keystore-encrypted SharedPreferences: adequate for one short API key, not a
vault. Strings only; large payloads may be rejected; **Android values are lost on uninstall**;
`getItem`/`setItem` are synchronous and block JS; Auto Backup must exclude the SecureStore
sharedpref (the config plugin does this by default) or restored ciphertext is undecryptable. On a
rooted or Shizuku-capable device, assume any at-rest key is extractable.

The API key is therefore never written into the config object that gets persisted — it lives in
SecureStore and in memory only.

## 7. The native module: what to write

`modules/mobileclaw-native` (create with `npx create-expo-module@latest --local`), exposing exactly
these members, which `apps/mobile/src/runtime/bootstrap.ts` already expects:

```ts
// expo-module.config.json → android.modules: ["dev.mobileclaw.native.MobileClawNativeModule"]
isShizukuAvailable(): Promise<boolean>
requestShizukuPermission(): Promise<boolean>
runPrivileged(command: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }>
runTermuxCommand(command: string, args: string[], stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }>
listApps(): Promise<{ packageId: string; label: string }[]>
hasAllFilesAccess(): Promise<boolean>
requestAllFilesAccess(): Promise<void>
```

Kotlin layout:

```
modules/mobileclaw-native/
  expo-module.config.json
  android/build.gradle                 # com.android.library + expo-module-gradle-plugin
  android/src/main/AndroidManifest.xml # Shizuku provider, RUN_COMMAND permission, <queries>
  android/src/main/aidl/.../IPrivilegedService.aidl   # UserService interface
  android/src/main/java/dev/mobileclaw/native/MobileClawNativeModule.kt
  android/src/main/java/dev/mobileclaw/native/TermuxBridge.kt
  android/src/main/java/dev/mobileclaw/native/PrivilegedUserService.kt
  src/MobileClawNativeModule.ts        # typed JS surface
```

Implementation notes that will save a debugging session:

- Bind Shizuku **off the main thread**; `Shizuku.checkSelfPermission()` then `requestPermission()`
  with a result listener.
- The Termux result arrives on a `PendingIntent` callback, so the promise is resolved from a
  `BroadcastReceiver`, not from the Intent call.
- Never assume Shizuku is alive: it dies on reboot and the binder disappears. Re-probe per call —
  `shizuku_status` exists for exactly this.
- `runPrivileged` should reject on timeout rather than hang; the agent loop already enforces a tool
  timeout, but a native hang leaks the process.

Until this module exists, the app is fully functional as a **file and web agent** inside its own
directories, and every unavailable capability says so instead of failing mysteriously.
