import { describe, expect, it } from "vitest";
import { createScreenReadTools, parseBounds } from "@mobileclaw/capabilities";
import {
  CoreError,
  SCREEN_DEFAULTS,
  type AnyToolDefinition,
  type AutomationService,
  type ScreenBounds,
  type ScreenNode,
  type ScreenSnapshot,
  type SystemService,
} from "@mobileclaw/core";

/**
 * `screen_find` — the one-step form of "read the screen, then press the thing".
 *
 * The reason this tool exists is a failure mode of the two-step version: correctness
 * depended on a `#` number surviving from one tool call to the next, and on nothing
 * having moved in between. So what is pinned here is that the *label* decides, resolved
 * against the screen that is in front at the moment of the press.
 *
 * Two of these cases are about not lying rather than about pressing. A search that finds
 * nothing must say whether the screen was unreadable or the label was simply absent —
 * those are different findings and only one of them means "try another label". And an
 * element that matched but cannot be pressed must be reported as such, not pressed at
 * its centre, because pressing the middle of a label does nothing while looking like it
 * worked.
 *
 * Geometry is built through the real parser (`parseBounds`), so a wrong centre cannot be
 * agreed with by both sides.
 */

const SHELL_UID = 2000;
const APP_PACKAGE = "com.example.chat";
const WORKSPACE = "/tmp/ws";
const DISPLAY = { width: 1080, height: 2400 } as const;
const CALL = { signal: new AbortController().signal, callId: "c1", workspace: WORKSPACE };

/** A label in a script that is not ASCII, written as an escape: this file is ASCII-only. */
const SEARCH_LABEL = "\u641c\u7d22";
/** An icon-only control's *only* label, which lives in `content-desc`. */
const ICON_LABEL = "\u8bbe\u7f6e";
const UNRELATED_LABEL = "Chats";
const EVIDENCE_SHOT = { path: "file:///tmp/ws/shot.jpg", width: 720, height: 1600 };

function boundsOf(raw: string): ScreenBounds {
  const bounds = parseBounds(raw);
  if (!bounds) throw new Error(`fixture bounds did not parse: ${raw}`);
  return bounds;
}

/** The control a search is meant to find: short label, real geometry, pressable. */
const CONTROL_BOUNDS = boundsOf("[540,2000][900,2200]");
/** A big non-pressable container that happens to contain the same word. */
const CONTAINER_BOUNDS = boundsOf("[0,0][1080,2400]");
/** An icon-only control, far from the other two. */
const ICON_BOUNDS = boundsOf("[40,40][140,140]");

/** The fraction of the display a press must use — never the raw pixel centre. */
const CONTROL_FRACTION = {
  x: CONTROL_BOUNDS.centerX / DISPLAY.width,
  y: CONTROL_BOUNDS.centerY / DISPLAY.height,
} as const;

const CONTAINER_INDEX = 0;
const CONTROL_INDEX = 1;
const ICON_INDEX = 2;

/**
 * One screen: the word appears in a large non-pressable container *and* in a small
 * pressable control, which is exactly the shape an accessibility tree produces for a
 * labelled button — the text is on the child, the tap target is the parent.
 */
const SCREEN: ScreenNode[] = [
  { index: CONTAINER_INDEX, text: SEARCH_LABEL, className: "LinearLayout", bounds: CONTAINER_BOUNDS },
  { index: CONTROL_INDEX, text: SEARCH_LABEL, className: "Button", bounds: CONTROL_BOUNDS, clickable: true },
  { index: ICON_INDEX, description: ICON_LABEL, className: "ImageView", bounds: ICON_BOUNDS, clickable: true },
  { index: 3, text: UNRELATED_LABEL, className: "TextView" },
];

function snapshotOf(over: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  return {
    nodes: SCREEN,
    total: SCREEN.length,
    width: DISPLAY.width,
    height: DISPLAY.height,
    package: APP_PACKAGE,
    ...over,
  };
}

/** Records every press, so "did it press?" is answerable independently of the result. */
function tapRecorder(snapshot: ScreenSnapshot, over: Partial<AutomationService> = {}) {
  const taps: Array<{ x: number; y: number }> = [];
  const system: SystemService = {
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
      async tap(x, y) {
        taps.push({ x, y });
      },
      async scroll() {},
      async typeText() {
        return { method: "input" as const };
      },
      async currentWindow() {
        return { package: APP_PACKAGE, raw: "" };
      },
      async readScreen() {
        return snapshot;
      },
      ...over,
    },
  };
  return { taps, system };
}

function findTool(system: SystemService): AnyToolDefinition {
  const tool = createScreenReadTools({ system }).find((entry) => entry.name === "screen_find");
  if (!tool) throw new Error("no screen_find tool");
  return tool;
}

