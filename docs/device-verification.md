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

## Not verified, and why

**A real agent turn.** Every remaining gap needs a working model: the workspace directory is
created by `assignWorkspace` on a conversation's first run, and the per-conversation
permission gate only proves itself when a tool is actually requested twice. Getting a key
into the emulator failed twice over -- `expo-secure-store` does not persist there, and the
automated tap for 保存密钥 never lands because the field sits **outside the viewport**
(`uiautomator` reports off-screen nodes as `bounds=[0,0]`, which is why six different input
approaches all failed).

**`fs_write` into shared storage.** With `MANAGE_EXTERNAL_STORAGE` granted via `appops`, the
app still cannot create a file in `/storage/emulated/0/Download`:

```
Call to function 'FileSystemFile.create' has been rejected.
  → Caused by: Missing 'READ' permission for accessing the file.
```

App-private writes round-trip, so the file API works. Whether this is an emulator artefact
or real scoped-storage behaviour is unresolved. The probe classifies it as `denied`, which
is the safe direction: it tells the user access is missing rather than claiming success.

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
