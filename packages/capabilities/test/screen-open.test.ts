import { describe, expect, it } from "vitest";
import { createOpenTools } from "@mobileclaw/capabilities";
import {
  CoreError,
  type AnyToolDefinition,
  type AutomationService,
  type ScreenBounds,
  type ScreenNode,
  type ScreenSnapshot,
  type SystemService,
} from "@mobileclaw/core";

/**
 * Opening a named person, safely.
 *
 * This is the highest-consequence tool in the project: what it presses decides which human being
 * receives a message, and a message cannot be recalled. So the tests here are mostly about
 * *refusing* — the tool has to be useful when the answer is "I cannot tell which one you mean",
 * and that behaviour is invisible from the happy path.
 *
 * Three rules, each attacked directly:
 *   1. Several distinct pressable answers -> refuse and list them, never pick.
 *   2. `expect` is required, and a tap that did not produce it is reported as unverified.
 *   3. A target that already has its own label on screen is not tapped again.
 */

const TARGET = "\u5f20\u4e09"; // 张三
const IMPOSTOR = "\u5f20\u4e09\u4e30"; // 张三丰 — a different person
const GROUP = "\u5f20\u4e09\u7684\u7fa4"; // 张三的群
const UNRELATED = "\u674e\u56db";

const DISPLAY = { width: 1080, height: 2400 } as const;
const CALL = { signal: new AbortController().signal, callId: "c1" };

/** Bounds the fixture can trust, so a wrong centre cannot be agreed with twice. */
function bounds(centerX: number, centerY: number): ScreenBounds {
  return { left: centerX - 10, top: centerY - 10, right: centerX + 10, bottom: centerY + 10, width: 20, height: 20, centerX, centerY };
}

function node(over: Partial<ScreenNode> & { index: number }): ScreenNode {
  return { text: "x", ...over };
}

/** A search-results screen: several rows, each pressable. */
function resultsScreen(): ScreenSnapshot {
  return {
    nodes: [
      node({ index: 0, text: TARGET, clickable: true, bounds: bounds(540, 400) }),
      node({ index: 1, text: IMPOSTOR, clickable: true, bounds: bounds(540, 500) }),
      node({ index: 2, text: GROUP, clickable: true, bounds: bounds(540, 600) }),
      node({ index: 3, text: UNRELATED, clickable: true, bounds: bounds(540, 700) }),
    ],
    total: 4,
    width: DISPLAY.width,
    height: DISPLAY.height,
    package: "com.tencent.mobileqq",
  };
}

/** The chat that opened, titled with the name and showing a message. */
function chatScreen(withExpectedText: boolean): ScreenSnapshot {
  return {
    nodes: [
      node({ index: 0, text: TARGET, clickable: false }),
      node({
        index: 1,
        text: withExpectedText ? "last message about the harbour" : "something else entirely",
      }),
    ],
    total: 2,
    width: DISPLAY.width,
    height: DISPLAY.height,
    package: "com.tencent.mobileqq",
  };
}

/**
 * A chat that is already open: the title stands among content.
 *
 * Three nodes on purpose. The title check needs to tell "this page is the target's" from "a result
 * row that merely cannot be pressed", and the thing that separates them is that a title sits
 * among other content while an unpressed row stands alone.
 */
function alreadyOpenChat(): ScreenSnapshot {
  return {
    nodes: [
      node({ index: 0, text: TARGET, clickable: false }),
      node({ index: 1, text: "harbour" }),
      node({ index: 2, text: "are you free tomorrow" }),
    ],
    total: 3,
    width: DISPLAY.width,
    height: DISPLAY.height,
    package: "com.tencent.mobileqq",
  };
}

/** A screen about somebody else entirely, so the target really is absent. */
function someoneElseScreen(): ScreenSnapshot {
  return {
    nodes: [node({ index: 0, text: UNRELATED, clickable: true, bounds: bounds(540, 400) })],
    total: 1,
    width: DISPLAY.width,
    height: DISPLAY.height,
  };
}

