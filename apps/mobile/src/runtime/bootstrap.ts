import { Platform } from "react-native";
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
import { ExpoSecretStore } from "./services/secrets";
import { ExpoHttpService } from "./services/expo-http";
import { ExpoSystemService, type ExpoSystemPorts } from "./services/expo-system";
import { MemoryShellService } from "./services/memory-shell";
import {
  createExpoFileSystem,
  defaultAppRoots,
  uriToPath,
  type ExpoFsLike,
} from "./services/expo-file-system";
import { describeStorageAccess, probeAllFilesAccess } from "./services/permissions";
import { MobileClawRuntime } from "./runtime";
import { DEFAULT_CONFIG, mergeConfig } from "./config";
import type { FileSystemService } from "@mobileclaw/core";

const CONFIG_KEY = "mobileclaw.config";

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
  const secrets = new ExpoSecretStore(SecureStore);

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

  // --- filesystem ----------------------------------------------------------
  const appRoots = defaultAppRoots(expoFsModule());
  const roots = config.roots.length > 0 ? config.roots : dedupe([...appRoots, ...sharedRoots()]);
  const fs = createExpoFileSystem({
    fs: expoFsModule(),
    roots,
    allowReadOutsideRoots: false,
    maxReadBytes: 1_000_000,
  });

  // --- shell backends ------------------------------------------------------
  const shell = await pickShellBackend();

  // --- HTTP ----------------------------------------------------------------
  const http = new ExpoHttpService();

  // --- system automation ---------------------------------------------------
  const system = new ExpoSystemService(createSystemPorts());

  // --- runtime -------------------------------------------------------------
  const runtime = new MobileClawRuntime({
    config: { ...config, roots },
    secrets,
    kv,
    fs,
    shell,
    http,
    system,
    environment: () => describeEnvironment(roots, fs),
    // App-owned storage: no permission needed, survives updates, easy to inspect.
    workspaceBaseDir: appRoots[0] ?? uriToPath(Paths.document.uri),
    // Diagnostics only: lets the storage probe compare path forms against the real API.
    fileCtorForDiagnostics: expoFsModule().File,
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
async function pickShellBackend() {
  try {
    // The native module is optional; a build without it simply skips this branch.
    const native = await importOptionalNativeModule();
    if (native?.isShizukuAvailable) {
      const available = await native.isShizukuAvailable();
      if (available) return new NativeBridgeShell(native);
    }
  } catch {
    // Fall through to Termux.
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

export interface MobileClawNativeModule {
  isShizukuAvailable(): Promise<boolean>;
  requestShizukuPermission(): Promise<boolean>;
  runPrivileged(command: string, timeoutMs: number): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  listApps?(): Promise<{ packageId: string; label: string }[]>;
  hasAllFilesAccess?(): Promise<boolean>;
  requestAllFilesAccess?(): Promise<void>;
}

/**
 * Placeholder for the local Expo module (`modules/mobileclaw-native`).
 *
 * The module is not part of this skeleton because it needs a device build to be
 * meaningful (see docs/android-capabilities.md). Returning undefined keeps every
 * caller honest: no code path pretends privileged execution exists.
 */
async function importOptionalNativeModule(): Promise<MobileClawNativeModule | undefined> {
  try {
    const moduleName = "mobileclaw-native";
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod = await import(/* @vite-ignore */ moduleName).catch(() => undefined);
    return (mod as { default?: MobileClawNativeModule } | undefined)?.default;
  } catch {
    return undefined;
  }
}

/** Shell backend over the native module (Shizuku UserService). */
class NativeBridgeShell {
  readonly kind = "shizuku";
  constructor(private readonly native: MobileClawNativeModule) {}

  async available(): Promise<boolean> {
    try {
      return await this.native.isShizukuAvailable();
    } catch {
      return false;
    }
  }

  async reason(): Promise<string> {
    return "Shizuku is not running: start the Shizuku app and grant MobileClaw permission";
  }

  async run(command: string, options: { timeoutMs?: number } = {}) {
    const started = Date.now();
    const result = await this.native.runPrivileged(command, options.timeoutMs ?? 60_000);
    return {
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
    };
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
 *   2. `MobileClawNativeModule.runPrivileged` → a Shizuku **UserService** (your
 *      own AIDL `Stub`) because `Shizuku.newProcess` is deprecated as of 13.1.1.
 *      Never bind Shizuku on the main thread, and expect the binder to die on
 *      every reboot.
 *   3. `hasAllFilesAccess` / `requestAllFilesAccess` → 
 *      `Environment.isExternalStorageManager()` plus
 *      `Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` (there is no
 *      runtime dialog for all-files access).
 */

function createSystemPorts(): ExpoSystemPorts {
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
    ports.openApp = async (packageId: string) => {
      await IntentLauncher.startActivityAsync("android.intent.action.MAIN", {
        packageName: packageId,
        category: "android.intent.category.LAUNCHER",
      });
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
