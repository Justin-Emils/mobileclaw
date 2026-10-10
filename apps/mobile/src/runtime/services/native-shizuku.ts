import { SCREEN_DEFAULTS } from "@mobileclaw/core";
import {
  DUMP_COMMANDS,
  DUMP_FILE_PATH,
  formatScreenReading,
  interpretDump,
  parseScreenDump,
  projectScreen,
} from "@mobileclaw/capabilities";
import type {
  AutomationService,
  AutomationStatus,
  ForegroundWindow,
  PrivilegedService,
  ScreenCapture,
  ScreenSnapshot,
  ShellResult,
  ShellRunOptions,
} from "@mobileclaw/core";

/**
 * JS side of the `MobileClawShizuku` native module.
 *
 * Shizuku lends this app the identity of shell (uid 2000) without root, which is the
 * only way an ordinary app can capture the screen and inject input without an
 * AccessibilityService — and that is deliberately out of scope here (Play policy
 * rejects automation tools, and Android 17's advanced protection mode blocks the API
 * for non-accessibility purposes).
 *
 * **Everything except the capture is a shell command built here**, not another native
 * method. The Kotlin behind this module cannot be compiled on a development machine
 * without the Android toolchain, so each line of it is unverified until a device build
 * says otherwise; this file has tests. `screenshot` is the exception because the
 * downscale has to happen on the shell side — uid 2000 cannot write into the app's
 * private directory and the app cannot read `/data/local/tmp`, so the bytes have to
 * cross the binder.
 *
 * The Kotlin is copied into the generated project by `withMobileClawShizuku` at prebuild
 * time from `apps/mobile/android-native/shizuku/`; there is no Android source in the
 * build tree to point at.
 */
