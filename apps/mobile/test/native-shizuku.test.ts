import { describe, expect, it } from "vitest";
import { SCREEN_DEFAULTS } from "@mobileclaw/core";
import {
  createAutomationService,
  createPrivilegedService,
  encodeInputText,
  isAsciiOnly,
  loadNativeShizuku,
  parseForeground,
  parseScreenSize,
  scrollPath,
  shellQuote,
  type AutomationPorts,
  type NativeShizukuModule,
} from "@/runtime/services/native-shizuku";

/**
 * The JS half of `MobileClawShizuku`, exercised against a fake native module.
 *
 * The native module now exposes only four methods (`status`, `requestPermission`,
 * `runPrivileged`, `screenshot`); `tap`, `scroll`, `typeText` and `currentWindow` are
 * composed on this side as `input \u2026` command lines. That makes this file the only place
 * the feature can be proven without a device, so the assertions are about the exact
 * commands sent and the pure geometry, not smoke tests.
 *
 * These are also the seams where `SCREEN_DEFAULTS` is meant to be the only place a
 * fallback is decided: the adapter fills a missing `maxWidth`/`quality`/scroll fraction
 * from the shared constant rather than from a number repeated here.
 */

/** The Chinese word for "hello", written as escapes so this file stays ASCII. */
const NON_ASCII_TEXT = "\u4f60\u597d";

interface NativeCalls {
  screenshots: Array<{ maxWidth: number; quality: number; destDir?: string }>;
  runs: Array<{ command: string; timeoutMs: number }>;
}

interface Harness {
  native: NativeShizukuModule;
  ports: AutomationPorts;
  calls: NativeCalls;
  /** What `ports.setClipboard` received, in order. */
  clipboard: string[];
  /** Native runs and clipboard writes interleaved, for the paste-ordering assertion. */
  events: string[];
}

/** An in-memory stand-in for the Kotlin module, recording what it was asked to do. */
function harness(over: Partial<NativeShizukuModule> = {}): Harness {
  const calls: NativeCalls = { screenshots: [], runs: [] };
  const clipboard: string[] = [];
  const events: string[] = [];
  const native: NativeShizukuModule = {
    async status() {
      return { available: true, backend: "shizuku", uid: 2000 };
    },
    async requestPermission() {
      return true;
    },
    async runPrivileged(command, timeoutMs) {
      calls.runs.push({ command, timeoutMs });
      events.push(`run:${command}`);
      // `wm size` and the window dump are the two commands whose output the adapter
      // parses; a canonical response keeps the tests about geometry and matching.
      const stdout = command === "wm size"
        ? "Physical size: 1080x2400"
        : command.startsWith("dumpsys window")
          ? "mCurrentFocus=Window{1b2 u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}"
          : "";
      return { exitCode: 0, stdout, stderr: "" };
    },
    async screenshot(options) {
      calls.screenshots.push(options);
      return {
        path: "file:///w/shot.jpg",
        width: options.maxWidth,
        height: 1600,
      };
    },
    ...over,
  };
  const ports: AutomationPorts = {
    async setClipboard(text) {
      clipboard.push(text);
      events.push(`clip:${text}`);
    },
  };
  return { native, ports, calls, clipboard, events };
}

/* ------------------------------------------------------------- pure helpers --- */

