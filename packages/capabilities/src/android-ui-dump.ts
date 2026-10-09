/**
 * The Android side of reading a screen: build the dump command, and say what the
 * result was.
 *
 * Only the *command* lives here — the parsing and the projection are in `./ui-dump`,
 * which has no platform dependency and is where the logic worth testing sits. What is
 * left is the part that differs per device, and every piece of it below was learned
 * from a specific failure:
 *
 *  - **`uiautomator dump` blocks until the window is idle.** On an animating screen it
 *    never becomes idle, so the command hangs instead of failing. The timeout passed
 *    to the privileged runner is the only thing that keeps that from parking the agent
 *    loop forever, which is why `readTimeoutMs` exists rather than a bare call.
 *  - **The old default path `/data/local/tmp` is not readable by this app.** Shell can
 *    write there; the app cannot read it. `sdcard` is the one location both sides can
 *    reach, and the bytes never have to cross the binder (unlike a capture).
 *  - **Failure does not always look like failure.** Some builds print
 *    `ERROR: could not get idle state.` and still exit 0; others print
 *    `ERROR: null root node returned by UiTestAutomationBridge.` when the window is
 *    being replaced. Both must be read as "the screen could not be read" and must reach
 *    the model as that, rather than as an empty screen.
 *
 * No Chinese appears here: everything in `packages/*` is English, and the wording a
 * person sees is added in the app layer.
 */

/** Where the dump lands. Reachable by shell (writer) and by the app (reader). */
export const DUMP_FILE_PATH = "/sdcard/mobileclaw-window-dump.xml";

/** Shell commands are constructed here and nowhere else. */
export const DUMP_COMMANDS = {
  /**
   * `--compressed` keeps layout noise out of the file, which matters because the
   * whole file is then read into JS. Older builds do not accept the flag, so the
   * plain form is kept as a fallback rather than assumed.
   */
  dump: `uiautomator dump --compressed ${DUMP_FILE_PATH}`,
  dumpPlain: `uiautomator dump ${DUMP_FILE_PATH}`,
  /** Read back the dump. `cat` is present in every Android shell (toybox or toolbox). */
  read: `cat ${DUMP_FILE_PATH}`,
  /**
   * Remove it afterwards. The file is world-readable while it exists, and it holds
   * whatever was on screen a moment ago — a chat message, a search box, a one-time
   * code. Leaving it behind would make the reading outlive the user's approval of it.
   */
  clean: `rm -f ${DUMP_FILE_PATH}`,
} as const;

/**
 * Messages that mean the dump failed even though the command may have exited 0.
 *
 * Matched case-insensitively as substrings: the exact wording has changed between
 * Android releases and some ROMs add their own prefix.
 */
const DUMP_ERROR_MARKERS = [
  "could not get idle state",
  "null root node returned by uitestautomationbridge",
  "error: ",
  "no such file or directory",
  "permission denied",
  "not found",
] as const;

export interface DumpOutcome {
  /** The XML, present only when the command both ran and produced a usable dump. */
  xml?: string;
  /** What went wrong, phrased for the model rather than for a log. */
  error?: string;
}

/**
 * Decide what a finished dump command meant.
 *
 * Kept separate from running it so the decision is testable without a device: this is
 * the boundary where "the screen is empty" and "the screen could not be read" get
 * told apart, and getting it wrong is the failure the storage tools already had to be
 * fixed for — reporting a permission problem as a finding about the user's data.
 */
export function interpretDump(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): DumpOutcome {
  if (result.timedOut === true) {
    return {
      error:
        "uiautomator timed out: it waits for the window to stop changing, and an animating screen never does",
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const marker = DUMP_ERROR_MARKERS.find((candidate) => combined.includes(candidate));
  // The XML is checked before the marker list, so a node whose *text* happens to
  // contain the word "error" is not mistaken for a failed dump.
  if (!combined.includes("<hierarchy") && !combined.includes("<node")) {
    if (marker !== undefined) return { error: `uiautomator reported a failure (${marker.trim()})` };
    if (result.exitCode !== 0) {
      return {
        error: `uiautomator exited ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`,
      };
    }
    return { error: "uiautomator produced no window hierarchy" };
  }

  if (result.stdout.trim() === "") return { error: "the dump file was empty" };
  return { xml: result.stdout };
}
