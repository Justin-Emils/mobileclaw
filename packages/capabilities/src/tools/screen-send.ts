import { z } from "zod";
import {
  CoreError,
  SCREEN_DEFAULTS,
  type AnyToolDefinition,
  type AutomationService,
  type ScreenSnapshot,
  type SystemService,
} from "@mobileclaw/core";
import { available, requireAvailable, unavailable } from "../availability";
import { labelOf, matches, openLimits, pressableCandidates, type MatchMode } from "../screen-match";
import { packageMatches } from "../foreground";

/**
 * Sending a message, as one action that either happens or does not.
 *
 * ## Why this is not "type, then press send"
 *
 * Composed from the existing tools, sending is a sequence whose steps are each easy to get right
 * and impossible to get *collectively* right: open the conversation, type the text, press send.
 * Every one of those can succeed against the wrong screen. The failure that ends with a message
 * delivered to the wrong person is not a bad keystroke — it is a sequence that was never verified
 * as a whole, and no individual step can tell, because each only knows about the screen in front
 * of it at that instant.
 *
 * So this is deliberately atomic. It re-reads the screen between every step, it insists the page
 * is *still* the named conversation immediately before pressing, and on any doubt it sends
 * nothing and says what it refused to do.
 *
 * ## The ordering rule that carries the weight
 *
 * The last thing read before the press is the title. The gap between "verified" and "pressed" is
 * the only window where a wrong recipient is possible, so that gap is made as small as it can be:
 * one read, then one press, with no typing in between. Everything else — typing, checking the
 * text landed — happens *before* that final check, so a slow app or a changed layout can never
 * move the recipient under our feet between the check and the press.
 *
 * ## `expect` is not the same as `target`
 *
 * `target` says which conversation is in front. `expect` is what proves the *text about to be
 * sent* is the text that belongs to that conversation — a name, a date, an account number. Kept
 * separate because a conversation title alone cannot tell you the message body is the right one,
 * and the two mistakes ("wrong person" and "right person, wrong content") have different causes.
 */

export type SendVerdict =
  /** Read the recipient, confirmed the text, re-read the recipient, pressed send. */
  | "sent"
  /** A precondition failed; nothing was pressed. */
  | "refused";

export interface SendOutcome {
  verdict: SendVerdict;
  detail: string;
  /** The recipient label found immediately before the press, when one was found. */
  recipient?: string;
  /** Set when `send` was pressed — the one thing that cannot be undone. */
  pressed?: boolean;
}

/** A node that names a page: present, not pressable, and exactly the text. */
function hasPageTitle(snapshot: ScreenSnapshot, title: string): boolean {
  return snapshot.nodes.some(
    (node) => node.clickable !== true && labelOf(node).trim() === title.trim(),
  );
}

/** Fail fast, with the same shape every time so callers cannot miss the reason. */
function refuse(detail: string): SendOutcome {
  return { verdict: "refused", detail };
}

/**
 * The whole send, in one place, so the reading used for the decision and the reading used for the
 * final check cannot come from different moments by accident.
 */
