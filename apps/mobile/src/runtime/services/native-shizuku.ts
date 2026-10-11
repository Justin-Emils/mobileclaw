import { SCREEN_DEFAULTS } from "@mobileclaw/core";
import {
  DUMP_COMMANDS,
  DUMP_FILE_PATH,
  formatScreenReading,
  interpretDump,
  looksLikeHierarchy,
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
  /**
   * Runs a command as shell (uid 2000).
   *
   * `stdin` carries a value that must not appear on the command line. It is a parameter rather than
   * part of `command` for the same reason the AIDL method takes it: a URL or a package id supplied
   * by the model and interpolated into `sh -c command` is an injection — a quote or a `;` turns
   * "open this link" into "run this other thing".
   *
   * **`stdin` is required, and must be `""` when there is none.** Marking it optional here was a
   * mistake and it broke every command on a device:
   *
   *   TurboModule method "runPrivileged" called with 2 arguments (expected argument count: 3)
   *
   * The bridge checks the *argument count*, not the TypeScript signature. A `?` is a compile-time
   * convenience that compiles a two-argument call perfectly happily and then fails at runtime, so
   * `screen_current`, `screen_read` and every other shell command died the moment a third parameter
   * appeared. Declaring it required makes the compiler point at every call site instead.
   *
   * **Positional, like `screenshot`.** The bridge binds arguments by position; an options object here
   * would be read as `command` and then fail on the argument count, which is exactly what happened to
   * `screenshot` and cost a device round trip to find.
   */
  runPrivileged(
    command: string,
    timeoutMs: number,
    stdin: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
  /**
   * Downscales on the shell side and writes the picture where the app can render it.
   *
   * **Positional arguments, matching the Kotlin exactly.** The bridge does not pass objects: it
   * binds each argument by position, and the native method is
   * `screenshot(maxWidth: Double, quality: Double, destDir: String?, promise: Promise)`. An earlier
   * version of this declaration — and of the call below it — passed a single options object, which
   * the bridge read as `maxWidth` and then rejected:
   *
   *   TurboModule method "screenshot" called with 1 arguments (expected argument count: 3)
   *
   * Because the *type* was wrong in the same way as the call, `tsc` could not catch it, and the
   * tests mocked the same wrong shape. It only surfaced on a device.
   */
  screenshot(maxWidth: number, quality: number, destDir: string | undefined): Promise<ScreenCapture>;
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
  /**
   * Start the foreground service that keeps this process from being frozen.
   *
   * **Must be called while the app is visible.** Android 12+ refuses to start a foreground service
   * from the background, so calling it when a run begins — by which time the agent has switched to
   * another app — throws instead of starting. See `runtime/run-service.ts` for how that is arranged,
   * and `MobileClawForegroundService.kt` for why the service stays up rather than being scoped to a
   * run.
   *
   * `text` is the notification body; it comes from `ui/strings.ts` so the wording lives with the
   * rest of the interface. Optional like the others: a native module older than this JavaScript
   * degrades to "no foreground service", which must not take screen automation down with it.
   */
  startRunService?(text: string): Promise<boolean>;
  /** Stop it and drop the notification. Safe when it was never started. */
  stopRunService?(): Promise<boolean>;
  /**
   * Re-post the ongoing notice.
   *
   * Called after the user grants the notification permission: `startForeground` runs only when the
   * service starts, so a permission granted later would otherwise leave a running foreground
   * service with nothing visible — which is what the user sees as "I cannot tell if it is running".
   */
  refreshRunServiceNotice?(text: string): Promise<boolean>;
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
 * How long to wait before re-reading a dump whose first read came back empty.
 *
 * `uiautomator dump` writes its file from another process and can exit before that write is
 * visible to a following `cat`. Long enough for a flushed write to appear, short enough not to
 * matter when the first read was fine.
 */
const DUMP_FLUSH_WAIT_MS = 150;

/** A cancellable-free sleep; the dump retry has no signal to honour. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


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
    const dumped = await native.runPrivileged(command, timeoutMs, "");
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

    // Read it back, with one retry.
    //
    // `uiautomator dump` writes the hierarchy to a file and can exit before the write is visible
    // to a following `cat`, so an immediate read can come back empty. One short wait and a second
    // read costs 150 ms and removes that. The file is removed only after both attempts.
    const firstRead = await sh(native, DUMP_COMMANDS.read, timeoutMs);
    let xmlText = firstRead.stdout;
    if (!looksLikeHierarchy(xmlText)) {
      await sleep(DUMP_FLUSH_WAIT_MS);
      xmlText = (await sh(native, DUMP_COMMANDS.read, timeoutMs)).stdout;
    }
    await discardDump(native);

    // The command already told us it wrote the hierarchy, so the file's *contents* are what matter
    // now — not whether they satisfy the marker search that judges a command's own output. A file
    // that is genuinely empty is still a failure, and is reported as one.
    if (!looksLikeHierarchy(xmlText)) {
      lastError = xmlText.trim() === "" ? "the dump file was empty" : `the dump file held no hierarchy: ${xmlText.slice(0, 200)}`;
      continue;
    }

    const dump = parseScreenDump(xmlText);
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
  const result = await native.runPrivileged(command, timeoutMs, "");
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
 * The fields that name the foreground window, best-effort, across Android versions.
 *
 * There is no stable API for this. `dumpsys window` and `dumpsys activity activities` use
 * different field names on different releases, and an OEM build can rename or drop them, so the
 * parser accepts any of them and reports which line it used.
 *
 * **The order is the argument's, and it is deliberate: focus first, resumed-activity second.**
 * `mCurrentFocus` / `mFocusedApp` name the window that holds input focus, which is the app the user
 * is looking at, and they are singular by construction. The `*ResumedActivity` fields come from the
 * activity dump, which writes one record **per task stack** — so they can name the launcher or our
 * own app while a target app is genuinely in front, and the number of records changes between calls.
 * Since the parser stops at the first field that names anything, putting a multi-valued field first
 * means a wrong answer can end the search before the right one is ever read.
 *
 * `screen_wait` is built on this, which is why a field-name change turns into a timeout rather
 * than an error: no package is parsed, so nothing ever matches.
 */
const FOREGROUND_FIELDS = [
  "mCurrentFocus",
  "mFocusedApp",
  "mFocusedWindow",
  "mLastFocusedWindow",
  "topResumedActivity",
  "mResumedActivity",
  "ResumedActivity",
];

/** A package/activity token: it must contain a dot and a slash to be one. */
const COMPONENT_TOKEN = /([A-Za-z_][\w.]*\.[\w.]+)\/([\w.$]+)/;

/**
 * The best component named by one field, across every line that mentions it.
 *
 * Two things this gets right that "the first line containing the field" did not, and both were
 * observed on a real Android 14 device:
 *
 * 1. **An unset display is not an answer.** A phone with a virtual or secondary display writes the
 *    field once per display, and every one but the primary reads `mCurrentFocus=null`. Taking the
 *    first match therefore reported *no app at all* on a device where the very next line named the
 *    app — the worst failure mode here, because `screen_wait` turns it into a timeout and a timeout
 *    reads as "the app never opened". Note what does the work: a `null` line carries no
 *    package/activity token at all, so it fails the token match and never becomes `best`. The
 *    explicit `null` test below is a cheap short-circuit, not the guard — verified by mutation,
 *    since removing it changes no outcome.
 *
 * 2. **The last candidate wins.** How many lines appear depends on how many tasks or displays exist
 *    at that moment — measured as 1 for one `dumpsys` and 2 for another seconds apart — so there is
 *    no fixed "first" or "second" to reach for. Ordering is observable though: the records come out
 *    in ascending task-stack id, and the primary display is written last. Both put the activity the
 *    user is actually looking at at the end.
 *
 * Returns the chosen line so `raw` can show it, or `undefined` when nothing matched.
 */
function bestComponentIn(output: string, field: string): { package: string; activity: string; line: string } | undefined {
  let best: { package: string; activity: string; line: string } | undefined;
  for (const candidate of output.split("\n")) {
    if (!candidate.includes(field)) continue;
    // Short-circuit for the common multi-display shape; see the note above — correctness rests on
    // the token match, not on this line.
    if (/=\s*null\b/.test(candidate)) continue;
    const tokens = [...candidate.matchAll(new RegExp(COMPONENT_TOKEN, "g"))];
    if (tokens.length === 0) continue;
    // The *last* token on the line is the value; the surrounding debug text contains other
    // component names (e.g. `mPreferredTopFocusableStack=Task{... I=com.x/.Y}`).
    const token = tokens[tokens.length - 1]!;
    best = { package: token[1]!, activity: token[2]!, line: candidate.trim() };
  }
  return best;
}

/**
 * Read the foreground component out of `dumpsys` output.
 *
 * Field names are tried in the order given, and the **first field that names anything at all**
 * wins — not the first field that is merely present. That distinction matters because a field can
 * be present on every display and still name nothing, and stopping there would report a miss while
 * a later field had the answer.
 *
 * A miss returns `raw` only -- the contract is "could not tell", never "nothing is open".
 */
export function parseForeground(output: string): ForegroundWindow {
  for (const field of FOREGROUND_FIELDS) {
    const found = bestComponentIn(output, field);
    if (found) {
      return {
        package: found.package,
        // A shorthand such as `.MainActivity` is relative to the package, which is how Android
        // itself writes it. Callers compare the result against a bare activity name, so keep it
        // as written rather than expanding it.
        activity: found.activity,
        raw: found.line,
      };
    }
  }
  return { raw: output.trim().split("\n").slice(0, 5).join("\n") };
}

/** Whether a parse produced something `screen_wait` can actually match against. */
export function hasForeground(result: ForegroundWindow): boolean {
  return typeof result.package === "string" && result.package.length > 0;
}

/**
 * Where the foreground app is looked for, most authoritative first.
 *
 * **`dumpsys window` comes first because `mCurrentFocus` is the better question.** It names the
 * window that holds input focus, which is what "the app the user is looking at" means, and it is
 * singular by construction: on a phone with a virtual or secondary display only one line carries a
 * real value and the others read `null`.
 *
 * `dumpsys activity activities` was first until this was measured on a device, and that ordering was
 * a defect rather than a preference: `foregroundWindow` returns the **first source that names
 * anything**, so a wrong-but-parseable answer from the activity dump ended the search. The activity
 * dump writes `topResumedActivity` once per task stack, and the count changes between calls seconds
 * apart (measured 1, then 2, on the same device), so it can name the launcher or our own app while a
 * target app is genuinely in front. It is still worth asking as a fallback — on releases where
 * `dumpsys window` names nothing, it is the only thing that answers.
 *
 * `grep -m 6` rather than `-m 3`: the cap exists to bound the output, not to be the answer, and
 * three was low enough that the primary display could be cut off on a device with extra displays.
 * Six leaves room for those and still never approaches the output-size limit.
 *
 * `grep -m` rather than `head`: `head` closes the pipe early, and `dumpsys` then reports
 * "Failed to write while dumping service window: Broken pipe", which is noise in an error path
 * that is already hard to read.
 */
const FOREGROUND_COMMANDS = [
  "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp|mFocusedWindow|mLastFocusedWindow' | grep -m 6 /",
  "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity|ResumedActivity' | grep -m 6 /",
];

/**
 * The foreground app, best effort.
 *
 * Shared rather than inlined so the screen reader and `screen_current` cannot drift
 * apart in how they explain a miss: both report "could not tell", never "nothing is
 * open".
 *
 * `raw` is accumulated across every attempt, not just the last. When detection fails this is the
 * only thing that explains why, and a report of one empty command would be useless on a device
 * whose `dumpsys` names the field something nobody here anticipated.
 */
async function foregroundWindow(native: NativeShizukuModule): Promise<ForegroundWindow> {
  const attempts: string[] = [];
  let last: ForegroundWindow = { raw: "" };

  for (const command of FOREGROUND_COMMANDS) {
    const { stdout, stderr } = await sh(native, command, SIZE_TIMEOUT_MS);
    const parsed = parseForeground(stdout);
    last = parsed;
    if (hasForeground(parsed)) {
      return attempts.length === 0
        ? parsed
        : { ...parsed, raw: `${parsed.raw}\n(通过第 ${attempts.length + 1} 个来源取得)` };
    }
    attempts.push(`$ ${command}\n(标准输出 ${stdout.trim().length} 字符)\n${stdout.trim() || "(空)"}`);
    if (stderr.trim()) attempts.push(`stderr: ${stderr.trim()}`);
  }

  return { raw: `无法判断前台应用。已尝试的命令及其原始输出：\n${attempts.join("\n")}`, ...(last.activity ? { activity: last.activity } : {}) };
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
      // Three positional arguments, in the order the Kotlin declares them. See the note on
      // `NativeShizukuModule.screenshot`: passing an object here is what produced
      // `expected argument count: 3` on a device.
      native.screenshot(
        options.maxWidth ?? SCREEN_DEFAULTS.maxWidth,
        options.quality ?? SCREEN_DEFAULTS.quality,
        options.destDir,
      ),

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
      // `options.stdin` is forwarded, not dropped.
      //
      // It was dropped at this layer while `NativeBridgeShell.run` already forwarded the whole
      // options object and explained why that mattered — so a value the caller had deliberately kept
      // off the command line arrived as nothing, and the command read EOF. That comment warns about
      // narrowing the type exactly here; this is where it happened.
      // `options.stdin ?? ""` rather than `options.stdin`: the native method always takes three
      // arguments and the bridge checks the count, so the slot must be filled. `undefined` would
      // occupy it and serialise as nothing; an explicit empty string says the same thing on purpose.
      const result = await native.runPrivileged(
        command,
        options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
        options.stdin ?? "",
      );
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
