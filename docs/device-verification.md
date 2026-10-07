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


## Not verified, and why

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
