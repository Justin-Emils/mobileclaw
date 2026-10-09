import { describe, expect, it } from "vitest";
import {
  createAutomationTools,
  createScreenReadTools,
  formatScreenReading,
  parseBounds,
} from "@mobileclaw/capabilities";
import {
  CoreError,
  SCREEN_DEFAULTS,
  type AnyToolDefinition,
  type AutomationService,
  type ScreenBounds,
  type ScreenNode,
  type ScreenReadOptions,
  type ScreenSnapshot,
  type SystemService,
} from "@mobileclaw/core";

/**
 * The two reading tools, driven through the definitions the model actually calls.
 *
 * `ui-dump.test.ts` pins the projection and `automation-evidence.test.ts` pins the
 * transcript side of a press; what is untested between them is the tool itself. Three
 * things there are worth a test and none of them is visible from either neighbour:
 * which number reaches which node, that a press takes a *fraction* of the display
 * rather than the pixel centre the reading printed, and that a screen which could not
 * be read is never reported as a screen that is empty.
 *
 * Every fixture that has geometry is built through the real parser (`parseBounds`)
 * instead of a hand-written centre, so these tests cannot agree with the
 * implementation by sharing the same wrong arithmetic.
 */

/** Shell identity the Android backend rides on, as the stub reports it. */
const SHELL_UID = 2000;
/** The app the reading came from, and one that is not it. */
const APP_PACKAGE = "com.example.chat";
const OTHER_PACKAGE = "com.tencent.mm";
/** The conversation directory a press drops its evidence into. */
const WORKSPACE = "/tmp/ws";
/** The display the reading reports, in the pixels the dump carries. */
const DISPLAY = { width: 1080, height: 2400 } as const;
/** A label in a script that is not ASCII: the reading must carry it through intact. */
const SEARCH_LABEL = "\u641c\u7d22";
const HEADER_LABEL = "Chats";
/** The `#` number a reading prints for the element that can be pressed. */
const PRESSABLE_INDEX = 1;
/** No node on any fixture screen carries this number. */
const MISSING_INDEX = 7;
/** A budget the caller picks; the backend applies it, the tool only passes it on. */
const MAX_TEXT_LENGTH = 64;
/** What the backend says when it could read nothing, instead of an empty screen. */
const BACKEND_NOTE = "the window is FLAG_SECURE, so nothing readable was published";
const EVIDENCE_SHOT = { path: "file:///tmp/ws/shot.jpg", width: 720, height: 1600 };
/** The failure a protected window makes the evidence capture produce. */
const EVIDENCE_FAILURE = "FLAG_SECURE";
const TARGET = "search box";

const CALL = { signal: new AbortController().signal, callId: "c1", workspace: WORKSPACE };

/** Fixture bounds, parsed by the real parser so the centre is not a second guess. */
function boundsOf(raw: string): ScreenBounds {
  const bounds = parseBounds(raw);
  if (!bounds) throw new Error(`fixture bounds did not parse: ${raw}`);
  return bounds;
}

const PRESSABLE_BOUNDS = boundsOf("[540,2000][900,2200]");

/**
 * The point a press must land on: the pixel centre the reading printed, expressed as
 * the fraction of the display a tap takes. x and y are deliberately different, so an
 * implementation that swapped the axes cannot pass by coincidence.
 */
const PRESSABLE_FRACTION = {
  x: PRESSABLE_BOUNDS.centerX / DISPLAY.width,
  y: PRESSABLE_BOUNDS.centerY / DISPLAY.height,
} as const;

/** An element as a reading numbers it. */
function pressableNode(over: Partial<ScreenNode> = {}): ScreenNode {
  return {
    index: PRESSABLE_INDEX,
    text: SEARCH_LABEL,
    className: "EditText",
    bounds: PRESSABLE_BOUNDS,
    clickable: true,
    ...over,
  };
}

/** The nodes a reading kept, numbered as it numbers them: one label, one control. */
const SCREEN_NODES: ScreenNode[] = [
  { index: 0, text: HEADER_LABEL, className: "TextView" },
  pressableNode(),
];

/** A measured display carrying those nodes. */
function snapshotOf(over: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  return {
    nodes: SCREEN_NODES,
    // How many nodes the projection examined, before the reading kept any.
    total: SCREEN_NODES.length,
    width: DISPLAY.width,
    height: DISPLAY.height,
    package: APP_PACKAGE,
    ...over,
  };
}

