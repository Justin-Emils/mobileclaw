import { z } from "zod";
import {
  CoreError,
  SCREEN_DEFAULTS,
  type AnyToolDefinition,
  type AutomationService,
  type SystemService,
} from "@mobileclaw/core";
import { available, requireAvailable, unavailable } from "../availability";

/** How often `screen_wait` re-reads the foreground app, and how long it waits by default. */
const WAIT_POLL_MS = 400;
const WAIT_DEFAULT_MS = 10_000;

/**
 * Screen automation through a privileged backend (Shizuku, shell uid 2000).
 *
 * Every tool that changes the screen declares `neverRemember`, not merely
 * `alwaysAsk`: `alwaysAsk` still yields to the "always allow in this conversation"
 * button, which is remembered on the conversation and would let one approval cover
 * every later press.
 *
 * The two probes are exempt and carry `risk: "read"`, matching `system_apps`, which
 * also reports device state without prompting.
 *
 * Nothing here sees through `FLAG_SECURE`. A blocked capture comes back black and
 * says so — it is never reported as a blank screen, because stating "the folder is
 * empty" as fact when it is really a permission problem is the failure mode the
 * storage tools already had to be fixed for.
 *
 * The model cannot see the screen, so it cannot invent a coordinate. `screen_tap`
 * therefore takes its point from the user, chosen on a capture; `screen_scroll` asks
 * only for a direction and lets the backend resolve the geometry against the display.
 *
 * Descriptions and hints are English because everything the model reads in this
 * package is; the wording a person sees is added in the app layer.
 */
