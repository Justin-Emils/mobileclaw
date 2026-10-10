import { CoreError, type ScreenNode } from "@mobileclaw/core";

/**
 * Matching a label against what is on screen.
 *
 * Lifted out of `tools/screen-read.ts` when a second caller needed it. The alternative was a
 * copy, and a copy of this logic is the kind of thing that stays in step right up until the day
 * one of them learns about content descriptions and the other does not — at which point a tool
 * silently stops finding icon-only controls.
 */

/** How a query is matched against what an element says. */
export const MATCH_MODES = ["contains", "exact", "regex"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export const openLimits = {
  /**
   * How long to wait after a tap before reading the screen back.
   *
   * A tap is delivered to the app, not painted by it. Reading immediately can catch the frame
   * before the new screen has laid out and report a failure for a tap that worked — and here a
   * false failure is a *safe* outcome (the tool refuses to proceed) but a maddening one, because
   * retrying produces the same report forever.
   */
  settleMs: 400,
} as const;

/** The text an element offers: what it shows, then what it is called. */
export function labelOf(node: ScreenNode): string {
  return node.text ?? node.description ?? "";
}

/**
 * Does this element answer the query?
 *
 * `description` is searched as well as `text` because an icon-only control carries its only
 * label in `content-desc` — a magnifier button has no text at all, so a search that ignored
 * descriptions could never find one.
 */
export function matches(node: ScreenNode, query: string, mode: MatchMode): boolean {
  const haystacks = [node.text, node.description].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  if (haystacks.length === 0) return false;

  if (mode === "exact") {
    return haystacks.some((value) => value.trim() === query.trim());
  }
  if (mode === "regex") {
    // A caller-supplied pattern is untrusted input like any other, so a malformed one is
    // reported as a bad query rather than thrown as a syntax error from deep inside.
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, "i");
    } catch (error) {
      throw new CoreError("E_TOOL_INPUT", `not a usable regular expression: ${query}`, {
        hint: `The pattern failed to compile (${error instanceof Error ? error.message : String(error)}). Use mode "contains" to search for literal text.`,
      });
    }
    return haystacks.some((value) => pattern.test(value));
  }
  const needle = query.trim().toLowerCase();
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

/**
 * Pick the element a query most likely means.
 *
 * An exact label wins outright. Otherwise a *pressable* element beats a larger one that
 * merely contains the text: in an accessibility tree the text is usually carried by an
 * inner `TextView` while the thing that responds to a finger is its clickable ancestor, so
 * preferring the container is what makes a search for a label press what a person would press.
 * Length is the final tie-break — the shortest label that still matched is the most specific.
 */
export function bestMatch(nodes: ScreenNode[]): ScreenNode | undefined {
  const pressable = nodes.filter((node) => node.clickable === true && node.disabled !== true);
  const pool = pressable.length > 0 ? pressable : nodes;
  return [...pool].sort((a, b) => labelOf(a).length - labelOf(b).length)[0];
}

/** The elements answering a query, and the one a caller would act on. */
export interface CandidateAnswer {
  matches: ScreenNode[];
  chosen: ScreenNode | undefined;
}

/**
 * Candidates for a label, separated from the choice between them.
 *
 * Callers that can act on an ambiguous answer — opening a chat, where picking the wrong person
 * is irreversible — need to *see* that there was more than one. `bestMatch` alone hides that,
 * because it always returns something. This hands back both so the caller decides whether
 * choosing is its job at all.
 */
export function pressableCandidates(
  nodes: ScreenNode[],
  query: string,
  mode: MatchMode,
): CandidateAnswer {
  const found = nodes.filter((node) => matches(node, query, mode));
  return { matches: found, chosen: bestMatch(found) };
}