export interface NativeShizukuModule {
  /**
   * Everything the degradation matrix needs, in one call.
   *
   * Telling "not installed" apart from "installed but not running" is the Kotlin's job —
   * only it can see whether `moe.shizuku.privileged.api` is present, and the two need
   * different instructions for the user.
   */
  status(): Promise<AutomationStatus & { installed?: boolean }>;
  /** Opens Shizuku's own consent dialog; needs no Activity. */
  requestPermission(): Promise<boolean>;
  runPrivileged(
    command: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
  /** Downscales on the shell side and writes the picture where the app can render it. */
  screenshot(options: { maxWidth: number; quality: number; destDir?: string }): Promise<ScreenCapture>;
  /**
   * The app-internal directory screenshots are written to.
   *
   * Asked for rather than assumed: the path is a platform fact owned by the Kotlin, and a second
   * guess at it here would be a second thing to keep correct. Everything that lists, shows or
   * prunes screenshots starts by asking for this.
   *
   * Optional because a native module older than this JavaScript simply will not have it, and a
   * missing method must degrade to "no directory known" rather than failing the whole module —
   * a hard requirement here would take screen reading down with it over a folder name.
   */
  screenshotDir?(): Promise<string>;
  /**
   * Holds the display awake while a run is in progress.
   *
   * The screen is the thing being automated, so a display that sleeps ends the run for a reason
   * that has nothing to do with the task — and it does so silently, mid-step. Optional for the
   * same reason as `screenshotDir`: a native module older than this JavaScript should degrade to
   * "the display is not held", not fail to load.
   */
  keepScreenOn?(on: boolean): Promise<boolean>;
}

export function loadNativeShizuku(): NativeShizukuModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NativeModules } = require("react-native") as { NativeModules?: Record<string, unknown> };
    const module = NativeModules?.["MobileClawShizuku"] as NativeShizukuModule | undefined;
    if (!module) {
      console.log("[mobileclaw] native shizuku: MobileClawShizuku is not registered; screen automation is off");
      return undefined;
    }
    console.log("[mobileclaw] native shizuku: MobileClawShizuku registered");
    return module;
  } catch (error) {
    console.log(
      `[mobileclaw] native shizuku unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/* ------------------------------------------------------------- pure helpers --- */

/** KEYCODE_PASTE. The only way to get non-ASCII text into another app. */
export const KEYCODE_PASTE = 279;

/** Long enough that the system reads it as a scroll rather than a fling. */
const SWIPE_DURATION_MS = 300;

const INPUT_TIMEOUT_MS = 15_000;
const SIZE_TIMEOUT_MS = 5_000;
const DEFAULT_SHELL_TIMEOUT_MS = 60_000;

/**
 * Readings are dumped to a file and then read back, which puts a hard ceiling on the
 * dump in a place where it can be reported.
 *
 * A busy screen's hierarchy runs to a megabyte or two. Reading that into a JS string
 * through the binder is the one way this feature can take the whole app down, and the
 * projection in `@mobileclaw/capabilities` only ever returns a budgeted fraction of
 * it — so the size is checked before the content is, and an oversized dump is refused
 * with a reason rather than truncated into XML that no longer parses.
 */
const MAX_DUMP_BYTES = 4_000_000;

/** Reads the dump file's size in bytes; `wc -c` is present in both toybox and toolbox. */
async function dumpSizeBytes(native: NativeShizukuModule): Promise<number | undefined> {
  try {
    const { stdout, exitCode } = await sh(
      native,
      `wc -c < ${DUMP_FILE_PATH}`,
      SIZE_TIMEOUT_MS,
    );
    if (exitCode !== 0) return undefined;
    const size = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(size) ? size : undefined;
  } catch {
    // Not knowing the size is not a reason to refuse the reading; the caller runs it
    // through the same path and the budget still applies afterwards.
    return undefined;
  }
}

/**
 * Throw away the dump file.
 *
 * The file is world-readable while it exists and holds whatever was on screen a moment
 * ago. Best effort on purpose: a failed `rm` leaves a file in a scratch directory,
 * which is not worth turning a successful reading into a tool error over.
 */
async function discardDump(native: NativeShizukuModule): Promise<void> {
  try {
    await sh(native, DUMP_COMMANDS.clean, SIZE_TIMEOUT_MS);
  } catch {
    // Ignored; see above.
  }
}

/**
 * Read the current window through `uiautomator`, and project it to something a model
 * can actually consume.
 *
 * Three things here are not incidental:
 *
 *  - **The dump goes to a file, never through a pipe.** `uiautomator dump` writes
 *    `Dumped to: <path>` to stdout, not the XML, so a pipe would silently yield the
 *    path instead of the screen.
 *  - **Both command forms are tried.** `--compressed` is accepted on current builds
 *    and rejected on older ones, and which one a device has is not something this app
 *    can know in advance.
 *  - **Failure is reported as failure.** An empty reading and an unreadable screen are
 *    different findings, and conflating them is the exact mistake the storage tools
 *    had to be fixed for.
 */
async function readScreenViaDump(
  native: NativeShizukuModule,
  options: {
    maxTextLength?: number;
    maxNodes?: number;
    maxChars?: number;
    timeoutMs?: number;
  },
): Promise<ScreenSnapshot> {
  const timeoutMs = options.timeoutMs ?? SCREEN_DEFAULTS.readTimeoutMs;

  let lastError = "uiautomator produced no window hierarchy";
  for (const command of [DUMP_COMMANDS.dump, DUMP_COMMANDS.dumpPlain]) {
    const dumped = await native.runPrivileged(command, timeoutMs);
    const outcome = interpretDump(dumped);
    if (outcome.error !== undefined) {
      lastError = outcome.error;
      continue;
    }

    const size = await dumpSizeBytes(native);
    if (size !== undefined && size > MAX_DUMP_BYTES) {
      await discardDump(native);
      return {
        nodes: [],
        total: 0,
        note: `the window hierarchy is ${Math.round(size / 1024)} KiB, past the ${Math.round(
          MAX_DUMP_BYTES / 1024,
        )} KiB readable limit; scroll to a simpler screen or read a specific part of it`,
      };
    }

    const contents = await sh(native, DUMP_COMMANDS.read, timeoutMs);
    await discardDump(native);

    const read = interpretDump(contents);
    if (read.xml === undefined) {
      lastError = read.error ?? lastError;
      continue;
    }

    const dump = parseScreenDump(read.xml);
    // The real display size is measured, not inferred from the dump. The dump's own
    // idea of the screen comes from a window rectangle, and a dump that starts at a
    // dialog or a notification shade is smaller than the display — which would make
    // `screen_tap_element` compute a fraction that the tap then clamps to the screen
    // edge, pressing the border instead of the element. `wm size` is the same source
    // `screen_scroll` and `screen_tap` already resolve their geometry against, so this
    // also keeps one coordinate space for all of them.
    const measured = await displaySize(native).catch(() => undefined);
    const snapshot = projectScreen(dump, {
      ...(options.maxTextLength !== undefined ? { maxTextLength: options.maxTextLength } : {}),
      ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
      ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
      ...(measured ? { display: measured } : {}),
    });
    const window = await foregroundWindow(native);
    if (window.package) snapshot.package = window.package;
    else if (!snapshot.package) {
      snapshot.note = snapshot.note ?? "the dump named no app, and the foreground app could not be read";
    }
    return snapshot;
  }

  return {
    nodes: [],
    total: 0,
    note: `the screen could not be read: ${lastError}`,
  };
}

/**
 * `input text` carries printable ASCII and nothing else.
 *
 * Chinese, emoji and accented Latin have to go through the clipboard instead, which is
 * a user-visible side effect — it replaces whatever they had copied — so the caller
 * reports which route was taken rather than quietly overwriting the clipboard. A
 * newline is not injectable either, so it also lands on the paste path.
 */
export function isAsciiOnly(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(text);
}

/** Single-quote a value for `sh -c`, escaping embedded quotes the POSIX way. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `input text` splits its argument on spaces, so a space has to survive as `%s`.
 *
 * The escaping is not shell quoting — that is `shellQuote`'s job — this is the `input`
 * command's own convention, and the two are applied on top of each other.
 */
export function encodeInputText(text: string): string {
  return shellQuote(text.replace(/ /g, "%s"));
}

/**
 * Where the finger travels to move through the content.
 *
 * The finger moves **against** the content: to see what is further down the page you
 * swipe up. Getting that backwards is the classic scroll bug and it is invisible in
 * review, so the geometry is a pure function with its own tests instead of three
 * inlined lines.
 */
export function scrollPath(
  direction: "up" | "down" | "left" | "right",
  fraction: number,
  size: { width: number; height: number },
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const cx = Math.round(size.width / 2);
  const cy = Math.round(size.height / 2);
  const dx = Math.round((size.width * fraction) / 2);
  const dy = Math.round((size.height * fraction) / 2);

  switch (direction) {
    case "down":
      return { from: { x: cx, y: cy + dy }, to: { x: cx, y: cy - dy } };
    case "up":
      return { from: { x: cx, y: cy - dy }, to: { x: cx, y: cy + dy } };
    case "right":
      return { from: { x: cx + dx, y: cy }, to: { x: cx - dx, y: cy } };
    case "left":
      return { from: { x: cx - dx, y: cy }, to: { x: cx + dx, y: cy } };
  }
}

/**
 * The display size, from `wm size`.
 *
 * `Override size` is preferred when both are printed: it is what a compatibility scale
 * actually maps to, and it is the coordinate space `input` works in.
 */
export function parseScreenSize(output: string): { width: number; height: number } | undefined {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(output);
  if (override) return { width: Number(override[1]), height: Number(override[2]) };
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(output);
  return physical ? { width: Number(physical[1]), height: Number(physical[2]) } : undefined;
}

/**
 * The foreground app, from debug output.
 *
 * Best effort by nature: these key names have changed across Android versions and some
 * ROMs reformat them, so several shapes are tried and `raw` is kept. An empty result
 * means "could not tell", never "nothing is open" — which is why callers are told to
 * treat it that way rather than concluding the screen is blank.
 */
export function parseForeground(output: string): ForegroundWindow {
  const patterns = [
    /mCurrentFocus=Window\{[^}]*?\s([\w.]+)\/([\w.$]+)/,
    /mFocusedApp=.*?\s([\w.]+)\/([\w.$]+)/,
    /topResumedActivity.*?\s([\w.]+)\/([\w.$]+)/,
    /mResumedActivity.*?\s([\w.]+)\/([\w.$]+)/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match) {
      return { package: match[1], activity: match[2], raw: match[0] };
    }
  }
  return { raw: output.trim().split("\n").slice(0, 5).join("\n") };
}

/* ------------------------------------------------------------- the service --- */

export interface AutomationPorts {
  /** Writes the clipboard. Needed because `input text` cannot send Chinese. */
  setClipboard(text: string): Promise<void>;
}

async function sh(
  native: NativeShizukuModule,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  const result = await native.runPrivileged(command, timeoutMs);
  return { stdout: result.stdout, exitCode: result.exitCode, stderr: result.stderr };
}

async function shOrThrow(native: NativeShizukuModule, command: string, timeoutMs: number): Promise<string> {
  const { stdout, exitCode, stderr } = await sh(native, command, timeoutMs);
  if (exitCode !== 0) {
    throw new Error(`${command} exited ${exitCode}: ${stderr.trim() || "no stderr"}`);
  }
  return stdout;
}

/** The display size, or a failure that says which read produced nothing. */
async function displaySize(native: NativeShizukuModule): Promise<{ width: number; height: number }> {
  const size = parseScreenSize(await shOrThrow(native, "wm size", SIZE_TIMEOUT_MS));
  if (!size) throw new Error("could not read the display size from `wm size`");
  return size;
}

/**
 * The foreground app, best effort.
 *
 * Shared rather than inlined so the screen reader and `screen_current` cannot drift
 * apart in how they explain a miss: both report "could not tell", never "nothing is
 * open".
 */
async function foregroundWindow(native: NativeShizukuModule): Promise<ForegroundWindow> {
  const { stdout } = await sh(
    native,
    "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp|mResumedActivity|topResumedActivity' | head -n 5",
    SIZE_TIMEOUT_MS,
  );
  return parseForeground(stdout);
}

/** The last addressable pixel is `extent - 1`; a fraction of 1 would land past the edge. */
function clampPixel(value: number, extent: number): number {
  return Math.min(Math.max(Math.round(value), 0), Math.max(extent - 1, 0));
}

/** Screen automation over the native module. */
export function createAutomationService(
  native: NativeShizukuModule,
  ports: AutomationPorts,
): AutomationService {
  return {
    kind: "shizuku",
    status: () => native.status(),
    captureScreen: (options = {}) =>
      native.screenshot({
        maxWidth: options.maxWidth ?? SCREEN_DEFAULTS.maxWidth,
        quality: options.quality ?? SCREEN_DEFAULTS.quality,
        ...(options.destDir ? { destDir: options.destDir } : {}),
      }),

    async tap(fx, fy) {
      // The coordinate arrives as a fraction because nobody upstream knows the display
      // size: the person is looking at a downscaled picture and the model has never seen
      // the screen. Resolving it here keeps the geometry in one place, as `scroll` does.
      const size = await displaySize(native);
      const x = clampPixel(fx * size.width, size.width);
      const y = clampPixel(fy * size.height, size.height);
      await shOrThrow(native, `input tap ${x} ${y}`, INPUT_TIMEOUT_MS);
    },

    async scroll(direction, fraction = SCREEN_DEFAULTS.scrollFraction) {
      const size = await displaySize(native);
      const { from, to } = scrollPath(direction, fraction, size);
      await shOrThrow(
        native,
        `input swipe ${from.x} ${from.y} ${to.x} ${to.y} ${SWIPE_DURATION_MS}`,
        INPUT_TIMEOUT_MS,
      );
    },

    async typeText(text) {
      if (isAsciiOnly(text)) {
        await shOrThrow(native, `input text ${encodeInputText(text)}`, INPUT_TIMEOUT_MS);
        return { method: "input" };
      }
      // The clipboard is a shared resource: the user loses whatever they had copied,
      // which is why the method is reported rather than swallowed.
      await ports.setClipboard(text);
      await shOrThrow(native, `input keyevent ${KEYCODE_PASTE}`, INPUT_TIMEOUT_MS);
      return { method: "paste" };
    },

    async currentWindow() {
      return foregroundWindow(native);
    },

    readScreen: (options = {}) =>
      readScreenViaDump(native, {
        ...(options.maxTextLength !== undefined ? { maxTextLength: options.maxTextLength } : {}),
        ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
        ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      }),
  };
}

/**
 * Privileged command execution over the native module.
 *
 * `isAvailable()` is a `status()` call rather than a dedicated native method, so the
 * "not installed / not running / not permitted" distinction is computed in one place
 * and cannot drift between the shell backend and the screen tools.
 */
export function createPrivilegedService(native: NativeShizukuModule): PrivilegedService {
  return {
    kind: "shizuku",
    async isAvailable() {
      return (await native.status()).available;
    },
    requestPermission: () => native.requestPermission(),
    async run(command: string, options: ShellRunOptions = {}): Promise<ShellResult> {
      const started = Date.now();
      const result = await native.runPrivileged(command, options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS);
      return {
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      };
    },
  };
}