/** A backend that answers each reading in turn, and records what was pressed. */
function screenSystem(readings: ScreenSnapshot[], over: Partial<AutomationService> = {}) {
  const taps: Array<{ x: number; y: number }> = [];
  let index = 0;
  const automation: AutomationService = {
    kind: "shizuku",
    async status() {
      return { available: true, backend: "shizuku", uid: 2000 };
    },
    async captureScreen() {
      return { path: "file:///w/shot.jpg", width: 720, height: 1600 };
    },
    async tap(x, y) {
      taps.push({ x, y });
    },
    async scroll() {},
    async typeText() {
      return { method: "input" as const };
    },
    async currentWindow() {
      return { package: "com.tencent.mobileqq", raw: "" };
    },
    async readScreen() {
      const reading = readings[Math.min(index, readings.length - 1)] ?? { nodes: [], total: 0 };
      index += 1;
      return reading;
    },
    ...over,
  };
  const system: SystemService = { kind: "stub", async openUrl() {}, async openApp() {}, automation };
  return { system, taps, readingsSeen: () => index };
}

function toolOf(system: SystemService): AnyToolDefinition {
  const tool = createOpenTools({ system }).find((entry) => entry.name === "screen_open_item");
  if (!tool) throw new Error("no screen_open_item tool");
  return tool;
}

async function open(
  system: SystemService,
  input: { target: string; expect: string; query?: string; mode?: "contains" | "exact" | "regex" },
): Promise<Record<string, unknown>> {
  return (await toolOf(system).execute(input as never, CALL as never)) as Record<string, unknown>;
}