/** A working screen backend, with any single method replaceable. */
function screenSystem(over: Partial<AutomationService> = {}): SystemService {
  return {
    kind: "stub",
    async openUrl() {},
    async openApp() {},
    automation: {
      kind: "shizuku",
      async status() {
        return { available: true, backend: "shizuku", uid: SHELL_UID };
      },
      async captureScreen() {
        return { ...EVIDENCE_SHOT };
      },
      async tap() {},
      async scroll() {},
      async typeText() {
        return { method: "input" as const };
      },
      async currentWindow() {
        return { package: APP_PACKAGE, raw: "" };
      },
      async readScreen() {
        return snapshotOf();
      },
      ...over,
    },
  };
}

/** A platform with no privileged screen backend installed at all. */
function systemWithoutAutomation(): SystemService {
  return { kind: "stub", async openUrl() {}, async openApp() {} };
}

function toolNamed(system: SystemService, name: string): AnyToolDefinition {
  const tool = createScreenReadTools({ system }).find((entry) => entry.name === name);
  if (!tool) throw new Error(`no screen tool named ${name}`);
  return tool;
}

/** Record what each reading was asked for, in order. */
function readingRecorder(snapshot: ScreenSnapshot) {
  const calls: Array<ScreenReadOptions | undefined> = [];
  const readScreen = async (options?: ScreenReadOptions) => {
    calls.push(options);
    return snapshot;
  };
  return { calls, readScreen };
}

interface TapInput {
  index: number;
  target?: string;
  reading?: string;
}

interface TapResult {
  index: number;
  pressed: { x: number; y: number };
  label: string | null;
  target?: string;
  warning?: string;
  evidence?: { path: string; width: number; height: number; note?: string };
  evidenceNote?: string;
}

/**
 * One `screen_tap_element` call: the tool plus everything it did to the backend.
 *
 * Kept together because most of these cases are about the *order* of what happens:
 * which node was looked up, whether a point ever reached `tap`, and what was captured
 * afterwards. A test that only checked the thrown error would not notice a press that
 * happened anyway.
 */
function tapHarness(snapshot: ScreenSnapshot, over: Partial<AutomationService> = {}) {
  const points: Array<[number, number]> = [];
  const captures: Array<{ quality?: number; destDir?: string }> = [];
  const reads: Array<ScreenReadOptions | undefined> = [];
  const system = screenSystem({
    async readScreen(options) {
      reads.push(options);
      return snapshot;
    },
    async tap(x, y) {
      points.push([x, y]);
    },
    async captureScreen(options) {
      captures.push(options ?? {});
      return { ...EVIDENCE_SHOT };
    },
    ...over,
  });
  const tool = toolNamed(system, "screen_tap_element");
  return {
    points,
    captures,
    reads,
    run: (input: TapInput) => tool.execute(input as never, CALL as never) as Promise<TapResult>,
  };
}

describe("screen_read", () => {
  it("returns the reading and the snapshot behind it, reading the screen once", async () => {
    const snapshot = snapshotOf();
    const reads = readingRecorder(snapshot);
    const tool = toolNamed(screenSystem({ readScreen: reads.readScreen }), "screen_read");

    const result = (await tool.execute({} as never, CALL as never)) as ScreenSnapshot & {
      reading: string;
    };

    // Both halves of one call: the text the model reads and the array an adapter
    // iterates, so the two can never disagree about which element is `#1`.
    expect(result).toEqual({ ...snapshot, reading: formatScreenReading(snapshot).text });
    expect(result.reading).toContain(SEARCH_LABEL);
    expect(result.reading).toContain(`#${PRESSABLE_INDEX}`);

    // Called once, and with no options: the caller asked for the whole screen.
    expect(reads.calls).toEqual([{}]);
  });

  it("passes the caller's maxTextLength through to the backend", async () => {
    const reads = readingRecorder(snapshotOf());
    const tool = toolNamed(screenSystem({ readScreen: reads.readScreen }), "screen_read");

    await tool.execute({ maxTextLength: MAX_TEXT_LENGTH } as never, CALL as never);

    // The tool narrows nothing itself; the budget is the backend's to apply, and a
    // dropped option would silently send the full-length text instead.
    expect(reads.calls).toEqual([{ maxTextLength: MAX_TEXT_LENGTH }]);
  });

  it("carries the backend's note into the reading, so a thin screen is not read as empty", async () => {
    // The contract this pins: zero nodes plus no note is indistinguishable from a
    // genuinely empty screen, and the model then tells the user their screen is empty.
    const system = screenSystem({
      async readScreen() {
        return { nodes: [], total: 0, note: BACKEND_NOTE };
      },
    });

    const result = (await toolNamed(system, "screen_read").execute({} as never, CALL as never)) as
      ScreenSnapshot & { reading: string };

    expect(result.nodes).toEqual([]);
    expect(result.note).toBe(BACKEND_NOTE);
    expect(result.reading).toContain(BACKEND_NOTE);
  });

  it("throws with a hint when the platform has no screen backend", async () => {
    const pending = toolNamed(systemWithoutAutomation(), "screen_read").execute(
      {} as never,
      CALL as never,
    );

    await expect(pending).rejects.toBeInstanceOf(CoreError);
    await expect(pending).rejects.toMatchObject({
      code: "E_TOOL_FAILED",
      message: expect.stringMatching(/unavailable on this platform/),
      details: { hint: expect.stringMatching(/Android/) },
    });
  });
});

