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
  runs: Array<{ command: string; timeoutMs: number; stdin?: string }>;
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
    async runPrivileged(command, timeoutMs, stdin) {
      calls.runs.push(stdin === undefined ? { command, timeoutMs } : { command, timeoutMs, stdin });
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
    async screenshot(maxWidth, quality, destDir) {
      // Positional, matching the Kotlin. Mocking an object here is what let the real defect ship:
      // the test agreed with the (wrong) type, and only a device disagreed with both.
      calls.screenshots.push({
        maxWidth,
        quality,
        ...(destDir === undefined ? {} : { destDir }),
      });
      return {
        path: "file:///w/shot.jpg",
        width: maxWidth,
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

  describe("when a field names more than one thing (both cases are real device output)", () => {
    it("skips an unset display instead of reporting no app at all", () => {
      // Verbatim from an Android 14 phone. A virtual display writes the field as `null` and the
      // primary display writes the real value on the next line. Taking the first match reported
      // "no foreground app" on a device where the app was right there — the worst failure mode here,
      // because `screen_wait` turns it into a timeout and a timeout reads as "it never opened".
      const output = [
        "  mCurrentFocus=null",
        "  mCurrentFocus=Window{cad87e3 u0 com.netease.cloudmusic/com.netease.cloudmusic.activity.IconChangeDefaultAlias type=1 }",
      ].join("\n");
      expect(parseForeground(output)).toMatchObject({
        package: "com.netease.cloudmusic",
        activity: "com.netease.cloudmusic.activity.IconChangeDefaultAlias",
      });
    });

    it("still answers when an unset display is listed last", () => {
      // Pins the direction this must survive, and documents which mechanism carries it. `null` first
      // is not a good test of the `null` short-circuit, because the later real value overwrites it
      // and the answer is right either way. `null` *last* is the shape that matters: "take the last
      // line" alone would conclude nothing holds focus while an app plainly does.
      //
      // What carries it is the token match — a `null` line has no `package/activity` in it, so it
      // never becomes the chosen candidate. Removing the explicit `null` short-circuit changes no
      // outcome (checked by mutation), which is why the comment in the parser says so rather than
      // claiming the short-circuit is load-bearing.
      const output = [
        "  mCurrentFocus=Window{cad87e3 u0 com.netease.cloudmusic/com.netease.cloudmusic.activity.IconChangeDefaultAlias type=1 }",
        "  mCurrentFocus=null",
      ].join("\n");
      expect(parseForeground(output)).toMatchObject({
        package: "com.netease.cloudmusic",
        activity: "com.netease.cloudmusic.activity.IconChangeDefaultAlias",
      });
    });

    it("does the same for mFocusedApp", () => {
      const output = [
        "  mFocusedApp=null",
        "  mFocusedApp=ActivityRecord{4686d6a u0 com.netease.cloudmusic/.activity.IconChangeDefaultAlias t695 d0}",
      ].join("\n");
      expect(parseForeground(output)).toMatchObject({ package: "com.netease.cloudmusic" });
    });

    it("takes the last task stack, not the first, when the activity dump lists several", () => {
      // Also verbatim. `topResumedActivity` is written once per task stack and the count varies
      // between calls (measured 1, then 2, seconds apart on the same device), so there is no fixed
      // line to reach for. Here the launcher is listed first and the app the user was looking at is
      // listed last; taking the first named the launcher and the arrival check called a successful
      // launch a failure.
      const output = [
        "      topResumedActivity=ActivityRecord{376ccf u0 com.bbk.launcher2/.Launcher t6 d0}",
        "    topResumedActivity=ActivityRecord{2831f17 u0 com.netease.cloudmusic/.activity.IconChangeDefaultAlias t693 d0}",
      ].join("\n");
      expect(parseForeground(output)).toMatchObject({
        package: "com.netease.cloudmusic",
        activity: ".activity.IconChangeDefaultAlias",
      });
    });

    it("takes the last when our own app is listed first", () => {
      // The same shape with this app in the first slot — the other half of the pair, and the case
      // that made a launch look like it had not landed.
      const output = [
        "    topResumedActivity=ActivityRecord{3a25742 u0 dev.mobileclaw.app/.MainActivity t691 d0}",
        "    topResumedActivity=ActivityRecord{f840f28 u0 com.netease.cloudmusic/.activity.IconChangeDefaultAlias t693 d0}",
      ].join("\n");
      expect(parseForeground(output)).toMatchObject({ package: "com.netease.cloudmusic" });
    });

    it("prefers a focus field over a resumed-activity field when both are present", () => {
      // The ordering is the fix for a defect, not a preference: the activity dump is multi-valued,
      // so if it is consulted first a wrong-but-parseable answer ends the search. Focus is singular
      // by construction, so it is asked first.
      const output = [
        "    topResumedActivity=ActivityRecord{aaa u0 com.bbk.launcher2/.Launcher t6 d0}",
        "  mCurrentFocus=Window{bbb u0 com.netease.cloudmusic/com.netease.cloudmusic.activity.IconChangeDefaultAlias type=1 }",
      ].join("\n");
      expect(parseForeground(output)).toMatchObject({ package: "com.netease.cloudmusic" });
    });

    it("falls through to a later field when an earlier one names only unset displays", () => {
      // "Present" is not "answered". A field on every display and naming nothing must not stop the
      // search, or a device that reports focus as null everywhere would never be read at all.
      const output = [
        "  mCurrentFocus=null",
        "  mFocusedApp=null",
        "    topResumedActivity=ActivityRecord{ccc u0 com.tencent.mm/.ui.LauncherUI t9 d0}",
      ].join("\n");
      expect(parseForeground(output)).toMatchObject({
        package: "com.tencent.mm",
        activity: ".ui.LauncherUI",
      });
    });
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

  it("queries the foreground window and parses the result", async () => {
    const h = harness();
    const foreground = await createAutomationService(h.native, h.ports).currentWindow();

    // The window dump is asked **first**, because `mCurrentFocus` is the better question: it names
    // the window holding input focus and is singular by construction, while the activity dump writes
    // `topResumedActivity` once per task stack and can therefore name the launcher — or this app —
    // while a target app is genuinely in front. The first source that names anything wins, so asking
    // the multi-valued one first let a wrong answer end the search before the right one was read.
    expect(h.calls.runs[0]!.command).toContain("dumpsys window");
    expect(foreground.package).toBe("com.tencent.mm");
    expect(foreground.activity).toBe("com.tencent.mm.ui.LauncherUI");
    // And the activity dump is *not* consulted, because the first source already answered. Asking it
    // anyway would be a wasted round trip on the common path, and on the device measured here it is
    // the source that can return a wrong-but-parseable answer.
    expect(h.calls.runs.some((run) => run.command.includes("dumpsys activity activities"))).toBe(false);
  });

  it("falls through to the activity dump when the window dump names nothing", async () => {
    // The other half: the ordering must not cost the fallback. On a release where `dumpsys window`
    // has no useful field names, the activity dump is the only thing that answers, and it still has
    // to be asked — after the better source has failed, not before it.
    const calls: NativeCalls = { screenshots: [], runs: [] };
    const h = harness({
      async runPrivileged(command: string, timeoutMs: number) {
        calls.runs.push({ command, timeoutMs });
        if (command === "wm size") return { exitCode: 0, stdout: "Physical size: 1080x2400", stderr: "" };
        return command.startsWith("dumpsys window")
          ? { exitCode: 0, stdout: "WINDOW MANAGER (dumpsys window)\n  mCurrentFocus=null", stderr: "" }
          : {
              exitCode: 0,
              stdout: "    topResumedActivity=ActivityRecord{ccc u0 com.tencent.mm/.ui.LauncherUI t9 d0}",
              stderr: "",
            };
      },
    });
    const foreground = await createAutomationService(h.native, h.ports).currentWindow();

    expect(calls.runs[0]!.command).toContain("dumpsys window");
    expect(calls.runs.some((run) => run.command.includes("dumpsys activity activities"))).toBe(true);
    expect(foreground.package).toBe("com.tencent.mm");
    expect(foreground.activity).toBe(".ui.LauncherUI");
  });

  it("reports every command it tried when no source names the foreground app", async () => {
    // The failure this exists for: on a ROM whose `dumpsys` names the field something else, every
    // probe comes back empty, `screen_wait` times out, and the only thing the user is told is that
    // it timed out. Carrying the attempts into `raw` is what makes that diagnosable.
    const h = harness({
      async runPrivileged(command, timeoutMs) {
        h.calls.runs.push({ command, timeoutMs });
        if (command === "wm size") return { exitCode: 0, stdout: "Physical size: 1080x2400", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "no such field" };
      },
    });
    const foreground = await createAutomationService(h.native, h.ports).currentWindow();

    expect(foreground.package).toBeUndefined();
    expect(foreground.raw).toContain("dumpsys activity activities");
    expect(foreground.raw).toContain("dumpsys window");
    expect(foreground.raw).toContain("no such field");
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

    expect(h.calls.runs).toEqual([{ command: "id", timeoutMs: 5000, stdin: "" }]);
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

  it("passes stdin through to the native module", async () => {
    // The seam that was missing, and the reason the deep-link feature did not work.
    //
    // `NativeBridgeShell.run` forwarded the whole options object and said why: a value that must not
    // appear on a command line can only travel on stdin. This layer then passed `command` and
    // `timeoutMs` and dropped the rest, so `read -r url` in AIDL's `sh -c` read EOF. On a device that
    // surfaced as `read exit=1 url=[]` and `am start` rejecting an empty data URI — with the failure
    // reported as though the device had no handler for the scheme.
    //
    // Asserted here rather than only at the shell wrapper, because this is the layer that dropped it:
    // the wrapper's own test passed the whole time.
    const { native, calls } = harness();
    await createPrivilegedService(native).run("read -r url", { stdin: "orpheus://song/1\n" });
    expect(calls.runs.at(-1)?.stdin).toBe("orpheus://song/1\n");
  });

  it("always fills the stdin argument, because the bridge counts arguments", async () => {
    // The defect this pins down, and it broke every command on a device:
    //
    //   TurboModule method "runPrivileged" called with 2 arguments (expected argument count: 3)
    //
    // Adding an optional third parameter to the Kotlin method made the bridge demand three
    // arguments, while the TypeScript `stdin?: string` compiled two-argument calls perfectly happily.
    // So `screen_current`, `screen_read` and every other shell command failed -- anything that used
    // the privileged shell, which is most of them.
    //
    // The rule: the count is fixed at the boundary, so every call site passes the slot. "No input"
    // is the empty string, which the child reads as EOF just as it would from a closed stream. The
    // meaningful distinction is per-call (`options.stdin` present or not), not per-arity.
    const { native, calls } = harness();
    await createPrivilegedService(native).run("id");
    expect(calls.runs.at(-1)?.stdin).toBe("");
  });

  it("passes a supplied stdin through unchanged", async () => {
    const { native, calls } = harness();
    await createPrivilegedService(native).run("read -r url", { stdin: "weixin://\n" });
    expect(calls.runs.at(-1)?.stdin).toBe("weixin://\n");
  });
});