describe("scrollPath", () => {
  const SIZE = { width: 1080, height: 2400 };

  it("sends the finger against the content: scrolling down swipes up", () => {
    // The counterintuitive core of the feature. To reveal what is below the fold the
    // finger travels up, and the page follows it: from.y must be greater than to.y.
    const { from, to } = scrollPath("down", 0.6, SIZE);
    expect(from).toEqual({ x: 540, y: 1920 });
    expect(to).toEqual({ x: 540, y: 480 });
    expect(from.y).toBeGreaterThan(to.y);
  });

  it("scrolls up by swiping down", () => {
    const { from, to } = scrollPath("up", 0.6, SIZE);
    expect(from).toEqual({ x: 540, y: 480 });
    expect(to).toEqual({ x: 540, y: 1920 });
    expect(from.y).toBeLessThan(to.y);
  });

  it("scrolls right by swiping left, and left by swiping right", () => {
    const right = scrollPath("right", 0.6, SIZE);
    expect(right.from).toEqual({ x: 864, y: 1200 });
    expect(right.to).toEqual({ x: 216, y: 1200 });
    expect(right.from.x).toBeGreaterThan(right.to.x);

    const left = scrollPath("left", 0.6, SIZE);
    expect(left.from).toEqual({ x: 216, y: 1200 });
    expect(left.to).toEqual({ x: 864, y: 1200 });
    expect(left.from.x).toBeLessThan(left.to.x);
  });

  it("stays put at fraction 0 and spans the axis at fraction 1", () => {
    const none = scrollPath("down", 0, SIZE);
    expect(none.from).toEqual(none.to);
    expect(none.from.y).toBe(1200);

    const full = scrollPath("down", 1, SIZE);
    expect(full.from.y).toBe(2400);
    expect(full.to.y).toBe(0);
  });

  it("rounds every coordinate to a whole pixel, which is what `input` demands", () => {
    // An odd display is the interesting case: the centre and the half-travel are both
    // fractional and must not reach the shell as floats.
    const size = { width: 999, height: 1777 };
    const { from, to } = scrollPath("down", 0.5, size);
    expect(from).toEqual({ x: 500, y: 1333 });
    expect(to).toEqual({ x: 500, y: 445 });

    for (const fraction of [0.01, 0.3, 0.87, 1]) {
      for (const direction of ["up", "down", "left", "right"] as const) {
        const path = scrollPath(direction, fraction, size);
        for (const n of [path.from.x, path.from.y, path.to.x, path.to.y]) {
          expect(Number.isInteger(n)).toBe(true);
        }
      }
    }
  });
});

describe("parseScreenSize", () => {
  it("prefers Override size over Physical size when both are printed", () => {
    // `Override size` is the coordinate space `input` actually works in after a
    // compatibility scale; taking `Physical size` would put every tap in the wrong spot.
    const output = ["Physical size: 1080x2400", "Override size: 720x1600"].join("\n");
    expect(parseScreenSize(output)).toEqual({ width: 720, height: 1600 });
  });

  it("is not fooled by the order the lines are printed in", () => {
    const output = ["Override size: 720x1600", "Physical size: 1080x2400"].join("\n");
    expect(parseScreenSize(output)).toEqual({ width: 720, height: 1600 });
  });

  it("falls back to Physical size when there is no override", () => {
    expect(parseScreenSize("Physical size: 1080x2400")).toEqual({ width: 1080, height: 2400 });
  });

  it("returns undefined when neither line is present", () => {
    expect(parseScreenSize("garbage output")).toBeUndefined();
    expect(parseScreenSize("")).toBeUndefined();
  });
});

describe("parseForeground", () => {
  it("reads mCurrentFocus", () => {
    const output = "  mCurrentFocus=Window{1b2c3d4 u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}";
    expect(parseForeground(output)).toMatchObject({
      package: "com.tencent.mm",
      activity: "com.tencent.mm.ui.LauncherUI",
    });
  });

  it("reads mFocusedApp", () => {
    const output =
      "mFocusedApp=ActivityRecord{5f6 u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity t42}";
    expect(parseForeground(output)).toMatchObject({
      package: "com.android.chrome",
      activity: "org.chromium.chrome.browser.ChromeTabbedActivity",
    });
  });

  it("reads topResumedActivity", () => {
    const output = "topResumedActivity=ActivityRecord{a1b u0 com.example.app/.MainActivity t7}";
    expect(parseForeground(output)).toMatchObject({
      package: "com.example.app",
      activity: ".MainActivity",
    });
  });

  it("reads mResumedActivity", () => {
    const output =
      "mResumedActivity: ActivityRecord{c9d u0 com.example.notes/com.example.notes.NoteActivity t3}";
    expect(parseForeground(output)).toMatchObject({
      package: "com.example.notes",
      activity: "com.example.notes.NoteActivity",
    });
  });

  it("keeps raw and reports no package when nothing matches", () => {
    // The contract is "could not tell", never "nothing is open": `raw` is what makes a
    // miss diagnosable instead of looking like a blank screen.
    const result = parseForeground("WINDOW MANAGER (dumpsys window)\n  no focus here");
    expect(result.package).toBeUndefined();
    expect(result.activity).toBeUndefined();
    expect(result.raw.length).toBeGreaterThan(0);
    expect(result.raw).toContain("no focus here");
  });
});