describe("screen_tap_element", () => {
  it("presses the numbered element as a fraction of the display, not at its pixel centre", async () => {
    const harness = tapHarness(snapshotOf());

    const result = await harness.run({ index: PRESSABLE_INDEX, target: TARGET });

    // The point the reading printed is in display pixels; a tap takes a ratio, because
    // nobody in the chain knows the display size. Asserted exactly.
    expect(PRESSABLE_FRACTION.x).not.toBe(PRESSABLE_FRACTION.y);
    expect(harness.points).toEqual([[PRESSABLE_FRACTION.x, PRESSABLE_FRACTION.y]]);
    expect(harness.points).not.toEqual([
      [PRESSABLE_BOUNDS.centerX, PRESSABLE_BOUNDS.centerY],
    ]);

    // The pixel point still comes back, so the transcript can say where it landed.
    expect(result.pressed).toEqual({ x: PRESSABLE_BOUNDS.centerX, y: PRESSABLE_BOUNDS.centerY });
    expect(result.index).toBe(PRESSABLE_INDEX);
    expect(result.label).toBe(SEARCH_LABEL);
    expect(result.target).toBe(TARGET);

    // And the evidence lands in the conversation's own workspace, at the glance-quality
    // setting rather than the one a picture meant to be read would use.
    expect(harness.captures).toHaveLength(1);
    expect(harness.captures[0]).toMatchObject({
      quality: SCREEN_DEFAULTS.evidenceQuality,
      destDir: WORKSPACE,
    });
    expect(result.evidence).toEqual(EVIDENCE_SHOT);
  });

  it("refuses a number that is not on the current screen, naming it and asking for a reading", async () => {
    const harness = tapHarness(snapshotOf());

    const pending = harness.run({ index: MISSING_INDEX });

    await expect(pending).rejects.toBeInstanceOf(CoreError);
    await expect(pending).rejects.toMatchObject({
      code: "E_TOOL_FAILED",
      message: `element #${MISSING_INDEX} is not on the current screen`,
      details: { hint: expect.stringMatching(/Read the screen again/i) },
    });
    expect(harness.points).toEqual([]);
  });

  it("refuses an element that is not pressable", async () => {
    // Bounds but no `tap` trait: a container's own rectangle, pressing which would do
    // nothing or something unintended.
    const nodes: ScreenNode[] = [
      { index: PRESSABLE_INDEX, text: HEADER_LABEL, bounds: PRESSABLE_BOUNDS },
    ];
    const harness = tapHarness(snapshotOf({ nodes, total: nodes.length }));

    const pending = harness.run({ index: PRESSABLE_INDEX });

    await expect(pending).rejects.toMatchObject({
      code: "E_TOOL_FAILED",
      message: `element #${PRESSABLE_INDEX} is not pressable`,
      details: { hint: expect.stringMatching(/tap/) },
    });
    expect(harness.points).toEqual([]);
  });

  it("refuses an element the app has switched off", async () => {
    const nodes: ScreenNode[] = [pressableNode({ disabled: true })];
    const harness = tapHarness(snapshotOf({ nodes, total: nodes.length }));

    const pending = harness.run({ index: PRESSABLE_INDEX });

    await expect(pending).rejects.toMatchObject({
      code: "E_TOOL_FAILED",
      message: `element #${PRESSABLE_INDEX} is present but disabled`,
    });
    expect(harness.points).toEqual([]);
  });

  it("refuses when the reading does not know the display size", async () => {
    // Without a size the pixel centre cannot be turned into the fraction a tap takes,
    // and guessing one would press a different point on a different device.
    const harness = tapHarness(snapshotOf({ width: undefined, height: undefined }));

    const pending = harness.run({ index: PRESSABLE_INDEX });

    await expect(pending).rejects.toMatchObject({
      code: "E_TOOL_FAILED",
      message: expect.stringMatching(/display size is unknown/),
    });
    expect(harness.points).toEqual([]);
  });

  it("warns when the foreground app changed between the reading and the press", async () => {
    // The gap between reading and pressing is exactly when a notification or the user's
    // thumb moves the foreground, and the press still happens - it is just pointed at
    // the remembered coordinate of an app that may no longer be there.
    const harness = tapHarness(snapshotOf(), {
      async currentWindow() {
        return { package: OTHER_PACKAGE, raw: "" };
      },
    });

    const result = await harness.run({ index: PRESSABLE_INDEX, reading: APP_PACKAGE });

    expect(result.warning).toContain(APP_PACKAGE);
    expect(result.warning).toContain(OTHER_PACKAGE);
    expect(harness.points).toEqual([[PRESSABLE_FRACTION.x, PRESSABLE_FRACTION.y]]);
  });

  it("says nothing about the foreground when it is still the app that was read", async () => {
    const harness = tapHarness(snapshotOf());

    const result = await harness.run({ index: PRESSABLE_INDEX, reading: APP_PACKAGE });

    expect(result.warning).toBeUndefined();
    expect(Object.hasOwn(result, "warning")).toBe(false);
  });

  it("keeps the press when the evidence capture fails", async () => {
    // The same decision `screen_tap` already made: the action happened, so the call is a
    // success. What the user loses is the picture, and that has to be said out loud
    // rather than turning a press that already landed into an error.
    const harness = tapHarness(snapshotOf(), {
      async captureScreen() {
        throw new Error(EVIDENCE_FAILURE);
      },
    });

    const result = await harness.run({ index: PRESSABLE_INDEX });

    expect(harness.points).toEqual([[PRESSABLE_FRACTION.x, PRESSABLE_FRACTION.y]]);
    expect(result.evidence).toBeUndefined();
    expect(result.evidenceNote).toContain("evidence capture failed");
    expect(result.evidenceNote).toContain(EVIDENCE_FAILURE);
  });
});

