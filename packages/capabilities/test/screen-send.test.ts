import { describe, expect, it } from "vitest";
import { createSendTools } from "@mobileclaw/capabilities";
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
 * Sending, and refusing to send.
 *
 * This is the last irreversible action in the project, so the tests are weighted towards the
 * refusals: a press that should not have happened cannot be undone by a passing test suite. The
 * one that matters most is the race — the recipient confirmed, the text ready, and the screen
 * changing before the press. That is the only window where a message can reach the wrong person,
 * and it is invisible unless a test deliberately opens it.
 */

const TARGET = "\u5f20\u4e09"; // 张三
const OTHER = "\u674e\u56db"; // 李四
const MESSAGE = "see you at eight";
const EXPECT = "eight";
const SEND_LABEL = "\u53d1\u9001"; // 发送

const DISPLAY = { width: 1080, height: 2400 } as const;
const CALL = { signal: new AbortController().signal, callId: "c1" };

function bounds(centerX: number, centerY: number): ScreenBounds {
  return { left: centerX - 10, top: centerY - 10, right: centerX + 10, bottom: centerY + 10, width: 20, height: 20, centerX, centerY };
}

function node(over: Partial<ScreenNode> & { index: number }): ScreenNode {
  return { text: "x", ...over };
}

/** A conversation: a non-pressable title, the composed text, and the send control. */
function chatScreen(over: { title?: string; text?: string; send?: string; sendDisabled?: boolean } = {}): ScreenSnapshot {
  const nodes: ScreenNode[] = [
    node({ index: 0, text: over.title ?? TARGET, clickable: false }),
    node({ index: 1, text: over.text ?? MESSAGE }),
  ];
  if (over.send !== undefined) {
    nodes.push(
      node({
        index: 2,
        text: over.send,
        clickable: true,
        ...(over.sendDisabled ? { disabled: true } : {}),
        bounds: bounds(1000, 2300),
      }),
    );
  }
  return { nodes, total: nodes.length, width: DISPLAY.width, height: DISPLAY.height, package: "com.tencent.mobileqq" };
}