describe("isAsciiOnly", () => {
  it("accepts printable ASCII, including spaces", () => {
    expect(isAsciiOnly("hello world")).toBe(true);
    expect(isAsciiOnly("aA1!?~@#")).toBe(true);
    expect(isAsciiOnly("")).toBe(true);
  });

  it("rejects anything `input text` cannot carry", () => {
    expect(isAsciiOnly(NON_ASCII_TEXT)).toBe(false); // Chinese
    expect(isAsciiOnly("cafe\u0301")).toBe(false); // accented Latin (combining acute)
    expect(isAsciiOnly("snowman \u2603")).toBe(false);
    expect(isAsciiOnly("smile \u{1f642}")).toBe(false); // emoji
    expect(isAsciiOnly("line one\nline two")).toBe(false); // newline
    expect(isAsciiOnly("tab\there")).toBe(false); // tab
  });
});

describe("shell quoting and input encoding", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
  });

  it("escapes an embedded quote the POSIX way", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("encodes a space as %s and still shell-quotes for sh -c", () => {
    // `input text` splits its argument on spaces, so the space has to survive as `%s`,
    // and the result still has to be one shell word.
    expect(encodeInputText("hello world")).toBe("'hello%sworld'");
  });

  it("handles the interesting case: a quote and a space together", () => {
    // What actually reaches `input` is `it's%sa%stest`, handed to `sh -c` as a single
    // argument. This is the exact command line the service composes.
    expect(encodeInputText("it's a test")).toBe("'it'\\''s%sa%stest'");
  });
});

/* ------------------------------------------------------------- the service --- */

describe("createAutomationService", () => {
  it("resolves a fraction against the display, then composes an `input tap` line", async () => {
    const h = harness();
    const automation = createAutomationService(h.native, h.ports);
    await automation.tap(0.5, 0.5);
    await automation.tap(0, 0);

    // The coordinate arrives as a fraction — nobody upstream knows the display size,
    // since the person is reading a downscaled picture and the model has never seen the
    // screen — so the display has to be read first and the ratio resolved against it.
    expect(h.calls.runs.map((r) => r.command)).toEqual([
      "wm size",
      "input tap 540 1200",
      "wm size",
      "input tap 0 0",
    ]);
  });

  it("keeps a fraction of 1 on the last addressable pixel", async () => {
    // Rounding 1 against the extent lands one pixel past the edge, where the system
    // silently drops the tap — so the far corner would simply never work.
    const h = harness();

    await createAutomationService(h.native, h.ports).tap(1, 1);

    expect(h.calls.runs.map((r) => r.command)).toEqual(["wm size", "input tap 1079 2399"]);
  });

  it("derives the swipe from `wm size` and the shared scroll fraction", async () => {
    const h = harness();
    await createAutomationService(h.native, h.ports).scroll("down");

    // It must read the geometry from the device first, then compose the swipe. The
    // travel is expressed against the imported constant, not a 0.6 repeated here, and
    // "down" really means the finger moves up.
    const { from, to } = scrollPath("down", SCREEN_DEFAULTS.scrollFraction, {
      width: 1080,
      height: 2400,
    });
    expect(h.calls.runs.map((r) => r.command)).toEqual([
      "wm size",
      `input swipe ${from.x} ${from.y} ${to.x} ${to.y} 300`,
    ]);
    expect(from.y).toBeGreaterThan(to.y);
  });

  it("honours a caller's scroll fraction over the shared default", async () => {
    const h = harness();
    await createAutomationService(h.native, h.ports).scroll("down", 0.3);

    expect(h.calls.runs.map((r) => r.command)).toEqual([
      "wm size",
      "input swipe 540 1560 540 840 300",
    ]);
  });

  it("fails with a message naming what could not be read when `wm size` is unusable", async () => {
    const h = harness({
      async runPrivileged() {
        return { exitCode: 0, stdout: "no size info here", stderr: "" };
      },
    });
    await expect(createAutomationService(h.native, h.ports).scroll("down")).rejects.toThrow(
      /could not read the display size/i,
    );
  });

  it("types ASCII with `input text`, encoding spaces and never touching the clipboard", async () => {
    const h = harness();
    const result = await createAutomationService(h.native, h.ports).typeText("hello world");

    expect(h.calls.runs.map((r) => r.command)).toEqual(["input text 'hello%sworld'"]);
    expect(result).toEqual({ method: "input" });
    expect(h.clipboard).toEqual([]);
  });

  it("pastes non-ASCII: it writes the clipboard before sending the paste key", async () => {
    const h = harness();
    const result = await createAutomationService(h.native, h.ports).typeText(NON_ASCII_TEXT);

    // The order is the whole point: pasting first would paste the user's previous
    // clipboard content.
    expect(h.clipboard).toEqual([NON_ASCII_TEXT]);
    expect(h.events).toEqual([`clip:${NON_ASCII_TEXT}`, "run:input keyevent 279"]);
    expect(result).toEqual({ method: "paste" });
  });

  it("surfaces a failing command with its exit code and stderr", async () => {
    const h = harness({
      async runPrivileged() {
        return { exitCode: 1, stdout: "", stderr: "permission denied" };
      },
    });
    await expect(createAutomationService(h.native, h.ports).tap(0.5, 0.5)).rejects.toThrow(
      /exited 1: permission denied/,
    );
  });

  it("queries the window dump and parses the foreground app", async () => {
    const h = harness();
    const foreground = await createAutomationService(h.native, h.ports).currentWindow();

    expect(h.calls.runs[0]!.command).toContain("dumpsys window");
    expect(foreground.package).toBe("com.tencent.mm");
    expect(foreground.activity).toBe("com.tencent.mm.ui.LauncherUI");
  });

  it("fills a bare capture from SCREEN_DEFAULTS and forwards no destination", async () => {
    const h = harness();
    await createAutomationService(h.native, h.ports).captureScreen({});

    expect(h.calls.screenshots).toEqual([
      { maxWidth: SCREEN_DEFAULTS.maxWidth, quality: SCREEN_DEFAULTS.quality },
    ]);
  });

  it("keeps a caller's maxWidth but still applies the default quality", async () => {
    const h = harness();
    await createAutomationService(h.native, h.ports).captureScreen({ maxWidth: 1024 });

    expect(h.calls.screenshots).toEqual([{ maxWidth: 1024, quality: SCREEN_DEFAULTS.quality }]);
  });

  it("forwards destDir only when the caller supplied one", async () => {
    const h = harness();
    const automation = createAutomationService(h.native, h.ports);
    await automation.captureScreen({});
    await automation.captureScreen({ destDir: "/data/ws/conv_1" });

    expect(h.calls.screenshots[0]).not.toHaveProperty("destDir");
    expect(h.calls.screenshots[1]).toEqual({
      maxWidth: SCREEN_DEFAULTS.maxWidth,
      quality: SCREEN_DEFAULTS.quality,
      destDir: "/data/ws/conv_1",
    });
  });

  it("reports whether the backend can act right now", async () => {
    const healthy = harness();
    expect((await createAutomationService(healthy.native, healthy.ports).status()).available).toBe(true);

    const off = harness({
      async status() {
        return { available: false, reason: "Shizuku is not running" };
      },
    });
    const status = await createAutomationService(off.native, off.ports).status();
    expect(status.available).toBe(false);
    expect(status.reason).toBe("Shizuku is not running");
  });
});