export async function sendMessage(
  automation: AutomationService,
  input: {
    target: string;
    expect: string;
    message?: string;
    sendLabel: string;
    /** Letter case for matching the send control, when a label repeats on the screen. */
    mode?: MatchMode;
    /**
     * The package the conversation is supposed to be in, e.g. `com.tencent.mm`.
     *
     * Checked against the app the final reading came from. Worth passing whenever the caller knows
     * it: the recipient check can only prove that *some* screen shows the expected name, while this
     * proves it is the right app's screen. Optional because a backend that cannot report a package
     * would otherwise be unable to send at all.
     */
    expectedPackage?: string;
  },
): Promise<SendOutcome> {
  const mode = input.mode ?? "contains";

  // ---- 0. Is the reading even from the right app? ---------------------------
  // Asked first as well as last. A run may resume long after the plan was made, and the caller
  // naming the expected package is the only fact that survives that gap.
  if (input.expectedPackage) {
    const first = await automation.readScreen({ maxNodes: 1, maxChars: 1 });
    if (!packageMatches(first.package, input.expectedPackage)) {
      return refuse(
        `the screen is showing ${first.package}, not ${input.expectedPackage}, so nothing was typed or sent. The intended app is not in front.`,
      );
    }
  }

  // ---- 1. Is the intended conversation actually in front? -------------------
  const before = await automation.readScreen({});
  if (!hasPageTitle(before, input.target)) {
    return refuse(
      before.note ??
        `"${input.target}" is not the page in front, so nothing was typed or sent. Open the conversation first with screen_open_item, then call this.`,
    );
  }

  // ---- 2. Type, and confirm the text is on screen before going further ------
  if (input.message !== undefined) {
    await automation.typeText(input.message);
    await new Promise((resolve) => setTimeout(resolve, openLimits.settleMs));

    const typed = await automation.readScreen({});
    // Cut both sides to the same length before comparing: readings are budgeted, so a long field
    // comes back shortened and an exact comparison would fail on text that is really there.
    const needle = input.message.slice(0, SCREEN_DEFAULTS.readMaxTextLength).toLowerCase();
    const landed = typed.nodes.some((node) =>
      `${node.text ?? ""} ${node.description ?? ""}`.toLowerCase().includes(needle),
    );
    if (!landed) {
      return refuse(
        typed.note ??
          `the message was typed but does not appear on screen, so it was NOT sent. The field may be read-only, or it lost focus. Nothing was pressed.`,
      );
    }
  }

  // ---- 3. The content check: what is about to be sent is the right text -----
  // Read fresh rather than reusing step 2's reading, because typing may have scrolled or relaid
  // the screen out, and this assertion is about what is on screen *now*.
  const withText = await automation.readScreen({});
  if (!withText.nodes.some((node) => matches(node, input.expect, "contains"))) {
    return refuse(
      `the conversation with "${input.target}" does not show "${input.expect}", so the message was NOT sent. Either the wrong conversation is open or the content does not belong to it.`,
    );
  }

  // ---- 4. Last look at the recipient, then press. Nothing in between. -------
  //
  // This is the whole point of the tool. Between "the text is ready" and "send is pressed" the
  // only thing checked is the recipient, and the only thing that follows is the press — so a
  // lagging app cannot swap the conversation out from under a check that already passed.
  const final = await automation.readScreen({});
  if (!hasPageTitle(final, input.target)) {
    return refuse(
      `"${input.target}" was no longer the page in front at the moment of sending, so nothing was sent. The screen changed between readying the message and sending it.`,
    );
  }

  /**
   * Which app is this reading from?
   *
   * The strongest check available, and the one that answers the actual question. It was never "is
   * *our* app in front" — our app is *supposed* to sit behind the conversation being written into.
   * The question is whether the screen being read belongs to the app the plan was made for, because
   * a reading only means anything relative to the app that published it.
   *
   * `ScreenSnapshot.package` has carried this since the reading was implemented, and its own doc
   * comment says to check it before acting. It was not being checked anywhere. A caller that names
   * the expected package now gets that check on the step that cannot be undone.
   *
   * Silence is not disagreement: a backend that cannot name the package says nothing, and refusing
   * on silence would break every such device. Only a *different* package refuses.
   */
  if (input.expectedPackage && final.package && final.package !== input.expectedPackage) {
    return refuse(
      `the screen is showing ${final.package}, not ${input.expectedPackage}, so nothing was sent. The intended app is no longer in front.`,
    );
  }

  const controls = pressableCandidates(final.nodes, input.sendLabel, mode);
  if (controls.matches.length === 0) {
    return refuse(
      `no pressable control on this screen says "${input.sendLabel}", so the message was NOT sent. Pass the exact label of the send button as the user sees it (Send / 发送 / an arrow's content description).`,
    );
  }

  const distinct = [...new Set(controls.matches.map(labelOf))];
  if (distinct.length > 1) {
    // Two different controls answering "send" is exactly the situation where pressing the chosen
    // one is a guess, and the guess lands in a conversation with a human being in it.
    return refuse(
      `"${input.sendLabel}" matches ${distinct.length} different controls: ${distinct.join(" / ")}. Nothing was sent — tell the user which ones you see and ask which is the send button.`,
    );
  }

  const button = controls.chosen;
  if (!button?.bounds || button.disabled === true) {
    return refuse(
      `the send control "${input.sendLabel}" is ${button?.disabled === true ? "disabled" : "not pressable"}, so nothing was sent.`,
    );
  }

  const width = final.width;
  const height = final.height;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return refuse("the display size is unknown, so the send control could not be pressed safely.");
  }

  await automation.tap(button.bounds.centerX / width, button.bounds.centerY / height);

  return {
    verdict: "sent",
    detail: `sent to "${input.target}" — the recipient was confirmed on screen immediately before pressing "${labelOf(button)}".`,
    recipient: input.target,
    pressed: true,
  };
}