/** A backend answering each reading in turn, recording every press and every typed string. */
function screenSystem(readings: ScreenSnapshot[], over: Partial<AutomationService> = {}) {
  const taps: Array<{ x: number; y: number }> = [];
  const typed: string[] = [];
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
    async typeText(text) {
      typed.push(text);
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
  return { system, taps, typed, reads: () => index };
}

function toolOf(system: SystemService): AnyToolDefinition {
  const tool = createSendTools({ system }).find((entry) => entry.name === "screen_send_message");
  if (!tool) throw new Error("no screen_send_message tool");
  return tool;
}

async function send(
  system: SystemService,
  input: { target: string; expect: string; message?: string; sendLabel: string; mode?: "contains" | "exact" | "regex" },
): Promise<Record<string, unknown>> {
  return (await toolOf(system).execute(input as never, CALL as never)) as Record<string, unknown>;
}

/** The three readings a successful send makes: before typing, after typing, then final. */
function happyPathReadings() {
  // Each one carries the send control: the final reading is the one that finds and presses it.
  return [chatScreen({ send: SEND_LABEL }), chatScreen({ send: SEND_LABEL }), chatScreen({ send: SEND_LABEL })];
}

describe("screen_send_message", () => {
  it("types, confirms the text landed, re-reads the recipient, then presses", async () => {
    const { system, taps, typed } = screenSystem(happyPathReadings());
    const result = await send(system, { target: TARGET, expect: EXPECT, message: MESSAGE, sendLabel: SEND_LABEL });

    expect(result["verdict"]).toBe("sent");
    expect(result["sent"]).toBe(true);
    expect(typed).toEqual([MESSAGE]);
    // One press, at the send control's centre expressed as a fraction of the display.
    expect(taps).toEqual([{ x: 1000 / 1080, y: 2300 / 2400 }]);
    expect(result).not.toHaveProperty("nothingWasSent");
  });

  it("refuses to type anything when the wrong conversation is in front", async () => {
    const { system, taps, typed } = screenSystem([chatScreen({ title: OTHER })]);
    const result = await send(system, { target: TARGET, expect: EXPECT, message: MESSAGE, sendLabel: SEND_LABEL });

    expect(result["verdict"]).toBe("refused");
    expect(typed).toEqual([]);
    expect(taps).toEqual([]);
    expect(result["nothingWasSent"]).toBe(true);
  });

  it("refuses when the typed text did not land, and presses nothing", async () => {
    // A read-only field, or one that lost focus. The keystroke was delivered; the text is not there.
    const { system, taps } = screenSystem([
      chatScreen(),
      chatScreen({ text: "something else entirely" }),
      chatScreen(),
    ]);
    const result = await send(system, { target: TARGET, expect: EXPECT, message: MESSAGE, sendLabel: SEND_LABEL });

    expect(result["verdict"]).toBe("refused");
    expect(String(result["detail"])).toMatch(/does not appear on screen/);
    expect(taps).toEqual([]);
  });

  it("refuses when the conversation does not show the expected content", async () => {
    // The content check: right person, but the message does not belong to them.
    const { system, taps } = screenSystem([chatScreen(), chatScreen(), chatScreen({ text: MESSAGE })]);
    const result = await send(system, { target: TARGET, expect: "account number 4451", message: MESSAGE, sendLabel: SEND_LABEL });

    expect(result["verdict"]).toBe("refused");
    expect(String(result["detail"])).toMatch(/does not show/);
    expect(taps).toEqual([]);
  });

  it("refuses to press when the recipient changed between readying and sending", async () => {
    // THE case, and it has to be staged precisely or it proves nothing: the content check must
    // *pass* (so the run reaches the final look) and only the last reading may differ. An earlier
    // version of this test put the change on the third reading, which the content check caught —
    // so the guard under test was never reached, and a mutation that removed it still passed.
    const { system, taps, reads } = screenSystem([
      chatScreen({ send: SEND_LABEL }), // recipient check: right conversation
      chatScreen({ send: SEND_LABEL }), // text landed and content matches
      chatScreen({ title: OTHER, send: SEND_LABEL }), // final look: it moved
    ]);
    const result = await send(system, { target: TARGET, expect: EXPECT, message: MESSAGE, sendLabel: SEND_LABEL });

    expect(result["verdict"]).toBe("refused");
    // Named specifically, so a failure at any *other* step cannot be mistaken for this one.
    expect(String(result["detail"])).toMatch(/no longer the page in front/);
    expect(result["sent"]).not.toBe(true);
    expect(taps).toEqual([]);
    // Four readings: recipient, text landed, content, and the final look. Asserting the count is
    // what makes removing that last look observable.
    expect(reads()).toBe(4);
  });

  it("does not press when the send control is absent, and says how to name it", async () => {
    const { system, taps } = screenSystem([chatScreen(), chatScreen(), chatScreen()]);
    const result = await send(system, { target: TARGET, expect: EXPECT, message: MESSAGE, sendLabel: SEND_LABEL });

    expect(result["verdict"]).toBe("refused");
    expect(String(result["detail"])).toMatch(/no pressable control/);
    expect(String(result["detail"])).toMatch(/Pass the exact label/);
    expect(taps).toEqual([]);
  });

  it("refuses when two different controls answer the send label", async () => {
    // Two candidates means pressing one is a guess, and the guess lands in a conversation with a
    // person in it. Stopping costs a question; guessing costs a message to the wrong human.
    const twoButtons: ScreenSnapshot = {
      nodes: [
        node({ index: 0, text: TARGET, clickable: false }),
        node({ index: 1, text: MESSAGE }),
        node({ index: 2, text: SEND_LABEL, clickable: true, bounds: bounds(1000, 2300) }),
        node({ index: 3, text: `${SEND_LABEL} to all`, clickable: true, bounds: bounds(1000, 2200) }),
      ],
      total: 4,
      width: DISPLAY.width,
      height: DISPLAY.height,
    };
    const { system, taps } = screenSystem([twoButtons, twoButtons, twoButtons]);
    const result = await send(system, { target: TARGET, expect: EXPECT, message: MESSAGE, sendLabel: SEND_LABEL });

    expect(result["verdict"]).toBe("refused");
    expect(String(result["detail"])).toMatch(/matches 2 different controls/);
    expect(taps).toEqual([]);
  });

  it("refuses a disabled send control", async () => {
    const disabled = chatScreen({ send: SEND_LABEL, sendDisabled: true });
    const { system, taps } = screenSystem([disabled, disabled, disabled]);
    const result = await send(system, { target: TARGET, expect: EXPECT, message: MESSAGE, sendLabel: SEND_LABEL });

    expect(result["verdict"]).toBe("refused");
    expect(String(result["detail"])).toMatch(/disabled/);
    expect(taps).toEqual([]);
  });

  it("sends already-composed text without typing, when no message is given", async () => {
    // The "check it and send it" case: the user typed the message themselves.
    const withText = chatScreen({ send: SEND_LABEL });
    const { system, taps, typed, reads } = screenSystem([withText, withText, withText]);
    const result = await send(system, { target: TARGET, expect: EXPECT, sendLabel: SEND_LABEL });

    expect(result["verdict"]).toBe("sent");
    expect(typed).toEqual([]);
    // Three readings still: the recipient, the content assertion, and the last look before the
    // press. Nothing was typed, but the content check remains a separate look at a separate
    // moment — merging it with the final check would mean asserting the text and reading the
    // recipient off one snapshot, which is exactly the coupling this tool exists to avoid.
    expect(reads()).toBe(3);
    expect(taps).toHaveLength(1);
  });

  it("distinguishes 'nothing readable' from 'wrong conversation'", async () => {
    const note = "the window is FLAG_SECURE, so nothing readable was published";
    const { system } = screenSystem([{ nodes: [], total: 0, note }]);
    const result = await send(system, { target: TARGET, expect: EXPECT, message: MESSAGE, sendLabel: SEND_LABEL });

    expect(result["verdict"]).toBe("refused");
    expect(result["detail"]).toBe(note);
  });

  it("refuses from the first reading when a different app is already in front", async () => {
    // Asked before typing as well as before pressing. The caller naming the expected package is the
    // only fact that survives a gap in the run — and a gap is the norm here, not the exception:
    // this app is meant to be behind the conversation, so time passes between steps.
    const wrongApp = { ...chatScreen({ send: SEND_LABEL }), package: "com.tencent.mm" };
    const { system, taps, typed } = screenSystem([wrongApp, wrongApp, wrongApp]);
    const tool = createSendTools({ system }).find((entry) => entry.name === "screen_send_message")!;
    const result = (await tool.execute(
      {
        target: TARGET,
        expect: EXPECT,
        message: MESSAGE,
        sendLabel: SEND_LABEL,
        expectedPackage: "com.tencent.mobileqq",
      } as never,
      CALL as never,
    )) as Record<string, unknown>;

    expect(result["verdict"]).toBe("refused");
    expect(String(result["detail"])).toMatch(/showing com\.tencent\.mm/);
    // Refused before anything was typed: the text would have gone to the wrong app.
    expect(typed).toEqual([]);
    expect(taps).toEqual([]);
  });

  it("refuses at the last moment when the app changes between readying and pressing", async () => {
    // The case that matters most, and the one a start-of-run check cannot catch: every earlier
    // reading was from the right app and the recipient was confirmed, and then the screen moved.
    // Staged so the change lands on the *final* reading, which is the one immediately before the
    // press — if it landed earlier, the recipient check would refuse first and this would prove
    // nothing about the guard under test.
    const readings = [
      chatScreen({ send: SEND_LABEL }),
      chatScreen({ send: SEND_LABEL }),
      chatScreen({ send: SEND_LABEL }),
      chatScreen({ title: TARGET, send: SEND_LABEL }),
      { ...chatScreen({ send: SEND_LABEL }), package: "com.tencent.mm" }, // the final look
    ];
    const { system, taps } = screenSystem(readings);
    const tool = createSendTools({ system }).find((entry) => entry.name === "screen_send_message")!;
    const result = (await tool.execute(
      {
        target: TARGET,
        expect: EXPECT,
        message: MESSAGE,
        sendLabel: SEND_LABEL,
        expectedPackage: "com.tencent.mobileqq",
      } as never,
      CALL as never,
    )) as Record<string, unknown>;

    expect(result["verdict"]).toBe("refused");
    expect(String(result["detail"])).toMatch(/showing com\.tencent\.mm/);
    expect(result["sent"]).not.toBe(true);
    expect(taps).toEqual([]);
  });

  it("refuses when the final reading came from a different app than expected", async () => {
    // The strongest check in the tool, and the one that answers the real question. The recipient
    // check can only prove that *some* screen shows the expected name. This proves it is the right
    // app's screen — which is the difference between a reading and evidence.
    const { system, taps } = screenSystem(happyPathReadings());
    const tool = createSendTools({ system }).find((entry) => entry.name === "screen_send_message")!;
    const result = (await tool.execute(
      {
        target: TARGET,
        expect: EXPECT,
        message: MESSAGE,
        sendLabel: SEND_LABEL,
        expectedPackage: "com.tencent.mm",
      } as never,
      CALL as never,
    )) as Record<string, unknown>;

    // The fixture's readings are from QQ; the caller expected WeChat.
    expect(result["verdict"]).toBe("refused");
    expect(String(result["detail"])).toMatch(/showing com\.tencent\.mobileqq/);
    expect(taps).toEqual([]);
  });

  it("sends when the final reading is from the expected app", async () => {
    const { system, taps } = screenSystem(happyPathReadings());
    const tool = createSendTools({ system }).find((entry) => entry.name === "screen_send_message")!;
    const result = (await tool.execute(
      {
        target: TARGET,
        expect: EXPECT,
        message: MESSAGE,
        sendLabel: SEND_LABEL,
        expectedPackage: "com.tencent.mobileqq",
      } as never,
      CALL as never,
    )) as Record<string, unknown>;

    expect(result["verdict"]).toBe("sent");
    expect(taps).toHaveLength(1);
  });

  it("does not refuse on silence when the backend cannot name the package", async () => {
    // "Could not tell" is not "wrong". Refusing here would take sending away from every device
    // whose reading cannot report a package — a real cost for no safety.
    const silent = {
      nodes: [
        node({ index: 0, text: TARGET, clickable: false }),
        node({ index: 1, text: MESSAGE }),
        node({ index: 2, text: SEND_LABEL, clickable: true, bounds: bounds(1000, 2300) }),
      ],
      total: 3,
      width: DISPLAY.width,
      height: DISPLAY.height,
      // no `package`
    };
    const { system, taps } = screenSystem([silent, silent, silent]);
    const tool = createSendTools({ system }).find((entry) => entry.name === "screen_send_message")!;
    const result = (await tool.execute(
      {
        target: TARGET,
        expect: EXPECT,
        message: MESSAGE,
        sendLabel: SEND_LABEL,
        expectedPackage: "com.tencent.mm",
      } as never,
      CALL as never,
    )) as Record<string, unknown>;

    expect(result["verdict"]).toBe("sent");
    expect(taps).toHaveLength(1);
  });

  it("tells the model not to retry blindly after a refusal", async () => {
    // A refusal read as a soft failure invites the same call again, which is the opposite of what
    // should happen next.
    const { system } = screenSystem([chatScreen({ title: OTHER })]);
    const result = await send(system, { target: TARGET, expect: EXPECT, message: MESSAGE, sendLabel: SEND_LABEL });
    expect(String(result["mustNotRetryBlindly"])).toMatch(/Do not repeat the same call/);
  });

  it("carries the strongest permission posture, and no scope may relax it", () => {
    // `alwaysAsk` refuses the allowlist, `neverRemember` refuses the conversation allowlist, and
    // the absence of `mutates: false` is what stops a confirmed read-only task from letting it
    // press send without asking. All three are load-bearing.
    const { system } = screenSystem([chatScreen()]);
    const tool = toolOf(system);
    expect(tool.risk).toBe("system");
    expect(tool.alwaysAsk).toBe(true);
    expect(tool.neverRemember).toBe(true);
    expect(tool.mutates).not.toBe(false);
  });

  it("says the backend is missing instead of failing vaguely", async () => {
    const system: SystemService = { kind: "stub", async openUrl() {}, async openApp() {} };
    await expect(
      toolOf(system).execute(
        { target: TARGET, expect: EXPECT, message: MESSAGE, sendLabel: SEND_LABEL } as never,
        CALL as never,
      ),
    ).rejects.toThrow(CoreError);
  });
});
