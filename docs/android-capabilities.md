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

### Two storage permissions, not one

Easy to conflate, and conflating them produces "the folder is empty" for a folder that is full:

| Permission | Android | How it is granted | Without it |
| --- | --- | --- | --- |
| `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion=32` in the manifest) | ≤ 12 (API 32) | **Runtime dialog** (`PermissionsAndroid.requestMultiple`) | Shared storage is denied outright: names may still list, contents never read |
| `MANAGE_EXTERNAL_STORAGE` | 11+ (API 30) | **No dialog** — only `ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` in settings | Names list, but every file reports as non-existent |

Declaring either in the manifest grants nothing. The app declared both and requested
neither, which is the likeliest reason shared storage read as empty. Where the code lives:

- `apps/mobile/src/runtime/services/permissions.ts` — pure: probes whether access is in
  effect, and decides which legacy permissions a given API level needs. Unit-tested.
- `apps/mobile/src/runtime/services/storage-permissions.ts` — device-only: the runtime
  request and the settings jump. `runtime.ts` imports it, so vitest aliases `react-native`
  to a stub (see `apps/mobile/vitest.config.ts`).
- The chat screen asks once on first launch, guarded by a persisted flag; the settings
  screen exposes both an "申请读写权限" button and the all-files settings jump.

On Android 13+ the legacy pair is replaced by granular `READ_MEDIA_*`, so
`legacyStoragePermissionsFor` returns nothing there — prompting would show no dialog and
look like a silent failure.

**Two failure modes look identical and are not.** "Not allowed to look" and "allowed to
look and it is empty" both surface as an empty listing. `probeAllFilesAccess` distinguishes
them by probing directories that are never empty on a real phone, and both `fs_list` and
`fs_search` report entries they could not read instead of dropping them — a silent drop is
what let the agent conclude a full folder was empty.

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

## 7. The native modules: what was built

Two `ReactPackage`s, both generated by config plugins in `apps/mobile/app.config.ts`, because
`android/` is git-ignored and regenerated by `expo prebuild`.

**Not an Expo module.** One was tried first: its Kotlin compiled into the APK and Gradle included the
project, but `requireNativeModule` never resolved it (`expo-modules-autolinking search` found the
module while `resolve` did not), so the app silently fell back to expo-file-system and looked like the
fix had simply not worked. A `ReactPackage` has no discovery step — either the class compiles and is
registered, or the build fails loudly. After a defect that hid behind a silent fallback, that matters
more than tidiness. See `docs/device-verification.md`.

### `MobileClawFiles` — storage (working, verified on a device)

Written by `withMobileClawFiles`, **inlined as a Kotlin template string** in `app.config.ts`. It
exists to bypass expo-file-system's `File.canRead()`/`canWrite()` pre-check, which returns false for
any file the app does not own — so shared-storage writes were refused even with all-files access
granted, and reported as a missing READ permission, sending the user to a switch that was already on.

### `MobileClawShizuku` — screen automation (written, **never compiled**)

Written by `withMobileClawShizuku` / `withShizukuManifest` / `withShizukuGradle`, copied from **real
files** under `apps/mobile/android-native/shizuku/`:

```
android-native/shizuku/
  IMobileClawShizukuUserService.aidl
  MobileClawShizukuModule.kt        # app process
  MobileClawShizukuUserService.kt   # shell process (uid 2000)
  MobileClawShizukuPackage.kt
```

What each plugin does:

| Plugin | Effect |
| --- | --- |
| `withMobileClawShizuku` | copies the four files into `app/src/main/{java,aidl}/dev/mobileclaw/app/shizuku/`, registers the package in `MainApplication.kt` |
| `withShizukuManifest` | `<provider android:name="rikka.shizuku.ShizukuProvider">` with `authorities="${applicationId}.shizuku"` and `permission=android.permission.INTERACT_ACROSS_USERS_FULL` |
| `withShizukuGradle` | `implementation("dev.rikka.shizuku:api:13.1.5")` and `:provider`, plus `buildFeatures { aidl true }` |

**The interface is deliberately tiny** — `exec` and `screenshot`. Taps, scrolls, `dumpsys`
parsing and text entry are composed as `input …` command lines on the JS side
(`apps/mobile/src/runtime/services/native-shizuku.ts`). The Kotlin cannot be compiled on a development
machine without the Android toolchain, so every line of it is a blind spot until a device build says
otherwise — and the JS has tests. Each additional native method is another unverifiable thing.

Notes that will save a debugging session:

- **`destroy` is deliberately absent from the `.aidl`.** It used to be declared as
  `void destroy() = 16777114;`, which AIDL rejects outright — a file may give ids to all methods or
  to none, and Shizuku wants a reserved code rather than the next sequential one:
  `ERROR: ...aidl:35.9-17: You must either assign id's to all methods or to none of them.`
  That error only appeared once a full build first ran, because the file was written on a machine
  with no toolchain. Declaring it was also dead weight: the resolved transaction code for the
  teardown is **16777115** while the documented AIDL constant is **16777114**, and `onTransact`
  accepts either — so the call is handled in Kotlin, and an AIDL method would never have reached it.
  Getting this wrong leaks a shell process on every reconnect.
- The UserService process is **not a valid Android application process**. A `Context` may exist but
  `getContentResolver` and `registerReceiver` do not work. Nothing in it reaches for one.
- uid 2000 cannot write into the app's private directory, and the app cannot read
  `/data/local/tmp`. That is the only reason the capture crosses the binder as bytes instead of as a
  file path.
- A window with `FLAG_SECURE` comes back as a single flat colour, indistinguishable from a screen
  that really is plain. The service reports it as a `note` rather than letting it pass for an empty
  screen.
- `buildFeatures { aidl true }` is **not optional**: AGP 8 defaults it off, and with it off the
  `.aidl` is ignored — the Kotlin then fails with "cannot find symbol" for a Stub that was never
  generated, which reads like a code error rather than a configuration one.
- Shizuku dies on every reboot and the binder disappears with it. That is the normal "not available"
  case, not a fault; `status()` distinguishes not-installed / not-running / not-permitted so the user
  gets the right instruction.

`PACKAGE_QUERIES` in `app.config.ts` includes `moe.shizuku.privileged.api` so the app can tell "not
installed" from "installed but not running". A `<queries>` entry works on play-safe builds too,
unlike `QUERY_ALL_PACKAGES`.

**Before this module worked at all**, the app was fully functional as a **file and web agent** inside
its own directories, and every unavailable capability said so instead of failing mysteriously. That
property is worth preserving: the tools are still registered when the backend is absent, and they
explain the gap.

