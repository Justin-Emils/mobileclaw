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
| `packages/capabilities` | Guarded filesystem + the tools: `fs_*`, `shell_*`, `web_fetch`, `system_*`, `python_*`, `shizuku_*`. `./node` subpath holds the Node-only backends. |
| `apps/mobile` | Expo app (SDK 57): runtime wiring, chat UI, approval sheet, settings, permission matrix, EAS config. |
| `docs/android-capabilities.md` | Hard-won detail on what Android actually allows, and the native-module plan. |
| `docs/architecture.md` | How the pieces fit, the request lifecycle, and the invariants. |
| `docs/dev-environment.md` | **Read this before building anything.** Toolchain paths (`E:\code\Eng`), the Windows 260-character path constraint, and seven environment-specific traps with symptoms and fixes. Shared across projects. |

> **Repository location:** `E:\code\mobileclaw` (moved from `E:\code\mobileclaw` on
> 2026-10-07). See `docs/dev-environment.md`.

## Quick start

```bash
pnpm install
pnpm check            # typecheck + 130 tests + a real Metro bundle, no device needed
pnpm doctor           # expo-doctor: dependency/SDK consistency (21 checks)
pnpm mobile           # Metro for a dev build (needs a dev client installed)
```

`pnpm check` deliberately includes **`pnpm bundle`** (`expo export --platform android`). Type
checking and unit tests both resolve the `@/*` aliases and `.ts` sources themselves, so they cannot
catch the two failures that actually block a device build: Metro not reading tsconfig `paths`, and
`.js` suffixes on extensionless TypeScript imports. Only a real bundle does.

Building an installable APK **in the cloud, with no Android SDK on your machine**:

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
- **The native module is not written yet.** Termux, Shizuku and the storage-access prompt are
  specified and stubbed (`apps/mobile/src/runtime/bootstrap.ts`) so nothing pretends to work; the
  current build's shell tools report unavailability. See `docs/android-capabilities.md` for the plan.
- **The Expo FileSystem adapter is the one unverified seam.** It is written against the SDK 57
  `File`/`Directory`/`Paths` API and is the single place to fix if Expo renames a member
  (`apps/mobile/src/runtime/services/expo-file-system.ts`).
- **Skill-style automation via AccessibilityService is out of scope.** Play policy excludes
  "automation tools", and Android 17's Advanced Protection Mode blocks the Accessibility API for
  apps that are not accessibility tools.

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
