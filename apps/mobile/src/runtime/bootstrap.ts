import { AppState, Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { openDatabaseAsync } from "expo-sqlite";
import * as Linking from "expo-linking";
import * as Clipboard from "expo-clipboard";
import * as IntentLauncher from "expo-intent-launcher";
import * as Calendar from "expo-calendar";
import * as Notifications from "expo-notifications";
import { Share } from "react-native";
import { AdapterKeyValueStore } from "./services/storage";
import { SqliteKvAdapter } from "./services/sqlite-kv";
import { createSecretStore, API_KEY_SECRET } from "./services/secrets";
import { ExpoHttpService } from "./services/expo-http";
import { ExpoSystemService, type ExpoSystemPorts } from "./services/expo-system";
import { MemoryShellService } from "./services/memory-shell";
import {
  createExpoFileSystem,
  defaultAppRoots,
  uriToPath,
  type ExpoFsLike,
} from "./services/expo-file-system";
import { createWebSearchService } from "@mobileclaw/capabilities";
import { describeStorageAccess, probeAllFilesAccess } from "./services/permissions";
import { createNativeDriver, listInstalledApps, loadNativeFiles } from "./services/native-files";
import { openAppByPackageId } from "./services/app-launch";
import {
  createAutomationService,
  createPrivilegedService,
  loadNativeShizuku,
} from "./services/native-shizuku";
import { MobileClawRuntime } from "./runtime";
import { DEFAULT_CONFIG, mergeConfig } from "./config";
import {
  createExpoScreenshotStore,
  createScreenshotRetention,
  resolveScreenshotDir,
  retentionMs,
  DEFAULT_RETENTION_DAYS,
} from "./screenshots";
import { createRunKeepAwake } from "./foreground";
import type {
  AutomationService,
  FileSystemService,
  PrivilegedService,
  ShellResult,
  ShellService,
} from "@mobileclaw/core";

const CONFIG_KEY = "mobileclaw.config";

/**
 * Environment overrides for automated device testing.
 *
 * Why this exists: driving the settings screen from adb failed in six different ways
 * (dropped characters, react-native putting the *placeholder* in the accessibility `text`
 * attribute so a read-back check compares against the placeholder forever, a layout that
 * shifts as fields fill in, tapping a non-clickable text node, a tap the Pressable never
 * receives, and finally a field that sits *outside the viewport* so uiautomator reports
 * its bounds as [0,0]). Baking the endpoint in at build time avoids all of it.
 *
 * Safety:
 *  - gated on `__DEV__`, so a production bundling removes it;
 *  - each variable is optional and independent;
 *  - the API key is read here but never written to the config object, so it cannot end
 *    up in the persisted config JSON.
 *
 * Names must carry Expo's `EXPO_PUBLIC_` prefix: that is the only form Metro substitutes.
 * A plain `process.env.X` survives as a runtime lookup, and `process` does not exist in
 * React Native, so the read silently yields nothing. Verified by searching a built bundle
 * for the value.
 *
 * Usage (a throwaway test build only, with a development bundle so `__DEV__` is true):
 *   $env:EXPO_PUBLIC_MOBILECLAW_TEST_BASE_URL='http://10.0.2.2:8787/v1'
 *   $env:EXPO_PUBLIC_MOBILECLAW_TEST_MODEL='mock-model'
 *   $env:EXPO_PUBLIC_MOBILECLAW_TEST_API_KEY='sk-mock-local-key'
 *   .\eng\build-local.ps1 -Variant release
 */
export function readTestOverrides(
  env: Record<string, string | undefined> | undefined,
  isDev: boolean,
): { baseUrl?: string; model?: string; apiKey?: string } {
  if (!isDev || !env) return {};
  const read = (name: string): string | undefined => {
    const raw = env[name];
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
  };
  const baseUrl = read("EXPO_PUBLIC_MOBILECLAW_TEST_BASE_URL");
  const model = read("EXPO_PUBLIC_MOBILECLAW_TEST_MODEL");
  const apiKey = read("EXPO_PUBLIC_MOBILECLAW_TEST_API_KEY");
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

function testOverrides(): { baseUrl?: string; model?: string; apiKey?: string } {
  return readTestOverrides(typeof process !== "undefined" ? process.env : undefined, __DEV__);
}

/**
 * Compose the runtime from real platform modules.
 *
 * Every optional capability is probed rather than assumed: a phone without
 * Termux, without Shizuku and without storage permission still gets a working
 * file agent inside its own directories, and the diagnostics screen says exactly
 * what is missing and why.
 */
export async function bootstrapRuntime(): Promise<MobileClawRuntime> {
  // --- persistence ---------------------------------------------------------
  const db = await openDatabaseAsync("mobileclaw.db");
  const kv = new AdapterKeyValueStore(new SqliteKvAdapter(db));
  // Probing here means the backend is known before the key is first read, and a device
  // with a broken Keystore degrades to the app's own storage instead of being unusable.
  const secrets = await createSecretStore(SecureStore, new AdapterKeyValueStore(new SqliteKvAdapter(db, "secret_fallback")));

  const storedConfig = await kv.get(CONFIG_KEY);
  let parsedConfig: unknown = DEFAULT_CONFIG;
  if (storedConfig) {
    try {
      parsedConfig = JSON.parse(storedConfig);
    } catch {
      parsedConfig = DEFAULT_CONFIG;
    }
  }
  const config = mergeConfig(parsedConfig);

  // Test-only endpoint override; see `testOverrides` for why and for the safety gates.
  const overrides = testOverrides();
  if (overrides.baseUrl || overrides.model) {
    config.provider = {
      ...config.provider,
      ...(overrides.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
      ...(overrides.model ? { model: overrides.model } : {}),
    };
    console.log(`[mobileclaw] test override: baseUrl=${config.provider.baseUrl} model=${config.provider.model}`);
  }
  if (overrides.apiKey) {
    // Written to the secret store, not to the config, so it stays out of persisted JSON.
    await secrets.set(API_KEY_SECRET, overrides.apiKey);
    console.log("[mobileclaw] test override: API key seeded into the secret store");
  }

  // --- filesystem ----------------------------------------------------------
  const appRoots = defaultAppRoots(expoFsModule());
  const roots = config.roots.length > 0 ? config.roots : dedupe([...appRoots, ...sharedRoots()]);
  // Prefer the native driver: expo-file-system refuses shared-storage writes regardless of
  // permission, because it gates on `File.canRead()`/`canWrite()` and those are false for a
  // file owned by another uid. Falls back to expo when the native module is absent.
  const nativeFiles = loadNativeFiles();
  const fs = createExpoFileSystem({
    fs: expoFsModule(),
    roots,
    allowReadOutsideRoots: false,
    maxReadBytes: 1_000_000,
    ...(nativeFiles ? { driver: createNativeDriver(nativeFiles) } : {}),
  });
  console.log(
    `[mobileclaw] file driver = ${nativeFiles ? "native (MobileClawFiles)" : "expo-file-system"}`,
  );

  // --- privileged execution and screen automation ---------------------------
  // Shizuku lends shell identity (uid 2000) without root, which is what makes screen
  // capture and input injection reachable from an ordinary app. Without it both stay
  // undefined, and the tools say so with instructions rather than failing obscurely.
  const nativeShizuku = loadNativeShizuku();
  const privileged = nativeShizuku ? createPrivilegedService(nativeShizuku) : undefined;
  const automation = nativeShizuku
    ? createAutomationService(nativeShizuku, {
        // `input text` is ASCII-only, so anything else goes through the clipboard and a
        // paste keystroke. Only this process can write the clipboard; the shell side
        // runs as uid 2000 and cannot.
        setClipboard: async (text) => {
          await Clipboard.setStringAsync(text);
        },
      })
    : undefined;
  console.log(
    `[mobileclaw] privileged backend = ${nativeShizuku ? "shizuku (MobileClawShizuku)" : "none"}`,
  );

  // --- staying alive while a run is in progress -----------------------------
  // The agent loop is JavaScript in this app, so the run only progresses while the process does.
  // The one part of that this app can influence is the display: the screen is the thing being
  // automated, so a display that sleeps ends a run for a reason unrelated to the task.
  //
  // What this deliberately does *not* do any more is watch `AppState` and abort. That guard had the
  // question backwards — see the note on `onRunForegroundLoss` below.
  const keepAwake = createRunKeepAwake(nativeShizuku);

  // --- shell backends ------------------------------------------------------
  const shell = await pickShellBackend(privileged);

  // --- HTTP ----------------------------------------------------------------
  const http = new ExpoHttpService();

  // --- web search ----------------------------------------------------------
  // Composed here rather than inside the capability layer so the choice of backend is
  // visible where the runtime is wired. A configured instance wins; otherwise the
  // built-in scraper answers, and either way the response says which one it was.
  const search = createWebSearchService(http, {
    ...(config.searxngBaseUrl ? { searxngBaseUrl: config.searxngBaseUrl } : {}),
  });
  console.log(`[mobileclaw] web search backend = ${search.kind}`);

  // --- screenshots ---------------------------------------------------------
  // Kept app-internal, so the phone's gallery never indexes them and no other app can read
  // them — which is also why nothing else will ever tidy them up. Retention is therefore ours
  // to enforce: `pruneScreenshots` runs at launch and after every capture, and reports what it
  // removed so the fact reaches the transcript instead of being invented or omitted.
  const screenshotDir = await resolveScreenshotDir(nativeShizuku);
  const retention = createScreenshotRetention(
    createExpoScreenshotStore(expoFsModule(), () => screenshotDir()),
  );  const pruneScreenshots = () =>
    retention.prune(retentionMs(config.screenshotRetentionDays ?? DEFAULT_RETENTION_DAYS));
  if (screenshotDir()) {
    // Sweep once at launch: a phone that keeps the app resident for days would otherwise never
    // reach this path, and the pile only grows while a run is in progress.
    const swept = await pruneScreenshots();
    if (swept.deleted > 0) {
      console.log(`[mobileclaw] screenshots: removed ${swept.deleted} expired, kept ${swept.kept}`);
    }
  }

  // --- system automation ---------------------------------------------------
  const system = new ExpoSystemService(
    createSystemPorts({
      ...(privileged ? { privileged } : {}),
      ...(automation ? { automation } : {}),
    }),
  );

  // --- runtime -------------------------------------------------------------
  const runtime = new MobileClawRuntime({
    config: { ...config, roots },
    secrets,
    kv,
    fs,
    shell,
    http,
    system,
    search,
    environment: () => describeEnvironment(roots, fs),
    // App-owned storage: no permission needed, survives updates, easy to inspect.
    workspaceBaseDir: appRoots[0] ?? uriToPath(Paths.document.uri),
    // Deliberately not the workspace: see `RuntimeDeps.screenshotDir`.
    screenshotDir: screenshotDir(),
    pruneScreenshots,
    screenshots: retention,
    // Holding the display awake is still wanted, and for the same reason as before: the screen is
    // the thing being automated, so a display that sleeps ends a run for a reason unrelated to the
    // task. It is unrelated to the app's foreground state, which nothing here consults any more.
    keepAwake,
    // No `onRunForegroundLoss`. An earlier version aborted the run the moment the app left the
    // foreground, and it was wrong for a reason worth keeping written down: **this app is meant to
    // be behind the app it is operating.** A phone shows one app at a time, so the state that guard
    // treated as failure is the normal working state — and its only visible effect was cancelling a
    // run as soon as the user switched to the conversation they had just asked the agent to open.
    //
    // What actually protects the irreversible step is the package check in `screen_send_message`:
    // the final reading must have come from the app the caller named. That is decided from the
    // screen, at the moment of pressing, instead of from our own process's state.
    //
    // The risk the guard was reaching for is real but is not solved by stopping: a backgrounded
    // process may later be frozen or killed under memory pressure, at a moment nobody can predict,
    // leaving a run silently unfinished either way. The fix for that is a foreground service, which
    // is written up as a fallback in `docs/runtime-prerequisites.md` and deliberately not built yet.
    onConfigChange: async (next) => {
      await kv.set(CONFIG_KEY, JSON.stringify(next));
    },
  });
  await runtime.start();
  return runtime;
}

/**
 * Storage roots worth offering. Shared storage paths only resolve when the app
 * holds all-files access; the guard rejects them otherwise, which is why they are
 * a superset here rather than an error.
 */
function sharedRoots(): string[] {
  if (Platform.OS !== "android") return [];
  return [
    "/storage/emulated/0/Download",
    "/storage/emulated/0/Documents",
    "/storage/emulated/0/DCIM",
    "/storage/emulated/0/Pictures",
  ];
}

/**
 * Shell selection order:
 *   1. Shizuku (native module)  — highest privilege, needs user pairing
 *   2. Termux RUN_COMMAND       — cheapest real shell, needs user configuration
 *   3. none                     — a memory backend that explains itself
 */
async function pickShellBackend(privileged?: PrivilegedService): Promise<ShellService> {
  if (privileged) {
    try {
      if (await privileged.isAvailable()) return new NativeBridgeShell(privileged);
    } catch {
      // Fall through to Termux.
    }
  }

  const termuxInstalled = await isTermuxInstalled();
  if (termuxInstalled) return new TermuxShellService();

  return new MemoryShellService({
    available: false,
    reason: termuxInstalled
      ? "Termux is installed but external command execution is not enabled"
      : "no shell backend: install Termux (or pair Shizuku) and enable it in Settings",
  });
}

async function isTermuxInstalled(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await Linking.canOpenURL("termux://");
  } catch {
    return false;
  }
}

/**
 * Shell backend over the privileged service, which runs with Shizuku's shell
 * identity (uid 2000) rather than this app's own.
 */
class NativeBridgeShell {
  readonly kind = "shizuku";
  constructor(private readonly privileged: PrivilegedService) {}

  async available(): Promise<boolean> {
    try {
      return await this.privileged.isAvailable();
    } catch {
      return false;
    }
  }

  async reason(): Promise<string> {
    return "Shizuku is not running: open the Shizuku app to start the service, then grant MobileClaw permission again";
  }

  async run(command: string, options: { timeoutMs?: number } = {}): Promise<ShellResult> {
    return this.privileged.run(command, { timeoutMs: options.timeoutMs ?? 60_000 });
  }
}

/** Shell backend over Termux's RUN_COMMAND service (native side does the Intent). */
class TermuxShellService {
  readonly kind = "termux";

  async available(): Promise<boolean> {
    return false;
  }

  async reason(): Promise<string> {
    return "Termux backend needs the native module to send RUN_COMMAND; enable it in Settings";
  }

  async run(command: string) {
    return {
      command,
      exitCode: 127,
      stdout: "",
      stderr: "Termux backend is not wired up in this build",
      durationMs: 0,
      blocked: true,
    };
  }
}

/**
 * Where the native module lands. Written out so the remaining work is a single,
 * well-defined piece of Kotlin (see docs/android-capabilities.md):
 *
 *   1. `TermuxShellService.run` → `Intent("com.termux.RUN_COMMAND")` to
 *      `com.termux/com.termux.app.RunCommandService`, with a `PendingIntent` for
 *      the result bundle. Needs `com.termux.permission.RUN_COMMAND` granted AND
 *      `allow-external-apps=true` in `~/.termux/termux.properties`.
 *   2. `NativeShizukuModule.runPrivileged` → a Shizuku **UserService** (your
 *      own AIDL `Stub`) because `Shizuku.newProcess` is deprecated as of 13.1.1.
 *      Never bind Shizuku on the main thread, and expect the binder to die on
 *      every reboot.
 *   3. `hasAllFilesAccess` / `requestAllFilesAccess` → 
 *      `Environment.isExternalStorageManager()` plus
 *      `Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` (there is no
 *      runtime dialog for all-files access).
 */

function createSystemPorts(
  extra: { privileged?: PrivilegedService; automation?: AutomationService } = {},
): ExpoSystemPorts {
  const ports: ExpoSystemPorts = {
    async openUrl(url) {
      await Linking.openURL(url);
    },
    async sendIntent(intent) {
      await IntentLauncher.startActivityAsync(intent.action, {
        ...(intent.data ? { data: intent.data } : {}),
        ...(intent.package ? { packageName: intent.package } : {}),
        ...(intent.extras ? { extra: intent.extras } : {}),
      });
    },
    async getClipboard() {
      return Clipboard.getStringAsync();
    },
    async setClipboard(text) {
      await Clipboard.setStringAsync(text);
    },
    async shareText(text, title) {
      await Share.share({ message: text, ...(title ? { title } : {}) });
    },
    async notify(notification) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: notification.title,
          ...(notification.body ? { body: notification.body } : {}),
        },
        trigger: null,
      });
    },
  };

  if (Platform.OS === "android") {
    // The reasoning lives in `./services/app-launch`, which is unit-tested: the previous
    // implementation used `startActivityAsync` with a `packageName` that Expo silently ignores
    // (it is only read alongside a `className`), so launches were not pinned to the package at
    // all and could land in an unrelated app.
    ports.openApp = async (packageId: string) => openAppByPackageId(packageId, IntentLauncher);

    // `system_apps` was declared but never wired, so it always failed with "not supported on
    // this platform" -- which surfaced to the user as a bare 失败 in the tool card, with no
    // explanation of what went wrong or what to do. The native module answers it now.
    ports.listApps = async () => {
      const apps = await listInstalledApps();
      if (!apps) {
        throw new Error(
          "读不到已安装应用列表：原生模块不可用（构建产物可能过期）。",
        );
      }
      return apps;
    };
  }

  ports.createCalendarEvent = async (event) => {
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const target = calendars.find((calendar) => calendar.allowsModifications);
    if (!target) throw new Error("no writable calendar on this device");
    const id = await Calendar.createEventAsync(target.id, {
      title: event.title,
      startDate: new Date(event.startMs),
      endDate: new Date(event.endMs),
      ...(event.description ? { notes: event.description } : {}),
      ...(event.location ? { location: event.location } : {}),
    });
    return { id };
  };

  // Present only when the native module registered. Every consumer treats them as
  // optional and reports what is missing, so a build without Shizuku is not broken —
  // it just cannot see or touch the screen.
  if (extra.privileged) ports.privileged = extra.privileged;
  if (extra.automation) ports.automation = extra.automation;

  return ports;
}