export function createAutomationTools(deps: { system: SystemService }): AnyToolDefinition[] {
  const backend = (): AutomationService | undefined => deps.system.automation;

  async function requireScreen(kind: string): Promise<AutomationService> {
    const automation = backend();
    if (!automation) {
      throw new CoreError("E_TOOL_FAILED", "screen automation is unavailable on this platform", {
        hint: "Screen automation needs a privileged backend, which only exists on Android.",
      });
    }
    const status = await automation.status();
    requireAvailable(
      kind,
      status.available
        ? available()
        : unavailable(status.reason ?? "screen automation is unavailable"),
      status.howTo,
    );
    return automation;
  }

  /**
   * Evidence for the action that just ran.
   *
   * Deliberately best-effort: the action already happened, so a failed capture must
   * not turn a successful press into a tool error. The user is still told the evidence
   * is missing rather than being shown a call that looks unconfirmed.
   */
  async function evidence(
    automation: AutomationService,
    ctx: { workspace?: string },
  ): Promise<{ evidence?: ScreenEvidence; evidenceNote?: string }> {
    try {
      const shot = await automation.captureScreen({
        quality: SCREEN_DEFAULTS.evidenceQuality,
        ...(ctx.workspace ? { destDir: ctx.workspace } : {}),
      });
      return {
        evidence: {
          path: shot.path,
          width: shot.width,
          height: shot.height,
          ...(shot.note ? { note: shot.note } : {}),
        },
      };
    } catch (error) {
      return {
        evidenceNote: `evidence capture failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const screenCurrent = {
    name: "screen_current",
    description:
      "Report which app is in the foreground. The values are parsed from Android debug output, so they are best effort: an empty result means 'could not tell', not 'nothing is open'. Check this before screen_tap to be sure the app you mean is actually in front.",
    input: z.object({}),
    risk: "read",
    async execute() {
      const automation = backend();
      if (!automation) {
        return {
          available: false,
          reason: "this platform has no screen backend",
          howTo: "Screen automation needs a privileged backend, which only exists on Android.",
        };
      }
      const status = await automation.status();
      if (!status.available) {
        return {
          available: false,
          reason: status.reason,
          howTo: status.howTo,
          backend: status.backend,
        };
      }
      const window = await automation.currentWindow();
      return { available: true, backend: automation.kind, uid: status.uid, ...window };
    },
  } satisfies AnyToolDefinition;

  const screenCapture = {
    name: "screen_capture",
    description:
      "Screenshot the device through the privileged backend and save the picture into this conversation. Take one before screen_tap so the user can choose the point on the picture. Windows that set FLAG_SECURE (banking apps, some password fields) come back black — the result says so, and that content cannot be read this way.",
    input: z.object({
      maxWidth: z.number().int().min(240).max(4096).optional(),
      quality: z.number().int().min(10).max(100).optional(),
    }),
    risk: "system",
    alwaysAsk: true,
    neverRemember: true,
    summarize: () => "screen capture",
    async execute(input: { maxWidth?: number; quality?: number }, ctx: { workspace?: string }) {
      const automation = await requireScreen("screen capture");
      const shot = await automation.captureScreen({
        ...(input.maxWidth !== undefined ? { maxWidth: input.maxWidth } : {}),
        ...(input.quality !== undefined ? { quality: input.quality } : {}),
        ...(ctx.workspace ? { destDir: ctx.workspace } : {}),
      });
      // The capture *is* the evidence here. The transcript only picks up an explicit
      // `evidence` key, so without this the picture would never reach the very card
      // that exists to show it — which is the whole point of taking it.
      return { ...shot, evidence: shot };
    },
  } satisfies AnyToolDefinition;

  const screenTap = {
    name: "screen_tap",
    description:
      "Press one point on the screen through the privileged backend. You cannot see the screen, so never invent coordinates: say what you are aiming at in `target` and let the user place the point on the capture. Coordinates are device pixels of the picture named by `screenshotPath`. Returns a screenshot of the result.",
    input: z.object({
      target: z.string().min(1).describe("What to press, for example the search box."),
      x: z.number().int().optional().describe("Filled in by the user picking a point on the capture."),
      y: z.number().int().optional(),
      screenshotPath: z.string().optional().describe("The capture the point was chosen on."),
    }),
    risk: "system",
    alwaysAsk: true,
    neverRemember: true,
    summarize: (input: { target: string }) => `tap ${input.target}`,
    async execute(
      input: { target: string; x?: number; y?: number; screenshotPath?: string },
      ctx: { workspace?: string },
    ) {
      if (input.x === undefined || input.y === undefined) {
        throw new CoreError("E_TOOL_FAILED", "no point was chosen for this tap", {
          hint: "The coordinate has to come from the user. Call screen_capture first, then let them place the point on the picture when the approval appears.",
        });
      }
      const automation = await requireScreen("screen tap");
      await automation.tap(input.x, input.y);
      return {
        target: input.target,
        x: input.x,
        y: input.y,
        ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
        ...(await evidence(automation, ctx)),
      };
    },
  } satisfies AnyToolDefinition;

  const screenScroll = {
    name: "screen_scroll",
    description:
      "Move through the current screen's content in one direction, through the privileged backend. `direction` is which way you want to travel through the content, so scrolling down means you will see what is below. Needs no coordinates — the backend resolves the geometry against the real display.",
    input: z.object({
      direction: z.enum(["up", "down", "left", "right"]).describe("Which way to travel through the content."),
      amount: z
        .number()
        .min(0.1)
        .max(1)
        .optional()
        .describe("How much of the screen to travel, as a fraction. Defaults to the platform's own step."),
    }),
    risk: "system",
    alwaysAsk: true,
    neverRemember: true,
    summarize: (input: { direction: string }) => `scroll ${input.direction}`,
    async execute(
      input: { direction: "up" | "down" | "left" | "right"; amount?: number },
      ctx: { workspace?: string },
    ) {
      const automation = await requireScreen("screen scrolling");
      await automation.scroll(input.direction, input.amount);
      return { direction: input.direction, ...(await evidence(automation, ctx)) };
    },
  } satisfies AnyToolDefinition;

  const screenType = {
    name: "screen_type",
    description:
      "Type text into whatever currently holds focus, through the privileged backend. Latin text is injected directly; Chinese cannot be, because Android's `input` command is ASCII-only, so it goes through the clipboard and a paste keystroke. The result reports which happened, because a paste replaces what the user had copied.",
    input: z.object({
      text: z.string().min(1).max(2000),
      screenshotPath: z.string().optional(),
    }),
    risk: "system",
    alwaysAsk: true,
    neverRemember: true,
    // Length, not the text. Whatever is typed already lands on the transcript entry,
    // and this summary is a second copy in the UI — the wrong place for a password.
    summarize: (input: { text: string }) => `type ${input.text.length} characters`,
    async execute(input: { text: string }, ctx: { workspace?: string }) {
      const automation = await requireScreen("screen typing");
      const result = await automation.typeText(input.text);
      return {
        method: result.method,
        length: input.text.length,
        ...(await evidence(automation, ctx)),
      };
    },
  } satisfies AnyToolDefinition;

  const screenWait = {
    name: "screen_wait",
    description:
      "Wait until the foreground app (and optionally a specific screen of it) matches, or until the timeout runs out. Polls the same best-effort source as screen_current, so it can report 'timed out' on a ROM whose debug output does not name the foreground app. Use it instead of assuming the app has finished loading.",
    input: z.object({
      package: z.string().optional().describe("Package id to wait for, e.g. com.tencent.mm."),
      activity: z.string().optional().describe("Substring of the activity name to wait for."),
      timeoutMs: z.number().int().min(100).max(60000).optional().default(WAIT_DEFAULT_MS),
    }),
    risk: "read",
    async execute(
      input: { package?: string; activity?: string; timeoutMs: number },
      ctx: { signal: AbortSignal },
    ) {
      const automation = await requireScreen("screen waiting");
      const deadline = Date.now() + input.timeoutMs;
      for (;;) {
        const window = await automation.currentWindow();
        const packageOk = !input.package || window.package === input.package;
        const activityOk = !input.activity || (window.activity ?? "").includes(input.activity);
        if (packageOk && activityOk) {
          return { matched: true, waitedMs: input.timeoutMs - (deadline - Date.now()), ...window };
        }
        if (Date.now() >= deadline) {
          return {
            matched: false,
            reason: "timed out before the screen matched",
            wanted: { package: input.package, activity: input.activity },
            ...window,
          };
        }
        await sleep(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())), ctx.signal);
      }
    },
  } satisfies AnyToolDefinition;

  return [screenCurrent, screenCapture, screenTap, screenScroll, screenType, screenWait];
}

interface ScreenEvidence {
  path: string;
  width: number;
  height: number;
  note?: string;
}

/** Cancellable sleep: a parked `screen_wait` must not outlive a cancelled run. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CoreError("E_CANCELLED", "cancelled while waiting for the screen"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CoreError("E_CANCELLED", "cancelled while waiting for the screen"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
