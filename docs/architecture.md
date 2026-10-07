# Architecture

## The one rule

`packages/core` must never import a platform module. Not `node:fs`, not
`react-native`, not `expo-*`. Everything the agent can *do* is a **service behind an interface**
injected at construction time. This is what makes the agent loop testable on a laptop and what keeps
the phone-specific mess confined to `apps/mobile`.

The dependency direction is strictly one-way:

```
apps/mobile  ──▶  packages/capabilities  ──▶  packages/core
   (Expo/RN)          (tools, guard)            (pure kernel)
```

`packages/capabilities` has a **`./node` subpath** for the Node-only backends (`node:fs`,
`node:child_process`). The root entry point must stay importable from React Native, so a React
Native bundle never reaches `node:*` through `@mobileclaw/capabilities`.

## Layers

### 1. Kernel (`packages/core`)

| Module | Responsibility |
| --- | --- |
| `context.ts` | Service container + logger + per-plugin store. Child contexts resolve services through their ancestors, so a plugin sees what the host published. |
| `events.ts` | Typed event bus. **Hosts that add events must declare them as a type alias**, not an interface — TypeScript only gives type aliases an implicit index signature, which is what `extends EventMap` needs. |
| `plugin.ts` | `PluginHost`: loads plugins, checks `inject` **before** `apply`, registers declared tools, rolls back partial registration on failure. A broken plugin is contained, never fatal. |
| `tools-registry.ts` | Tool registration + validation + execution. Rejects duplicate and non-snake_case names (silent overwrite would make behaviour depend on plugin order). Converts Zod schemas to JSON Schema by hand. |
| `path-guard.ts` | Lexical, I/O-free path containment. Containment is authoritative: a path outside the roots is refused whether it got there via `..` or directly. |
| `permission.ts` | The only place "may this run?" is answered. Evaluation order: session allowlist → deny rules → allow rules → `alwaysAsk` → `alwaysAskRisks` → `riskModes` → `defaultMode`. |
| `agent.ts` | The loop. Streaming call, tool-call aggregation, permission gate, tool execution, transcript, stop conditions. |
| `provider/*` | `BaseProvider` (stream → single message, plus the SSE parser) and `OpenAiCompatibleProvider`. |
| `store.ts` | `ConversationStore` over any `KeyValueStore`, so the app can use SQLite and tests can use memory. |

### 2. Capabilities (`packages/capabilities`)

`GuardedFileSystem` implements `FileSystemService` on top of a small `FsDriver` port. **Tools never
resolve paths themselves** — every model-supplied path goes through the guard inside the filesystem
service, which is the single chokepoint for containment.

Drivers:

- `ExpoFsDriver` (mobile, in `apps/mobile`) over `expo-file-system`'s `File`/`Directory` API.
- `NodeFsDriver` (`@mobileclaw/capabilities/node`) over `fs/promises`, for tests and a future CLI.

Tools are grouped into six plugins so a user can disable, say, shell execution without losing file
management. The bundles are created by `capabilityPlugins(deps)`; the host publishes the platform
services *before* loading them, which is what lets `inject` be validated up front.

### 3. App (`apps/mobile`)

- `src/runtime/runtime.ts` — `MobileClawRuntime`: the facade the UI talks to. Owns the context,
  plugin host, registry, permission gate and agent; rebuilds provider/agent when config changes.
- `src/runtime/services/*` — the platform adapters (file system, HTTP, shell, system automation,
  SecureStore, SQLite key/value).
- `src/ui/*` — React: runtime provider, approval sheet, tool card, theme.
- `app/*` — Expo Router screens: chat, settings, permissions.

## Request lifecycle

```
user taps Run
   │
   ├─ runtime.send(text)              creates a run id + AbortController, starts the loop,
   │                                  and bridges push→pull with AsyncEventQueue
   │
   ├─ Agent.run()                     appends the user message, persists it
   │     │
   │     ├─ buildSystemPrompt()       base prompt + tool inventory + environment block
   │     ├─ provider.stream()         POST /chat/completions (SSE) via injected fetch
   │     │      └─ yields text / reasoning / tool_call / usage / done
   │     ├─ assistant message         tool calls aggregated by index across chunks
   │     ├─ for each tool call:
   │     │     ├─ registry.get()      unknown tool → E_TOOL_NOT_FOUND (as a tool result)
   │     │     ├─ permissions.evaluate() → authorize()
   │     │     │      └─ may park on the approval modal; the UI resolves the promise
   │     │     ├─ registry.execute()  Zod input parse → run → Zod output parse
   │     │     └─ tool message        result or structured error, fed back next turn
   │     └─ loop until no tool calls, step limit, cancellation, or provider error
   │
   └─ events stream to React          text deltas render live; tool cards update in place
```

Every tool call gets exactly one tool message — an unanswered call makes the next request invalid, so
cancellation still writes a `[E_CANCELLED]` result before returning.

## Invariants worth preserving

1. **`packages/core` imports nothing platform-specific.** If you need a capability there, it belongs
   in an interface.
2. **Every model-supplied path passes the guard.** No exceptions, no "just this once" shortcuts.
3. **A tool failure is data, not an exception.** Errors reach the model as `[E_*]` strings so it can
   adapt; only programmer errors throw past the loop.
4. **One tool call → one tool result.** Even on denial and cancellation.
5. **Non-zero exit codes never throw.** `shell_run` returns `exitCode` so the model can read stderr.
6. **`[DONE]` does not erase `finish_reason`.** `BaseProvider` keeps the first reported reason.
7. **Transport is injected, providers are derived.** The provider is a projection of the config; the
   *fetch* implementation is what tests and hosts replace.
8. **Capabilities degrade with an explanation.** `python_status`, `shell_which` and `shizuku_status`
   exist so the model can discover what is missing and tell the user how to enable it.

## Testing strategy

| Suite | What it locks down |
| --- | --- |
| `packages/core/test` (56) | Event bus semantics, service resolution, path containment, permission evaluation, Zod→JSON Schema, SSE chunk splitting, agent loop (tool use, denial, step limit, cancellation, persistence). |
| `packages/capabilities/test` (34) | Guarded filesystem on real temp dirs, glob/grep, edits, dry runs, shell stdout/exit codes/timeout/kill, Python and Shizuku degradation, HTML sanitising. |
| `apps/mobile/test` (24) | The push→pull streaming bridge, approval broker, config merge, storage adapters, and a full turn through the **real** OpenAI provider against a fake streaming `fetch`. |

`pnpm check` runs typecheck (all three packages) plus all suites. A device build is only needed for
things that genuinely need a device: Expo native modules, intents, and the Kotlin bridge.