describe("screen tool permission posture", () => {
  it("lets a reading happen without a prompt", () => {
    const tool = toolNamed(screenSystem(), "screen_read");

    // Reading changes nothing on the device, and prompting would mean the user
    // approving a look at a screen they are already looking at.
    expect(tool.risk).toBe("read");
    expect(tool.alwaysAsk).toBeUndefined();
    expect(tool.neverRemember).toBeUndefined();
  });

  it("makes every press ask, immune to a session-wide allow", () => {
    const tool = toolNamed(screenSystem(), "screen_tap_element");

    // `risk: "system"` is the level the gate keys on and `alwaysAsk` refuses any allow rule,
    // so no "always allow" can pre-grant a press. `mutates: false` says a press navigates
    // rather than changes anything — which is consulted *only* inside a task the user
    // confirmed as read-only, and is what keeps "read my playlist" from asking per swipe.
    expect(tool.risk).toBe("system");
    expect(tool.alwaysAsk).toBe(true);
    expect(tool.mutates).toBe(false);
    // Not `neverRemember`: leaving it on would keep the prompt alive even inside a read-only
    // task and defeat the scope, while outside the scope `alwaysAsk` already covers this.
    expect(tool.neverRemember).toBeUndefined();
  });

  it("keeps the strongest promise on the tool that types", () => {
    // `screen_type` lives in `tools/automation.ts`, not here: typing is the write, and this
    // file only covers the reading tools. Named explicitly so the file boundary is visible.
    const tool = createAutomationTools({ system: screenSystem() }).find(
      (entry) => entry.name === "screen_type",
    );
    if (!tool) throw new Error("no automation tool named screen_type");

    // Typing writes into another app's field. That is a change whatever the task was, so it
    // keeps both flags: asked every time, and a read-only scope must not be able to relax it.
    expect(tool.neverRemember).toBe(true);
    expect(tool.mutates).not.toBe(false);
  });
});
