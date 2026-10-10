import { z } from "zod";
import {
  CoreError,
  type AnyToolDefinition,
  type AutomationService,
  type ScreenNode,
  type SystemService,
} from "@mobileclaw/core";
import { available, requireAvailable, unavailable } from "../availability";
import { screenActionAllowed } from "../foreground";
import {
  labelOf,
  matches,
  pressableCandidates,
  type MatchMode,
  MATCH_MODES,
  openLimits,
} from "../screen-match";

/**
 * Opening a named item, with the check that makes it safe to open a *person*.
 *
 * ## The failure this exists to prevent
 *
 * "Send this to 张三" taken literally means: search for 张三, tap the result, type the message,
 * press send. Every individual step can succeed perfectly while the whole thing is wrong,
 * because a search for a name returns several people and one of them gets tapped. The result is
 * a message delivered to the wrong human being, and **it cannot be recalled**.
 *
 * The three rules below are what turn that from a hope into a check.
 *
 * ## 1. Never choose between candidates
 *
 * If several *different* pressable elements answer the name, the tool **refuses and lists them**
 * instead of picking the shortest label. A person chooses; a heuristic does not. This is the one
 * place where stopping is strictly better than being helpful, because the cost of stopping is a
 * question and the cost of guessing is a message to a stranger.
 *
 * ## 2. The caller must say what the opened page will show
 *
 * `expect` is required, not optional. Tapping something is not evidence that the right thing
 * opened — a row may be a section header, a stale cached result, or the wrong duplicate. After
 * the tap the screen is read again and searched for `expect`; only then does the tool report
 * success. Making it optional would mean the honest path is the one nobody takes.
 *
 * ## 3. Already open means do not tap
 *
 * If the target is *already on screen as a label of its own* — a chat title, a detail header —
 * the tool reports that and does not tap. Tapping a name inside an open conversation can start a
 * different conversation, mention someone, or open a profile; "open the thing that is already
 * open" is a step that should not exist.
 */

/** What the tool decided about the screen it was given. */
export type OpenVerdict =
  | "already-open"
  | "opened"
  | "ambiguous"
  | "not-found"
  | "not-pressable"
  | "unverified";

export interface OpenOutcome {
  verdict: OpenVerdict;
  /** One line the model can act on, phrased for a reader. */
  detail: string;
  /** The label actually pressed, when something was pressed. */
  pressed?: string;
  /** Every distinct label that answered the name, when the choice was ambiguous. */
  candidates?: string[];
  /** The reading taken after the tap, when one was taken. */
  after?: { elements: number; package?: string };
}

/**
 * Decide and act, in one place, so the reading used for the decision and the reading used for
 * the check cannot come from different screens by accident.
 *
 * Kept separate from the tool definition because this is the part with the rules in it, and the
 * rules are what the tests have to attack.
 */
export async function openNamedItem(
  automation: AutomationService,
  input: { target: string; query?: string; expect: string; mode?: MatchMode },
): Promise<OpenOutcome> {
  const query = input.query ?? input.target;
  const mode = input.mode ?? "contains";

  const before = await automation.readScreen({});

  const answer = pressableCandidates(before.nodes, query, mode);

  if (answer.matches.length === 0) {
    return {
      verdict: "not-found",
      detail:
        before.note ??
        (before.nodes.length === 0
          ? `nothing readable on screen, so "${query}" could not be found`
          : `no element on screen says "${query}"`),
    };
  }

  // One distinct, pressable answer: that is the only case where pressing is the right move, so it
  // is checked before the two "do not press" verdicts below rather than after them.
  const distinct = [...new Set(answer.matches.map(labelOf))];
  const chosen = answer.chosen;
  const pressableNow = distinct.length === 1 && chosen?.clickable === true && chosen.disabled !== true;

  // Rule 3: the target already has a page of its own, so there is nothing to press.
  //
  // This is what separates two things that look identical in the tree — a **non-pressable node
  // carrying exactly the target label**. It is a page title when it sits among other content (a
  // chat header above the messages), and it is a result row that merely cannot be pressed when it
  // stands alone. The distinction matters because acting on the wrong reading hurts in both
  // directions: treating a title as a row taps a name *inside* the conversation it names, which
  // opens a profile or starts a different chat; treating a lone unpressed row as "already open"
  // reports success for a conversation that was never opened.
  const targetNodes = before.nodes.filter(
    (node) => labelOf(node).trim() === input.target.trim() && node.clickable !== true,
  );
  const alreadyTitled = targetNodes.length > 0 && !pressableNow && before.nodes.length > targetNodes.length;

  if (alreadyTitled) {
    return {
      verdict: "already-open",
      detail: `"${input.target}" already appears as a label of its own on this screen, so nothing was pressed. Read the screen to confirm it is the intended one before typing anything.`,
    };
  }

  // Rule 1: more than one *distinct* pressable answer means a person has to choose.
  if (distinct.length > 1) {
    return {
      verdict: "ambiguous",
      detail: `"${query}" matches ${distinct.length} different elements: ${distinct.join(" / ")}. Ask the user which one, then call again with the exact label as \`target\`.`,
      candidates: distinct,
    };
  }

  if (!chosen || !chosen.bounds) {
    return {
      verdict: "not-pressable",
      detail: `"${query}" is on screen but has no pressable position, so it cannot be opened. Re-read with screen_read.`,
    };
  }
  if (chosen.disabled === true) {
    return { verdict: "not-pressable", detail: `"${labelOf(chosen)}" is present but disabled.` };
  }

  const width = before.width;
  const height = before.height;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return {
      verdict: "unverified",
      detail: "the display size is unknown, so the point could not be expressed as a fraction",
    };
  }

  await automation.tap(chosen.bounds.centerX / width, chosen.bounds.centerY / height);

  // A layout pass is not instant; reading immediately can catch the frame before the new screen
  // painted and report a false failure on a tap that worked.
  await new Promise((resolve) => setTimeout(resolve, openLimits.settleMs));

  const after = await automation.readScreen({});
  const verified = after.nodes.some((node) => matches(node, input.expect, "contains"));

  if (!verified) {
    return {
      verdict: "unverified",
      detail: `pressed "${labelOf(chosen)}", but "${input.expect}" is NOT on the screen afterwards — the wrong thing opened, or it did not open. Do not continue: report this and ask, rather than typing a message.`,
      pressed: labelOf(chosen),
      after: { elements: after.nodes.length, ...(after.package ? { package: after.package } : {}) },
    };
  }

  return {
    verdict: "opened",
    detail: `opened "${labelOf(chosen)}" and confirmed "${input.expect}" is on screen. The right page is in front.`,
    pressed: labelOf(chosen),
    after: { elements: after.nodes.length, ...(after.package ? { package: after.package } : {}) },
  };
}