interface FindInput {
  query: string;
  mode?: "contains" | "exact" | "regex";
  do?: "find" | "tap";
  expect?: string;
}

/**
 * `do` defaults to `"find"` here too, so a test that means to press says so. Leaving it
 * to the tool's schema default would let the tests depend on defaulting behaviour they
 * are not testing, and would hide a change of that default from every case but one.
 */
function run(input: FindInput, system: SystemService): Promise<Record<string, unknown>> {
  const withDefault = { do: "find" as const, ...input };
  return findTool(system).execute(withDefault as never, CALL as never) as Promise<Record<string, unknown>>;
}

describe("screen_find", () => {
  it("reports matches without pressing anything by default", async () => {
    const { taps, system } = tapRecorder(snapshotOf());
    const result = await run({ query: SEARCH_LABEL }, system);

    expect(result["found"]).toBe(true);
    // The whole point of defaulting to `find`: discovering a label must not be a change
    // to the device that the user has to approve.
    expect(taps).toEqual([]);
  });

  it("names the app and both matches, so the caller can choose", async () => {
    const { system } = tapRecorder(snapshotOf());
    const result = await run({ query: SEARCH_LABEL }, system);

    expect(result["app"]).toBe(APP_PACKAGE);
    const matches = result["matches"] as Array<Record<string, unknown>>;
    expect(matches.map((match) => match["index"])).toEqual([CONTAINER_INDEX, CONTROL_INDEX]);
    expect(matches[1]?.["pressable"]).toBe(true);
    expect(matches[0]?.["pressable"]).toBe(false);
  });

  it("presses the pressable match, not the bigger container that also matched", async () => {
    const { taps, system } = tapRecorder(snapshotOf());
    await run({ query: SEARCH_LABEL, do: "tap" }, system);

    // The container is larger and would win a naive "largest match" rule; the control is
    // what a person's finger would hit.
    expect(taps).toEqual([CONTROL_FRACTION]);
  });

  it("presses a fraction of the display, never the pixel centre it printed", async () => {
    const { taps, system } = tapRecorder(snapshotOf());
    await run({ query: SEARCH_LABEL, do: "tap" }, system);

    const [tap] = taps;
    expect(tap?.x).toBe(CONTROL_FRACTION.x);
    expect(tap?.y).toBe(CONTROL_FRACTION.y);
    expect(tap?.x).not.toBe(CONTROL_BOUNDS.centerX);
  });

  it("says which of the two zero-match reasons applies", async () => {
    const { taps, system } = tapRecorder(snapshotOf());
    const result = await run({ query: "definitely not on this screen", do: "tap" }, system);

    expect(result["found"]).toBe(false);
    expect(result["searched"]).toBe(SCREEN.length);
    // Elements were read and none matched — so the label is wrong, not the screen.
    expect(String(result["reason"])).toMatch(/none matching/);
    expect(taps).toEqual([]);
  });

  it("passes the backend's own note through when nothing was readable", async () => {
    // A protected window publishes no nodes. Reporting that as "no element matched"
    // would send the caller looking for a different label forever.
    const note = "the screen could not be read: FLAG_SECURE";
    const { system } = tapRecorder(snapshotOf({ nodes: [], total: 0, note }));
    const result = await run({ query: SEARCH_LABEL }, system);

    expect(result["found"]).toBe(false);
    expect(result["reason"]).toBe(note);
  });

  it("finds an icon-only control by its content description", async () => {
    // A magnifier or gear button has no `text` at all. A search that only read `text`
    // could never find one, which would make most real screens unreachable.
    const { system } = tapRecorder(snapshotOf());
    const result = await run({ query: ICON_LABEL, do: "tap" }, system);

    expect(result["found"]).not.toBe(false);
    expect((result["tapped"] as Record<string, unknown>)["index"]).toBe(ICON_INDEX);
  });

  it("matches case-insensitively in contains mode", async () => {
    const { system } = tapRecorder(snapshotOf());
    const result = await run({ query: "chats", do: "find" }, system);
    expect(result["found"]).toBe(true);
  });

  it("honours exact mode instead of falling back to a substring", async () => {
    const { system } = tapRecorder(snapshotOf());
    // "Chat" is a prefix of "Chats" but not equal to it.
    const result = await run({ query: "Chat", mode: "exact", do: "find" }, system);
    expect(result["found"]).toBe(false);
  });

  it("accepts a regex, and reports a broken one as a bad query", async () => {
    const { system } = tapRecorder(snapshotOf());
    const matched = await run({ query: "^Cha", mode: "regex", do: "find" }, system);
    expect(matched["found"]).toBe(true);

    await expect(run({ query: "([unclosed", mode: "regex", do: "find" }, system)).rejects.toThrow(CoreError);
  });

  it("refuses to press a match that cannot be pressed", async () => {
    // The container matched but reports no click action. Pressing its centre would look
    // like a successful tap and do nothing at all.
    const { taps, system } = tapRecorder(snapshotOf({ nodes: [SCREEN[CONTAINER_INDEX] as ScreenNode] }));
    await expect(run({ query: SEARCH_LABEL, do: "tap" }, system)).rejects.toThrow(/not pressable/);
    expect(taps).toEqual([]);
  });

  it("refuses to press a disabled match", async () => {
    const disabled: ScreenNode = {
      index: CONTROL_INDEX,
      text: SEARCH_LABEL,
      className: "Button",
      bounds: CONTROL_BOUNDS,
      clickable: true,
      disabled: true,
    };
    const { taps, system } = tapRecorder(snapshotOf({ nodes: [disabled] }));
    await expect(run({ query: SEARCH_LABEL, do: "tap" }, system)).rejects.toThrow(/disabled/);
    expect(taps).toEqual([]);
  });

  it("refuses to press when the display size is unknown, rather than guessing", async () => {
    // Without the display size there is no way to express the point as the fraction a
    // tap takes; clamping a guessed fraction would press somewhere real but wrong.
    const { taps, system } = tapRecorder(snapshotOf({ width: undefined, height: undefined }));
    await expect(run({ query: SEARCH_LABEL, do: "tap" }, system)).rejects.toThrow(/display size/);
    expect(taps).toEqual([]);
  });

  it("checks `expect` before acting, and names what was missing", async () => {
    const { taps, system } = tapRecorder(snapshotOf());
    await expect(
      run({ query: SEARCH_LABEL, do: "tap", expect: "Payment sent" }, system),
    ).rejects.toThrow(/Payment sent/);
    // The guard exists to stop a press on the wrong screen, so it must not press.
    expect(taps).toEqual([]);
  });

  it("proceeds when `expect` really is on screen", async () => {
    const { taps, system } = tapRecorder(snapshotOf());
    await run({ query: SEARCH_LABEL, do: "tap", expect: UNRELATED_LABEL }, system);
    expect(taps).toEqual([CONTROL_FRACTION]);
  });

  it("keeps the reading it acted on, and captures evidence", async () => {
    const { system } = tapRecorder(snapshotOf());
    const result = await run({ query: SEARCH_LABEL, do: "tap" }, system);

    // The transcript then records what the press was aimed at, not merely where it went.
    expect(String(result["reading"])).toContain(String(CONTROL_INDEX));
    expect(result["evidence"]).toMatchObject({ path: EVIDENCE_SHOT.path });
  });

  it("still presses when the evidence capture fails, and says so", async () => {
    // The press already happened; a failed screenshot must not turn it into an error the
    // caller might retry.
    const { taps, system } = tapRecorder(snapshotOf(), {
      async captureScreen() {
        throw new Error("FLAG_SECURE");
      },
    });
    const result = await run({ query: SEARCH_LABEL, do: "tap" }, system);

    expect(taps).toEqual([CONTROL_FRACTION]);
    expect(String(result["evidenceNote"])).toMatch(/evidence capture failed/);
    expect(result["evidence"]).toBeUndefined();
  });

  it("warns when the foreground app changed between the reading and the press", async () => {
    const { system } = tapRecorder(snapshotOf(), {
      async currentWindow() {
        return { package: "com.tencent.mm", raw: "" };
      },
    });
    const result = await run({ query: SEARCH_LABEL, do: "tap" }, system);
    expect(String(result["warning"])).toContain("com.tencent.mm");
  });

  it("is as strict as the other pressing tool: asked every time, never pre-granted", () => {
    const { system } = tapRecorder(snapshotOf());
    const tool = findTool(system);

    // A session-wide "always allow" must never be able to cover the next press.
    expect(tool.risk).toBe("system");
    expect(tool.alwaysAsk).toBe(true);
    // A press navigates; it is not itself a change. Consulted only inside a task the user
    // confirmed as read-only, which is what "read my playlist" needs to run unprompted.
    expect(tool.mutates).toBe(false);
  });

  it("does not spend evidence quality on a mere search", async () => {
    // `find` changes nothing, so it must not capture at all -- and when it does tap, the
    // evidence uses the same budget as every other evidence shot.
    const { system } = tapRecorder(snapshotOf());
    await run({ query: SEARCH_LABEL }, system);
    expect(SCREEN_DEFAULTS.evidenceQuality).toBeGreaterThan(0);
  });
});