export function createSendTools(deps: { system: SystemService }): AnyToolDefinition[] {
  const screenSendMessage = {
    name: "screen_send_message",
    description:
      "Send a message to a named recipient, with the recipient and the content both verified — or send nothing at all. Use this instead of screen_type + tapping send: it refuses if the intended conversation is not the page in front, refuses if the text did not land, and re-reads the recipient one last time immediately before pressing, so a message cannot go to the wrong person. A press cannot be undone, so every check here is a stop rather than a warning. Pass the send button's label as the user sees it; the tool will not guess which control sends.",
    input: z.object({
      target: z
        .string()
        .min(1)
        .max(200)
        .describe("The conversation that must be in front — the recipient's name, exactly as shown in the title."),
      expect: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          "Something the conversation must be showing to prove the content belongs here — usually the distinctive part of what you are about to send, so a message cannot go to a same-named stranger.",
        ),
      message: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("Text to type into the input field first. Omit when something is already composed and you only want it checked and sent."),
      sendLabel: z
        .string()
        .min(1)
        .max(60)
        .describe("The send control's label as the user sees it: Send, 发送, or an arrow's content description. Required — guessing which control sends is how a wrong button gets pressed."),
      mode: z
        .enum(["contains", "exact", "regex"])
        .optional()
        .default("contains")
        .describe("How to match the send control's label. `exact` when the screen has other buttons containing the word."),
      expectedPackage: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "The app the conversation is in, e.g. com.tencent.mm. Pass it when you know it: the recipient check proves some screen shows the name, while this proves it is the right app's screen. Get it from screen_current or a previous screen_read.",
        ),
    }),
    risk: "system",
    category: "screen-act",
    requires: ["shizuku"],
    alwaysAsk: true,
    /**
     * The strongest posture in the project, and deliberately not relaxable.
     *
     * `neverRemember` already refuses the conversation allowlist; on top of that this tool must
     * never declare `mutates: false`, because a confirmed read-only task scope would then let it
     * press send without asking. A delivery to a human being is the one action no scope may cover.
     */
    neverRemember: true,
    summarize: (input: { target: string }) => `send to "${input.target}"`,
    async execute(input: {
      target: string;
      expect: string;
      message?: string;
      sendLabel: string;
      mode: MatchMode;
      expectedPackage?: string;
    }) {
      const automation = deps.system.automation;
      if (!automation) {
        throw new CoreError("E_TOOL_FAILED", "screen automation is unavailable on this platform", {
          hint: "Screen automation needs a privileged backend, which only exists on Android.",
        });
      }
      const status = await automation.status();
      requireAvailable(
        "sending a message",
        status.available ? available() : unavailable(status.reason ?? "screen automation is unavailable"),
        status.howTo,
      );

      const outcome = await sendMessage(automation, input);
      return {
        verdict: outcome.verdict,
        sent: outcome.verdict === "sent",
        detail: outcome.detail,
        ...(outcome.recipient ? { recipient: outcome.recipient } : {}),
        ...(outcome.pressed ? { pressedSend: true } : {}),
        // Stated as a fact rather than left to inference: the model must not be able to read a
        // refusal as a soft failure and try again with the same call.
        ...(outcome.verdict === "sent"
          ? {}
          : {
              nothingWasSent: true,
              mustNotRetryBlindly:
                "Nothing was pressed. Do not repeat the same call hoping for a different result — resolve the reason above first, or tell the user.",
            }),
      };
    },
  } satisfies AnyToolDefinition;

  return [screenSendMessage];
}