export function createOpenTools(deps: { system: SystemService }): AnyToolDefinition[] {
  const screenOpenItem = {
    name: "screen_open_item",
    description:
      "Open a named item — a chat, a conversation, a contact, a search result — and verify it opened. Use this instead of screen_find + tap whenever what you are opening is a *person* or anything else where opening the wrong one matters: it refuses to choose between look-alike results and tells you the candidates, and it confirms the opened page really shows what you expected. `expect` is required because a tap is not evidence: without it the tool could not tell you the difference between opening the right chat and opening a stranger's.",
    input: z.object({
      target: z
        .string()
        .min(1)
        .max(200)
        .describe("The exact label to open, as it appears on screen — the contact's name, the chat title."),
      expect: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Some text that the opened page will contain, used to prove it opened. Usually the same as `target` (a chat's title shows the name) plus something specific to the right one, e.g. a mutual group or the last message. Required: a tap alone cannot tell the right chat from a stranger's.",
        ),
      query: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("What to search for, when it differs from `target` — e.g. type a nickname but open the full name."),
      mode: z
        .enum(MATCH_MODES)
        .optional()
        .default("contains")
        .describe("How to match the label. `exact` is the safest for a person's name."),
    }),
    risk: "system",
    category: "screen-act",
    requires: ["shizuku"],
    alwaysAsk: true,
    /**
     * No scope relaxation, ever.
     *
     * Unlike a plain tap, this action can end with a message going to a human. A read-only task
     * scope must not be able to make it quiet.
     */
    summarize: (input: { target: string }) => `open "${input.target}"`,
    async execute(
      input: { target: string; expect: string; query?: string; mode: MatchMode },
      ctx: { signal?: AbortSignal },
    ) {
      const automation = deps.system.automation;
      if (!automation) {
        throw new CoreError("E_TOOL_FAILED", "screen automation is unavailable on this platform", {
          hint: "Screen automation needs a privileged backend, which only exists on Android.",
        });
      }
      const status = await automation.status();
      requireAvailable(
        "opening a screen item",
        status.available ? available() : unavailable(status.reason ?? "screen automation is unavailable"),
        status.howTo,
      );

      // Cancellation only. Whether the right app is in front is decided by the reading itself —
      // `openNamedItem` refuses when several labels answer, and refuses when the page that opened
      // does not show what was expected. Checking our own process's foreground state would refuse
      // in the one situation this project exists for.
      const allowed = screenActionAllowed({ signal: ctx.signal });
      if (!allowed.ok) {
        return { verdict: "refused" as const, opened: false, detail: allowed.reason ?? "not allowed" };
      }

      const outcome = await openNamedItem(automation, input);
      // Reported, not thrown. Two of these verdicts are *useful answers* — "there are three
      // people by that name" and "the wrong page opened" — and an exception invites the model to
      // retry the same call, which is the opposite of what should happen next.
      return {
        verdict: outcome.verdict,
        opened: outcome.verdict === "opened",
        detail: outcome.detail,
        ...(outcome.pressed ? { pressed: outcome.pressed } : {}),
        ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
        ...(outcome.after ? { after: outcome.after } : {}),
        ...(outcome.verdict === "opened"
          ? {}
          : {
              mustNotProceed:
                "Do not type or send anything on the strength of this result. Ask the user, or re-read the screen and try again.",
            }),
      };
    },
  } satisfies AnyToolDefinition;

  return [screenOpenItem];
}