/** Environment block appended to the system prompt. */
async function describeEnvironment(roots: string[], fs: FileSystemService): Promise<string> {
  const lines = [
    `Platform: ${Platform.OS} (${String(Platform.Version)})`,
    `Date: ${new Date().toISOString()}`,
    `Writable roots: ${roots.join(", ")}`,
  ];

  // Probe access on every run (this function is called per agent turn, not cached).
  //
  // This line is load-bearing: on Android without all-files access, shared-storage
  // directories still enumerate by name while every file inside reads as
  // non-existent. Left unsaid, the model concludes the folders are empty and stops;
  // said out loud, it tells the user to grant access instead of inventing a finding.
  if (Platform.OS === "android") {
    const access = await probeAllFilesAccess(fs);
    lines.push(describeStorageAccess(access));
    if (access.status === "denied") {
      lines.push(
        "You can open that settings page for the user with the system_open tool, or tell them to use 设置 → 存储权限.",
      );
    }
    lines.push(
      "When a listing returns only directories that are all empty, treat it as a possible permission problem rather than proof of emptiness, and say which it is.",
    );
  } else {
    lines.push(
      "Sandbox: the app can read its own directories always; shared storage needs the platform's file permission.",
    );
  }

  if (Platform.OS === "android") {
    lines.push(
      "Shell: only available when the user enabled Termux or Shizuku. If shell_run reports unavailability, use the filesystem tools instead.",
    );
  }
  return lines.join("\n");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value && value.length > 0))];
}

/**
 * The expo-file-system namespace, handed over as a unit.
 *
 * `Paths` is a class with static getters and `File`/`Directory` are classes, so
 * the *module* is the object that satisfies `ExpoFsLike` — not an instance. The
 * single assertion keeps that contract in one place; the interfaces in
 * expo-file-system.ts are structurally checked against the real members.
 */
function expoFsModule(): ExpoFsLike {
  const module = { File, Directory, Paths };
  return module as unknown as ExpoFsLike;
}
