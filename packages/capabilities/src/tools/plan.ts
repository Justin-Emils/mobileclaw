import { z } from "zod";
import { CONFIRM_PLAN_TOOL, type AnyToolDefinition } from "@mobileclaw/core";

/**
 * Task confirmation: restate the request, get one explicit "yes", then work.
 *
 * Why this is a tool rather than a phase in the agent loop:
 *
 *  - it rides machinery that already exists and is already tested. `alwaysAsk` plus
 *    `neverRemember` makes the permission gate park the run on a promise that the approval
 *    UI resolves, which is exactly the behaviour wanted — a hard stop that only a user can
 *    clear. Implementing it in the loop would mean a second pause mechanism beside the
 *    existing one.
 *  - a denial needs no new handling. The gate already refuses the call, the model receives
 *    `[E_PERMISSION_DENIED]`, and the run cannot continue past a step whose result is a
 *    refusal. There is no path where a denied plan still executes.
 *
 * Why it exists at all: acting on a restated task is the cheapest way to catch the failure
 * that costs the most — doing the wrong thing carefully. A user who reads "send X to Y in
 * QQ" can see the mistake in a second; the same mistake spread over eight approved steps is
 * invisible until it has happened.
 *
 * The wording of the restatement is the *model's*, and that is deliberate: it is a claim
 * about intent, which is the one thing only the model knows. Everything a tool actually
 * did is still reported by the tool, from facts, per the project's rule. The two must not be
 * confused, so this tool never reports what it did — it reports what it intends.
 */

/** Limits that keep a restatement readable in a modal rather than a wall of text. */
const PLAN_LIMITS = {
  minSteps: 1,
  maxSteps: 30,
  maxStepLength: 300,
  maxAffectedApps: 20,
  /**
   * Bounds on the declared step estimate.
   *
   * The upper bound matches the ceiling the agent loop clamps to, and exists for the same
   * reason: an estimate is a guess, and an unbounded guess would let one wrong number run up
   * an unattended bill. The schema bound is the first line, so the model is told the limit
   * rather than having its number silently cut.
   */
  minStepEstimate: 1,
  maxStepEstimate: 60,
} as const;

export function createPlanTools(): AnyToolDefinition[] {
  const confirmPlan = {
    name: CONFIRM_PLAN_TOOL,
    description:
      "Call this FIRST, before touching the device, whenever the request involves another app (opening one, reading its screen, or entering anything into it). Restate in plain language what you understood the user to want, which apps it touches, and which steps will change something — then stop and wait. The run cannot continue until the user confirms. If they decline, do not proceed and do not try to achieve the same effect another way: ask what they actually wanted. Do not call this for a request you can answer without touching the device.",
    input: z.object({
      restatement: z
        .string()
        .min(1)
        .max(2000)
        .describe("One or two sentences, in the user's own language, saying what you understood the task to be."),
      steps: z
        .array(z.string().min(1).max(PLAN_LIMITS.maxStepLength))
        .min(PLAN_LIMITS.minSteps)
        .max(PLAN_LIMITS.maxSteps)
        .describe("The concrete steps you intend to take, in order and in plain language."),
      apps: z
        .array(z.string().min(1))
        .max(PLAN_LIMITS.maxAffectedApps)
        .optional()
        .describe("Apps this will open or interact with, as package ids or names the user would recognise."),
      changes: z
        .array(z.string().min(1).max(PLAN_LIMITS.maxStepLength))
        .optional()
        .describe("The steps that will change or delete something for real — sending, typing into a field, deleting, pressing send. Empty means the task only reads."),
      stepEstimate: z
        .number()
        .int()
        .min(PLAN_LIMITS.minStepEstimate)
        .max(PLAN_LIMITS.maxStepEstimate)
        .optional()
        .describe(
          "How many steps you expect to need. Count every tool call: each read, each search, each fetch and each press is one. For a list of N items looked up individually, that is roughly N x 2 plus a few. This number raises the run's budget past the configured default, so estimate honestly — too low and you get cut off mid-task, too high and you spend the user's tokens.",
        ),
    }),
    risk: "read",
    category: "plan",
    // Reads nothing and changes nothing: it only asks. `disk` would be the inferred default for
    // `read` risk and would be a lie the catalogue told about the one tool that touches nothing.
    effects: [],
    cost: "cheap",
    /**
     * Asked every single time and never remembered.
     *
     * `alwaysAsk` alone would yield to the conversation's allowlist, and a remembered plan
     * confirmation would approve every *later* plan in that conversation without being read
     * — which is the opposite of the point.
     */
    alwaysAsk: true,
    neverRemember: true,
    summarize: (input: { restatement: string }) => input.restatement,
    async execute(input: {
      restatement: string;
      steps: string[];
      apps?: string[];
      changes?: string[];
      stepEstimate?: number;
    }) {
      return {
        confirmed: true,
        restatement: input.restatement,
        steps: input.steps,
        ...(input.apps ? { apps: input.apps } : {}),
        // Said explicitly, because "this task only reads" is the thing a cautious user most
        // wants to know and the thing they cannot infer from a step list.
        changes: input.changes ?? [],
        readOnly: (input.changes ?? []).length === 0,
        // Echoed back into the conversation so the model reads its own number afterwards
        // rather than re-guessing it on every step, and so the transcript records the cost
        // the user actually agreed to.
        ...(input.stepEstimate !== undefined ? { stepEstimate: input.stepEstimate } : {}),
        note: "The user has seen this restatement and confirmed it. Proceed with exactly these steps; if the situation turns out to differ, stop and re-confirm rather than adapting silently.",
      };
    },
  } satisfies AnyToolDefinition;

  return [confirmPlan];
}
