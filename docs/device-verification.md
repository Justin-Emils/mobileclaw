# Device verification

What was actually checked on a running Android build, and what is still open. Kept as a
separate file because "we have tests" and "we saw it work" are different claims, and the
goal for this work was the second one.

## Environment

Android 11 emulator (API 30, `google_apis`, x86_64), release APK signed with the project
keystore, installed with `adb install -r`. Verified with `adb logcat`, `uiautomator dump`
(read as a text tree, not pixels -- the emulator's software renderer returns cached frames,
so two different screens can produce byte-identical screenshots) and the app's own database
read through `sqlite3`.

## Verified working

| Feature | Evidence |
| --- | --- |
| **History: list** | Two seeded conversations appear in order with their titles parsed and relative timestamps ("4 天前") |
| **History: hydrate** | Opening one restores the full transcript: the tool card (`fs_list`, 成功, 12ms), the user message, and the assistant reply |
| **History: persistence** | The rows live in `kv_store` as `conversation:<id>` and are read back by the app; the list survives an app restart |
| **Markdown rendering** | The seeded reply contains a pipe table, and the device shows `<table>`-style structure: header cells 文件 / 大小 / 类型, then report.pdf / 2048 / PDF. No `\| :--- \|` and no `**结论**` anywhere in the tree -- the raw source the user originally reported is gone |
| **Copy affordance** | A 复制 button renders under both the user message and the assistant message |
| **Per-conversation isolation (storage)** | Each conversation row carries its own `workspace` (`…/workspaces/conv_seed_device_test` vs `…/workspaces/conv_seed_second`) and its own `allowlist` |
| **Permission detection** | With all-files access denied the app reports `denied` and shows the banner; with it granted the banner disappears |
| **Runtime permission dialog** | The "Allow MobileClaw to access photos and media" dialog appears on first launch; tapping Allow dismisses it and the app continues |
| **App boots clean** | `ReactNativeJS: Running "main"`, no `FATAL EXCEPTION`, all screens in Chinese |

## Verified by the in-app self-test (round 15)

The gaps below used to be "needs a model, therefore unverifiable on this emulator". 设置 →
自检 → 运行完整自检 runs one turn through the **real** agent pipeline with a scripted
provider, so no key and no typing are needed. One tap, then the result is read back out of
storage.

Final device result:

```
自检通过
工具调用: fs_list
工具结果回到模型: 是
会话已写入存储: 是（4 条记录）
会话工作区: /data/user/0/dev.mobileclaw.app/files/workspaces/conv_muyhh8lic8rm1j2dhx
已注册工具: fs_edit, fs_info, fs_list, … (22)
```

| Claim | Evidence |
| --- | --- |
| The agent loop runs on device | `工具调用: fs_list`, `工具结果回到模型: 是` |
| The tool really executed | The persisted transcript holds a `tool` message for `fs_list` with real output listing the allowed roots |
| A workspace is created per conversation | Four conversations, **four distinct directories** under `files/workspaces/`, named by conversation id |
| The permission gate is real | The dialog appeared (`需要你的授权 / 拒绝 / 仅本次允许 / 本次会话内总是允许`); approving it let the run finish, and the approval was recorded for the session |
| Persistence | Each run wrote a `conversation:<id>` row and appeared in 历史会话 with a relative timestamp |
| Rendering of a *generated* reply | The chat view showed the tool card (`fs_list`, `list /data/user/0/…/files/`, 成功, 11ms), the table as real cells (环节 / 状态 / 工具调用 / 成功 / 权限门 / 已通过), no `\| :--- \|`, no `**说明**`, and two 复制 buttons |

The self-test also caught two defects that the unit tests could not, because a scripted
transport that always answers cannot reveal that the shape of its own answer is wrong:
argument fragments sent with an empty `id` opened a second, empty-named tool call
(`E_TOOL_NOT_FOUND unknown tool ""`), and the pass condition ignored tool failures so it
reported 通过 anyway. Both are fixed.

## The symptom behind feature (4), observed

The `fs_list` output on a device, with the runtime permission granted but all-files access
withheld:

```
/data/user/0/dev.mobileclaw.app/files/ (3 entries)
  SQLite/
  workspaces/
  profileinstaller_profileWrittenFor_lastUpdateTime.dat (8 B)
/storage/emulated/0/Download (0 entries)
/storage/emulated/0/Documents (0 entries)
/storage/emulated/0/Pictures (1 entries)
  .thumbnails/
```