describe("loadNativeShizuku", () => {
  it("returns undefined instead of throwing when the module is not registered", () => {
    // The test environment has no MobileClawShizuku, which is also the stale-build case:
    // the capability must go dark and the tools explain what is missing, never crash.
    expect(() => loadNativeShizuku()).not.toThrow();
    expect(loadNativeShizuku()).toBeUndefined();
  });
});

describe("createPrivilegedService", () => {
  it("derives availability from the one status call", async () => {
    expect(await createPrivilegedService(harness().native).isAvailable()).toBe(true);

    const off = harness({
      async status() {
        return { available: false, reason: "not installed" };
      },
    });
    expect(await createPrivilegedService(off.native).isAvailable()).toBe(false);
  });

  it("passes the requested timeout through to the native runner", async () => {
    const h = harness();
    await createPrivilegedService(h.native).run("id", { timeoutMs: 5000 });

    expect(h.calls.runs).toEqual([{ command: "id", timeoutMs: 5000 }]);
  });

  it("uses a positive default timeout when the caller gives none", async () => {
    const h = harness();
    await createPrivilegedService(h.native).run("id");

    expect(h.calls.runs).toHaveLength(1);
    expect(h.calls.runs[0]!.timeoutMs).toBeGreaterThan(0);
  });

  it("shapes the native result into a ShellResult with a measured duration", async () => {
    const h = harness();
    h.native.runPrivileged = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { exitCode: 0, stdout: "uid=2000(shell)", stderr: "" };
    };

    const result = await createPrivilegedService(h.native).run("id");

    expect(result.command).toBe("id");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("uid=2000");
    // Measured from the clock, not a placeholder: it must move with the actual call.
    expect(result.durationMs).toBeGreaterThanOrEqual(1);
  });

  it("forwards the permission request to the native module", async () => {
    expect(await createPrivilegedService(harness().native).requestPermission?.()).toBe(true);
  });
});
