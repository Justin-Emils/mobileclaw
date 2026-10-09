# MobileClaw

A mobile-first **local AI agent** — a phone-native take on DeepSeek Harness / OpenClaw. The model is
not a chat bubble: it gets real hands (files, shell, scripts, cross-app actions) and every action
passes through a permission gate that you control.

Target: **Android first**, iOS kept working by degradation (the same code path reports what the
sandbox forbids instead of pretending). Brain: any **OpenAI-compatible** endpoint (DeepSeek, OpenAI,
OpenRouter, Ollama on your LAN, vLLM…).

```
┌────────────────────────── Expo app (apps/mobile) ───────────────────────────┐
│  Chat UI · approval sheet · tool cards · settings · permission matrix       │
│                                                                             │
│  MobileClawRuntime  ── plugin host ── capability plugins (fs/shell/web/…)   │
│         │                    │                                              │
│         │              PermissionGate ── PathGuard                          │
│         ▼                                                                   │
│  Agent loop ── streaming provider (SSE) ── conversation store               │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │  platform services (injected)
      ┌────────────────────────┼────────────────────────┬─────────────────┐
      ▼                        ▼                        ▼                 ▼
 expo-file-system        shell backend            expo intents       SecureStore
 (+ guard, SAF/all-files) (Termux/Shizuku)      clipboard/share    SQLite (history)
```

## Why it is built this way

The kernel (`packages/core`) is **pure TypeScript with no platform imports**. Everything the agent
can do arrives as an injected service behind an interface, so:

- the whole agent loop is unit-testable on Node (no emulator, no device);
- the phone swaps in Expo/native implementations without touching agent behaviour;
- a future CLI or desktop host reuses the same kernel unchanged.

