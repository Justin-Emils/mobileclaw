import { describe, expect, it } from "vitest";
import { createAutomationTools } from "@mobileclaw/capabilities";
import {
  Agent,
  KeyValueConversationStore,
  MemoryKeyValueStore,
  MockProvider,
  PermissionGate,
  ToolRegistry,
  type AutomationService,
  type SystemService,
  type TranscriptEntry,
} from "@mobileclaw/core";

/**
 * The join that the unit tests do not cover.
 *
 * "`screen_capture` returns a capture" and "the transcript picks up an `evidence` key"
 * were each tested separately, and the defect lived exactly between them: the tool
 * returned a bare capture, `evidenceOf` looked only for an explicit `evidence` key, and
 * nothing drove the two together. The result was that the screenshot never reached the
 * card that exists to display it — the whole point of taking it.
 *
 * So this drives the *real* tool through the *real* agent loop and reads the persisted
 * conversation, which is what the user actually ends up seeing. A test that stubs
 * either half would have passed while the feature was broken.
 */

const CAPTURE = { path: "file:///workspaces/conv_1/shot.jpg", width: 720, height: 1600 };
const BLOCKED_NOTE = "possibly protected content or a system restriction";
const EVIDENCE_FAILURE = "FLAG_SECURE";

/** A working screen backend, with any single method replaceable. */
function screenSystem(over: Partial<AutomationService> = {}): SystemService {
  return {
    kind: "stub",
    async openUrl() {},
    async openApp() {},
    automation: {
      kind: "shizuku",
      async status() {
        return { available: true, backend: "shizuku", uid: 2000 };
      },
      async captureScreen() {
        return { ...CAPTURE };
      },
      async tap() {},
      async scroll() {},
      async typeText() {
        return { method: "input" as const };
      },
      async currentWindow() {
        return { package: "com.tencent.mm", raw: "" };
      },
      ...over,
    },
  };
}

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

/** Run one turn that calls `toolName` once, then read the persisted tool entry. */
async function runTool(
  toolName: string,
  input: Record<string, unknown>,
  system: SystemService,
): Promise<ToolEntry | undefined> {
  const store = new KeyValueConversationStore(new MemoryKeyValueStore());
  const provider = new MockProvider({
    turns: [{ toolCalls: [{ id: "c1", name: toolName, input }] }, "done"],
  });
  const agent = new Agent({
    provider,
    registry: new ToolRegistry().registerAll(createAutomationTools({ system })),
    // These tools declare `neverRemember`, so a prompt is unavoidable; the stub answers it.
    permissions: new PermissionGate({ defaultMode: "allow" }, async () => ({ approved: true })),
    store,
  });

  const result = await agent.run({ input: "look at the screen" });
  const entries = (await store.load(result.conversationId))?.entries ?? [];
  return entries.find(
    (item): item is ToolEntry => item.kind === "tool" && item.name === toolName,
  );
}

describe("screen evidence reaches the transcript", () => {
  it("carries the capture that screen_capture just took", async () => {
    const entry = await runTool("screen_capture", {}, screenSystem());

    expect(entry?.status).toBe("ok");
    expect(entry?.evidence).toEqual(CAPTURE);
  });

  it("also carries the evidence an action tool took afterwards", async () => {
    // The other half of the picture: screen_tap captures after acting, so the user sees
    // the result of the press, not just that a press happened.
    const entry = await runTool("screen_tap", { target: "search box", x: 10, y: 20 }, screenSystem());

    expect(entry?.status).toBe("ok");
    expect(entry?.evidence).toEqual(CAPTURE);
  });

  it("keeps the blocked-frame note, so a black picture is explained rather than shown bare", async () => {
    const system = screenSystem({
      async captureScreen() {
        return { ...CAPTURE, note: BLOCKED_NOTE };
      },
    });

    const entry = await runTool("screen_capture", {}, system);

    expect(entry?.evidence?.note).toBe(BLOCKED_NOTE);
  });

  it("records why the evidence is missing instead of reporting a bare success", async () => {
    const system = screenSystem({
      async captureScreen() {
        throw new Error(EVIDENCE_FAILURE);
      },
    });

    const entry = await runTool("screen_tap", { target: "confirm", x: 1, y: 2 }, system);

    // The press did happen — `tap()` was called and returned — so the entry is a
    // success. What the user loses is the picture, and that has to be said out loud.
    expect(entry?.status).toBe("ok");
    expect(entry?.evidence).toBeUndefined();
    expect(entry?.evidenceNote).toMatch(/evidence capture failed/);
    expect(entry?.evidenceNote).toContain(EVIDENCE_FAILURE);
  });

  it("still shows the model where the capture went, so the next tap can reference it", async () => {
    // screen_tap takes a `screenshotPath`; without the path in the model-visible output
    // the picker would have nothing to display.
    const entry = await runTool("screen_capture", {}, screenSystem());

    expect(entry?.output).toContain(CAPTURE.path);
    expect(entry?.output).toContain(String(CAPTURE.width));
  });
});

describe("a malformed capture is not presented as evidence", () => {
  // A bare `typeof value === "number"` accepted all of these, so a card could render a
  // broken image as though it were the verified record of an action. `NaN` is the
  // nastiest: it survives as a number and JSON turns it into `null` on the way to disk.
  const cases: [string, Record<string, unknown>][] = [
    ["a non-finite width", { width: Number.NaN }],
    ["a zero height", { height: 0 }],
    ["a negative width", { width: -720 }],
    ["an empty path", { path: "" }],
  ];

  for (const [label, replacement] of cases) {
    it(`refuses ${label}`, async () => {
      const system = screenSystem({
        async captureScreen() {
          return { ...CAPTURE, ...replacement } as never;
        },
      });

      const entry = await runTool("screen_capture", {}, system);

      // The call itself succeeded and the model still got its output; what must not
      // happen is the user being shown a picture that is not one.
      expect(entry?.status).toBe("ok");
      expect(entry?.evidence).toBeUndefined();
    });
  }
});