Shared storage reads as **empty** while app-private storage lists fine -- the exact
"只读到空文件夹" the user reported. That is what the system prompt's warning exists to
prevent, and it is why the warning forbids reporting such folders as empty.


## Shared-storage writes: fixed, and why they were broken

`expo-file-system` authorises an operation by asking the *filesystem* about the file
(expo-modules-core, `FilePermissionService.kt`):

```kotlin
protected open fun getExternalPathPermissions(path: String): EnumSet<Permission> =
  EnumSet.noneOf(Permission::class.java).apply {
    if (file.canRead())  { add(Permission.READ) }
    if (file.canWrite()) { add(Permission.WRITE) }
  }
```

`File.canRead()` / `canWrite()` compare the file's owner, group and mode bits against the
calling process. A file in `/storage/emulated/0/Download` belongs to another uid
(`u0_a270 media_rw`, mode `rw-rw----`), so the app is neither owner nor group member and both
calls return false -- and a file that does not exist yet can never pass either check.
All-files access does not change those bits, so the gate refused whatever the user granted and
reported it as `Missing 'READ' permission`, sending them to a switch that was already on.

Confirmed on the user's Xiaomi 2509FPN0BC (Android 16 / API 36) with all-files access granted
three independent ways: the Settings toggle reading `checked=true`,
`appops get dev.mobileclaw.app MANAGE_EXTERNAL_STORAGE` returning `Uid mode: allow`, and
`fs_list` on the same directory succeeding in 116 ms.

Fixed by a `ReactPackage` whose Kotlin uses `java.io.File`, generated and registered by the
`withMobileClawFiles` config plugin. `java.io.File` runs no pre-check: it attempts the
operation and the kernel decides -- correct, because all-files access is exactly the grant that
lets the kernel say yes. Device log after the fix:

```
[mobileclaw] native files: MobileClawFiles registered
[mobileclaw] file driver = native (MobileClawFiles)
[mobileclaw] storage access=granted /storage/emulated/0/Download 可写可读（探测文件已清理）
```

and the permission banner is gone.

### A build trap that cost the most time

The native module was correct several builds before it was *seen* to work. Raw
`gradle assembleRelease` was being run directly for speed, which **bypasses the staleness guard
in `eng/build-local.ps1`**. `createBundleReleaseJsAndAssets` stayed UP-TO-DATE, the APK shipped
the previous JS bundle, and the logs being read came from code that was no longer executing --
including a wrong diagnosis of the very bug under investigation.

`eng/build-local.ps1` now verifies, after Gradle, that the packaged bundle is newer than every
source, and fails with that explanation. Build through the script; a direct Gradle invocation is
not equivalent.

## Not verified, and why

**`fs_write` into shared storage.** Resolved above, and left here only as the record of what was
previously unknown. Earlier attempts to declare the legacy storage permissions and to replace
`File.create()` with `File.write()` had no effect; the rejection simply moved from `create` to
`write`, which is what showed the whole write path was gated rather than one call.

**An Expo module instead of `ReactPackage`.** Tried first: its Kotlin compiled into the APK and
Gradle included the project, but `requireNativeModule` never resolved it
(`expo-modules-autolinking search` found the module while `resolve` did not), so the app
silently fell back to expo-file-system. `ReactPackage` was chosen because it has no discovery
step -- either the class compiles and is registered or the build fails loudly, which matters
after a defect that hid behind silent fallbacks.


## A false alarm worth recording

An earlier session concluded the app's SQLite was broken: the screen showed
"离线演示模式" with `NativeStatement.finalizeAsync → disk I/O error`. That was **self-
inflicted**. Repeatedly copying and rewriting the app's database from a root shell left the
AVD's data partition in a state the app could no longer use. After deleting and recreating
the AVD, the same APK created `kv_store` and `secret_fallback`, wrote `flag:*` and
`mobileclaw.config` on first launch, and ran normally -- no `disk I/O error`, no offline
mode.

Two lessons: `sqlite3` from `adb shell` cannot reliably write into an app's private
directory (SELinux refuses `INSERT` even as root, while `SELECT` and `DELETE` succeed), and
mutating an app's database out from under it can break the AVD for that app.