describe("screen_open_item", () => {
  it("refuses to choose when several different people answer the name", async () => {
    // The whole reason the tool exists. "contains 张三" matches 张三, 张三丰 and 张三的群; picking
    // the shortest label would send a message to whichever of them that happened to be.
    const { system, taps } = screenSystem([resultsScreen()]);
    const result = await open(system, { target: TARGET, expect: TARGET, mode: "contains" });

    expect(result["verdict"]).toBe("ambiguous");
    expect(result["candidates"]).toEqual([TARGET, IMPOSTOR, GROUP]);
    // Nothing was pressed, and the model is told not to proceed.
    expect(taps).toEqual([]);
    expect(String(result["mustNotProceed"])).toMatch(/Do not type or send/);
  });

  it("opens when exactly one distinct label answers, and confirms the page", async () => {
    const single = { ...resultsScreen(), nodes: [node({ index: 0, text: TARGET, clickable: true, bounds: bounds(540, 400) })] };
    const { system, taps } = screenSystem([single, chatScreen(true)]);
    const result = await open(system, { target: TARGET, expect: "harbour", mode: "exact" });

    expect(result["verdict"]).toBe("opened");
    expect(result["opened"]).toBe(true);
    // 540/1080 and 400/2400 — the fraction a tap takes, not the raw pixel centre.
    expect(taps).toEqual([{ x: 540 / 1080, y: 400 / 2400 }]);
    expect(result).not.toHaveProperty("mustNotProceed");
  });

  it("reports unverified when the page that opened is not the expected one", async () => {
    // A tap that landed somewhere real but wrong. Reporting success here is the failure mode that
    // ends with a message to a stranger.
    const single = { ...resultsScreen(), nodes: [node({ index: 0, text: TARGET, clickable: true, bounds: bounds(540, 400) })] };
    const { system } = screenSystem([single, chatScreen(false)]);
    const result = await open(system, { target: TARGET, expect: "harbour", mode: "exact" });

    expect(result["verdict"]).toBe("unverified");
    expect(result["opened"]).toBe(false);
    expect(String(result["detail"])).toMatch(/NOT on the screen afterwards/);
    expect(String(result["mustNotProceed"])).toMatch(/Do not type or send/);
  });

  it("does not press anything when the name is not on screen", async () => {
    const { system, taps } = screenSystem([someoneElseScreen()]);
    const result = await open(system, { target: TARGET, expect: TARGET, mode: "exact" });

    expect(result["verdict"]).toBe("not-found");
    expect(taps).toEqual([]);
  });

  it("distinguishes 'nothing readable' from 'not there'", async () => {
    // A protected or empty window must not be reported as the name being absent, or the model
    // keeps trying other spellings of a person who is right there.
    const note = "the screen could not be read: FLAG_SECURE";
    const { system } = screenSystem([{ nodes: [], total: 0, note }]);
    const result = await open(system, { target: TARGET, expect: TARGET });

    expect(result["verdict"]).toBe("not-found");
    expect(result["detail"]).toBe(note);
  });

  it("does not re-tap a target that already has its own page open", async () => {
    // Rule 3: tapping a name inside the open conversation can open a profile or start a different
    // conversation. If the title already stands among the chat's content, the work is done.
    const { system, taps } = screenSystem([alreadyOpenChat()]);
    const result = await open(system, { target: TARGET, expect: "harbour", mode: "exact" });

    expect(result["verdict"]).toBe("already-open");
    expect(taps).toEqual([]);
  });

  it("does not mistake an unpressed result row for an already-open page", async () => {
    // The mirror image of the rule above, and the more dangerous direction: a lone non-pressable
    // label is a row that cannot be pressed, not a title. Reporting "already open" here would claim
    // a conversation was opened when nothing was.
    const loneRow = { ...resultsScreen(), nodes: [node({ index: 0, text: TARGET, clickable: false })] };
    const { system, taps } = screenSystem([loneRow]);
    const result = await open(system, { target: TARGET, expect: TARGET, mode: "exact" });

    expect(result["verdict"]).toBe("not-pressable");
    expect(taps).toEqual([]);
  });

  it("refuses a match that cannot be pressed", async () => {
    // A non-pressable label is a heading, not a row. Pressing its centre would hit nothing, or the
    // thing underneath it.
    const heading = { ...resultsScreen(), nodes: [node({ index: 0, text: TARGET })] };
    const { system, taps } = screenSystem([heading]);
    const result = await open(system, { target: TARGET, expect: TARGET, mode: "exact" });

    expect(result["verdict"]).toBe("not-pressable");
    expect(taps).toEqual([]);
  });

  it("refuses a disabled match", async () => {
    const disabled = {
      ...resultsScreen(),
      nodes: [node({ index: 0, text: TARGET, clickable: true, disabled: true, bounds: bounds(540, 400) })],
    };
    const { system, taps } = screenSystem([disabled]);
    const result = await open(system, { target: TARGET, expect: TARGET, mode: "exact" });

    expect(result["verdict"]).toBe("not-pressable");
    expect(taps).toEqual([]);
  });

  it("uses `query` to search and `target` to verify, when they differ", async () => {
    // Typing a nickname but opening the full name is the common real case.
    const screen = {
      ...resultsScreen(),
      nodes: [node({ index: 0, text: "\u5f20\u4e09\uff08\u540c\u4e8b\uff09", clickable: true, bounds: bounds(540, 400) })],
    };
    const { system, taps } = screenSystem([screen, chatScreen(true)]);
    const result = await open(system, {
      target: "\u5f20\u4e09\uff08\u540c\u4e8b\uff09",
      query: "\u5f20\u4e09",
      expect: "harbour",
    });

    expect(result["verdict"]).toBe("opened");
    expect(taps).toHaveLength(1);
  });

  it("cannot be silenced by a read-only task scope", () => {
    // A plain tap declares `mutates: false` so a read-only task does not prompt per swipe. This
    // one can end with a message delivered, so it must never carry that declaration — otherwise a
    // confirmed "read my playlist" would let it press through a contact list unprompted.
    const { system } = screenSystem([resultsScreen()]);
    const tool = toolOf(system);
    expect(tool.risk).toBe("system");
    expect(tool.alwaysAsk).toBe(true);
    expect(tool.mutates).not.toBe(false);
  });

  it("says the backend is missing instead of failing vaguely", async () => {
    const system: SystemService = { kind: "stub", async openUrl() {}, async openApp() {} };
    await expect(
      toolOf(system).execute({ target: TARGET, expect: TARGET } as never, CALL as never),
    ).rejects.toThrow(CoreError);
  });
});