Plugin style follows Cordis: a plugin is a function plus metadata, it receives a context, registers
services/tools/listeners on it, and declares its dependencies via `inject` so a missing capability is
reported precisely instead of failing mid-conversation.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/core` | Kernel: context, event bus, plugin host, tool registry, permission gate, path guard, agent loop, providers, conversation store. **No `node:*`, no RN.** |
| `packages/capabilities` | Guarded filesystem + the tools: `fs_*`, `shell_*`, `web_fetch`, `system_*`, `python_*`, `shizuku_*`, `screen_*`. `./node` subpath holds the Node-only backends. |
| `apps/mobile` | Expo app (SDK 57): runtime wiring, chat UI, approval sheet, settings, permission matrix, EAS config. |
| `docs/android-capabilities.md` | Hard-won detail on what Android actually allows, and the native-module plan. |
| `docs/architecture.md` | How the pieces fit, the request lifecycle, and the invariants. |
| `docs/dev-environment.md` | **Read this before building anything.** How the Android toolchain is resolved (`eng/toolchain.cjs` / `eng/setup-toolchain.ps1`), why the SDK's outdated ninja blocked local native builds (and the two fixes), and fourteen environment-specific traps with symptoms and fixes. Shared across projects. |
| `docs/worklog/project-status.md` | **Where the project is right now**: the product goals, what works and what does not, the gap between the plan and the code, and what to write next. |
| `docs/worklog/shizuku-screen-automation.md` | The screen-automation work stream in full — decisions, evidence, and the traps that cost time. |

> **Repository location:** anywhere. The build resolves its toolchain at run time instead of
> hardcoding it (`eng/toolchain.cjs`); on a fresh machine `eng/setup-toolchain.ps1` installs a JDK
> and the Android SDK into a git-ignored `.toolchain/` beside the repo. See `docs/dev-environment.md`.

## Quick start

```bash
pnpm install
pnpm check            # typecheck + 370 tests (core 102 / capabilities 74 / mobile 194) + a real Metro bundle
pnpm doctor           # expo-doctor: dependency/SDK consistency (21 checks)
pnpm mobile           # Metro for a dev build (needs a dev client installed)
```

`pnpm check` deliberately includes **`pnpm bundle`** (`expo export --platform android`). Type
checking and unit tests both resolve the `@/*` aliases and `.ts` sources themselves, so they cannot
catch the two failures that actually block a device build: Metro not reading tsconfig `paths`, and
`.js` suffixes on extensionless TypeScript imports. Only a real bundle does.

Building an installable APK.

**Locally** (resolves a JDK + Android SDK + Gradle through `eng/toolchain.cjs`; run
`eng/setup-toolchain.ps1` once on a fresh machine if none is present — see
`docs/dev-environment.md`). The machine's execution policy refuses unsigned scripts, hence the
explicit host:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File eng\build-local.ps1 -Variant debug
# -> artifacts\mobileclaw-local-debug.apk
```

**In the cloud**, with no Android SDK on your machine:

```bash
npx eas-cli login
cd apps/mobile && npx eas-cli init          # writes the projectId
pnpm apk                                    # preview profile → installable .apk
pnpm apk:dev                                # development client for Metro
```

The default `production` profile builds an `.aab` for stores; `preview` and `development` are set to
`buildType: "apk"` in `apps/mobile/eas.json`, which is what makes the artifact installable.

Then, in the app: **Settings → pick a provider preset → paste an API key → Test connection**.
The key is written to `expo-secure-store`.

### Two rules to keep the bundle green

1. **Never pin an Expo package version by hand.** SDK 57 versions them all as `~57.x`; guessing from
   an older SDK era produces a bundle that installs but breaks. Add dependencies with
   `npx expo install <pkg>` and re-check with `pnpm doctor`.
2. **No file extensions on relative or aliased imports.** Use `from "./foo"`, not `from "./foo.js"` —
   Metro cannot map `./foo.js` onto `foo.ts`, while `tsc` and vitest happily can, so the mistake is
   invisible until you bundle.

## What the agent can do today

| Bundle | Tools | Notes |
| --- | --- | --- |
| `cap-files` | `fs_list` `fs_read` `fs_write` `fs_edit` `fs_search` `fs_info` `fs_organize` | `fs_search` does glob **and** regex content search — the workhorse for "organise my downloads". `fs_organize` always asks. |
| `cap-shell` | `shell_run` `shell_which` | Needs Termux or Shizuku; says so plainly when neither is set up. |
| `cap-web` | `web_fetch` | Returns sanitised text and tags the result as untrusted data. |
| `cap-system` | `system_open` `system_apps` `system_clipboard` `system_share` `system_notify` `system_calendar` | Intents / clipboard / share sheet / calendar writes. |
| `cap-python` | `python_run` `python_script` `python_status` | Reaches an interpreter through the shell backend (Termux, or Chaquopy later). Code goes over **stdin**, so quoting never breaks it. |
| `cap-shizuku` | `shizuku_status` `shizuku_request` `shizuku_run` | Privileged execution with shell identity (uid 2000), not root. |
| `cap-automation` | `screen_read` `screen_tap_element` `screen_current` `screen_capture` `screen_tap` `screen_scroll` `screen_type` `screen_wait` | **Reads** the current screen as text, then acts on it, through Shizuku. `screen_read` is the workhorse: it returns every readable or pressable element with its real pixel bounds, so `screen_tap_element` can press by the `#` number printed in the reading — no human in the loop, and no `AccessibilityService` (shell identity already sees the tree). `screen_capture` + `screen_tap` remain for what the tree cannot express, where the *user* places the point on the picture. Each screen-changing tool declares `neverRemember`, so "always allow" can never cover the next press, and returns a screenshot as evidence. **The native side has never been compiled**, so on a device every one of these still reports "unavailable" — the contract, the reader and the safety machinery are what exist. |

Safety model, in one line: **containment is lexical and absolute** (every model-supplied path goes
through `PathGuard`, which refuses anything outside the configured roots), and **capability is
granted by risk class** (`read`/`network` auto-allow; `write`/`execute`/`system` prompt, with
per-session "always allow" that expires).

## Deliberate limits (read these before filing a bug)

- **Google Play will not accept this app with all-files access.** `MANAGE_EXTERNAL_STORAGE` is not in
  a permitted category for an AI agent, so the intended channels are sideload, F-Droid and GitHub
  releases. `MOBILECLAW_PLAY_SAFE=1 pnpm prebuild` builds without it (agent sees app-private storage
  and SAF-granted trees only).
- **Android 10+ forbids executing files from app storage.** Any bundled tool must ship inside the
  APK as `jniLibs/<abi>/lib*.so`; you cannot download a binary and run it.
- **The privileged native module is written but has never been compiled.** The storage one works and was
  verified on a device: `MobileClawFilesModule` is inline Kotlin in `apps/mobile/app.config.ts`, written
  out by the `withMobileClawFiles` config plugin at prebuild time (there is deliberately no `.kt` file on
  disk). The Shizuku one is *real Kotlin and AIDL* under `apps/mobile/android-native/shizuku/`, copied
  into the generated project by three config plugins — but no Android toolchain has ever been present on
  the development machine, so it is a blind spot until a device build says otherwise. What still degrades
  honestly is the *backend*: with no Shizuku paired, `screen_*` and `shizuku_*` report exactly what is
  missing. Termux and the storage-access prompt remain specified and stubbed
  (`apps/mobile/src/runtime/bootstrap.ts`). See `docs/android-capabilities.md` for the detail.
- **The Expo FileSystem adapter is the one unverified seam.** It is written against the SDK 57
  `File`/`Directory`/`Paths` API and is the single place to fix if Expo renames a member
  (`apps/mobile/src/runtime/services/expo-file-system.ts`).
- **Skill-style automation via AccessibilityService is out of scope** — but not for the reason usually
  given. This app already ships without Play (`MANAGE_EXTERNAL_STORAGE` is not in a permitted category),
  so "Play rejects automation tools" excludes nothing here, and Android 17's Advanced Protection Mode
  blocks the Accessibility API for non-accessibility apps whether or not Shizuku is involved. The real
  reason is narrower and stronger: **shell identity already reads another app's accessibility tree**
  (`screen_read`), so declaring an `AccessibilityService` would buy a second permission and a second
  system-settings visit for a view we already have.

## Roadmap

1. **Native module** (`modules/mobileclaw-native`): Shizuku UserService, Termux `RUN_COMMAND`,
   all-files access prompt, installed-app list. Unlocks `shell_run`, `python_*`, `shizuku_*`.
2. **Background runs**: a foreground service with a declared type so long jobs survive the app being
   backgrounded (`dataSync` / `specialUse`), plus a notification when a run completes.
3. **SAF onboarding**: a folder picker that stores persisted tree URIs, so the agent works without
   all-files access.
4. **Chaquopy Python**: a real in-app interpreter, behind the same `python_*` tools.
5. **Skill packages**: installable plugin bundles (the plugin host already supports runtime
   load/unload and reports failures per plugin).
