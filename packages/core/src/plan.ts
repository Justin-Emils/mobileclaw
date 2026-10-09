/**
 * Shared identifiers for the plan-confirmation step.
 *
 * The name lives in the kernel rather than beside the tool because two layers act on it and
 * a string literal repeated in both would drift silently: the tool declares it, and the
 * agent loop watches for an approved confirmation to open a read-only task scope. A typo in
 * either copy would not fail — it would just stop relaxing the prompts, which looks like the
 * feature never worked.
 */

/**
 * The tool that restates a task and waits for one explicit confirmation.
 *
 * `confirm_plan` is a genuine tool rather than a phase in the loop so that its pause rides
 * the permission gate that already exists: `alwaysAsk` plus `neverRemember` parks the run on
 * a promise only the user can resolve, which is exactly the wanted behaviour, and a refusal
 * needs no new handling because the gate already returns `E_PERMISSION_DENIED` for it.
 */
export const CONFIRM_PLAN_TOOL = "confirm_plan";
