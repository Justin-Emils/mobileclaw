import type { ScreenNode, ScreenSnapshot } from "@mobileclaw/core";

/**
 * Reading a whole scrollable page in one call, instead of one screen per step.
 *
 * ## Why this exists
 *
 * Every tool call costs a step against the run's budget (12 by default, and the loop is
 * model↔tool round trips). Reading a long list by hand is therefore the most expensive thing the
 * model does: `screen_read`, `screen_scroll`, `screen_read`, `screen_scroll`… — one step per
 * screen, so a hundred-message chat or a long playlist runs the budget out before the reading is
 * finished.
 *
 * The fix is not a bigger budget, it is doing the repetition inside one call. A tool's *internal*
 * work is free; the project already relies on this (`screen_wait` polls for as long as it needs and
 * still costs one step, `screen_send_message` reads the screen four times inside one call). This is
 * the same move applied to reading.
 *
 * ## What it does not do
 *
 * It does not return pressable coordinates for everything it collects. A node's bounds are relative
 * to the screen it was read from, and those coordinates are stale the moment the page scrolls —
 * which the codebase already recognises (`screen_tap_element` re-reads rather than trusting an
 * earlier reading, because "the numbering belongs to a screen"). So the collected content is for
 * *finding and reading*: the caller searches it, and re-reads before pressing. `nodeAt` therefore
 * only covers the screen that is actually in front at the end, and the caller is told how many nodes
 * it covers so it cannot use the number as if it spanned everything.
 */

/** How a scroll-through ended. Reported, because "found everything" and "stopped early" differ. */
export type ScrollStopReason =
  /**
   * A scroll produced no element that had not already been seen. Scrolling is no longer finding
   * anything, which is what the end of the content looks like from here.
   */
  | "no-new-content"
  /**
   * The page did not move at all, so continuing would collect the same screen repeatedly.
   *
   * **This reason is genuinely ambiguous and the caller must not read it as "the end".** A fixed
   * layout, a video page and a view whose scrolling this backend cannot drive all look the same, and
   * only the first of those means there is nothing further.
   */
  | "not-scrolling"
  /** The caller's screen cap was reached. `incomplete`. */
  | "screen-limit"
  /** The caller's deadline passed. `incomplete`. */
  | "timeout"
  /** Cancelled. `incomplete`. */
  | "aborted";

export interface ScrollThroughLimits {
  /** Most screens to collect, including the first. Hard cap -- this is what prevents a hang. */
  maxScreens?: number;
  /** Wall-clock budget for the whole walk. */
  timeoutMs?: number;
  /** Fraction of the screen to travel per scroll. */
  amount?: number;
  signal?: AbortSignal;
}

/** Defaults chosen to be useful and bounded: ten screens, twenty seconds. */
export const SCROLL_THROUGH_DEFAULTS = {
  maxScreens: 10,
  timeoutMs: 20_000,
} as const;

export interface ScrollThroughResult {
  /** Every distinct element seen, in the order it was first seen. */
  nodes: ScreenNode[];
  /** How many screens were read, including the first. */
  screens: number;
  /** Why the walk ended. */
  stoppedBecause: ScrollStopReason;
  /** The reading taken last, which is the only one whose coordinates are still valid. */
  last: ScreenSnapshot;
  /**
   * True when a *limit* cut the walk short, so the reading is known not to be everything.
   *
   * Set only for `screen-limit`, `timeout` and `aborted`. In particular it is **false** for
   * `no-new-content` — that is the end of the content, which is a complete reading — and for
   * `not-scrolling`, where the honest position is "the page would not move, so I do not know
   * whether there is more". A caller that wants to warn about the second case should read
   * `stoppedBecause` rather than treating this flag as a proxy for "trustworthy".
   */
  incomplete: boolean;
}

/**
 * A node's identity across reads, for deciding what is new.
 *
 * Deliberately **content only, no bounds**: an element keeps its label and class as the page scrolls
 * but not its position, so including the position would make every element look new on every screen
 * and defeat the whole exercise.
 *
 * The cost is that two genuinely different rows with identical text collapse into one. That is the
 * safer direction — a repeated row is reported once rather than the walk reporting progress it did
 * not make — but it is worth knowing when reading a list with duplicate labels.
 */
function signatureOf(node: ScreenNode): string {
  return [node.text ?? "", node.description ?? "", node.className ?? "", String(node.clickable ?? false)].join("\u0000");
}

/**
 * Walk a scrollable page, collecting every element that has not been seen before.
 *
 * Injected readers and scrollers rather than reaching for the backend: this package must stay free
 * of platform code, and it is what makes the whole thing testable without a device.
 *
 * `scroll` must travel *down* (onwards through the content). Return `false` from `screenChanged`
 * or produce no new elements and the walk stops, so a page that has reached its end costs one extra
 * scroll rather than running to the cap.
 */
export async function scrollThrough(
  read: () => Promise<ScreenSnapshot>,
  scroll: (amount?: number) => Promise<void>,
  limits: ScrollThroughLimits = {},
): Promise<ScrollThroughResult> {
  const maxScreens = Math.max(1, limits.maxScreens ?? SCROLL_THROUGH_DEFAULTS.maxScreens);
  const timeoutMs = limits.timeoutMs ?? SCROLL_THROUGH_DEFAULTS.timeoutMs;
  const deadline = Date.now() + timeoutMs;

  const seen = new Set<string>();
  const collected: ScreenNode[] = [];

  let last = await read();
  let screens = 1;
  let stoppedBecause: ScrollStopReason = "no-new-content";

  const absorb = (snapshot: ScreenSnapshot): number => {
    let added = 0;
    for (const node of snapshot.nodes) {
      const signature = signatureOf(node);
      if (seen.has(signature)) continue;
      seen.add(signature);
      collected.push(node);
      added++;
    }
    return added;
  };

  absorb(last);

  for (;;) {
    if (limits.signal?.aborted) {
      stoppedBecause = "aborted";
      break;
    }
    if (screens >= maxScreens) {
      stoppedBecause = "screen-limit";
      break;
    }
    if (Date.now() >= deadline) {
      stoppedBecause = "timeout";
      break;
    }

    await scroll(limits.amount);

    const next = await read();
    const added = absorb(next);
    screens++;

    // A page that stopped moving is reported as such rather than as "no new content": they mean
    // different things to the caller, and only one of them means "you have reached the end".
    if (samePage(last, next)) {
      last = next;
      stoppedBecause = "not-scrolling";
      break;
    }

    last = next;

    if (added === 0) {
      stoppedBecause = "no-new-content";
      break;
    }
  }

  return {
    nodes: collected,
    screens,
    stoppedBecause,
    last,
    // Only a limit makes the reading known-incomplete. "No new content" is the end of the page, and
    // "the page would not move" is an unknown rather than a truncation — folding either into this
    // flag would make it mean "possibly incomplete", which is not a thing a caller can act on.
    incomplete: stoppedBecause === "screen-limit" || stoppedBecause === "timeout" || stoppedBecause === "aborted",
  };
}

/**
 * Did the page fail to move?
 *
 * Compares node positions, not content: after a scroll that did nothing, the same elements sit at
 * the same coordinates. Scroll bounds are compared through the *first* element that carries them,
 * because the projected list order is stable across a no-op scroll.
 */
export function samePage(before: ScreenSnapshot, after: ScreenSnapshot): boolean {
  if (before.nodes.length !== after.nodes.length) return false;
  if (before.nodes.length === 0) return true;
  for (let i = 0; i < before.nodes.length; i++) {
    const a = before.nodes[i]!;
    const b = after.nodes[i]!;
    if (signatureOf(a) !== signatureOf(b)) return false;
    if (a.bounds?.centerY !== b.bounds?.centerY) return false;
    if (a.bounds?.centerX !== b.bounds?.centerX) return false;
  }
  return true;
}

/** How the walk is described to the model, so a truncated reading cannot be mistaken for the whole page. */
export function describeScrollThrough(result: ScrollThroughResult, collectedElements: number): string {
  const base = `read ${result.screens} screen(s), ${collectedElements} element(s) across them`;
  switch (result.stoppedBecause) {
    case "no-new-content":
      return `${base}; scrolling stopped finding anything new, so this is the end of the content`;
    case "not-scrolling":
      return `${base}; the page would not scroll, so this may be all of it or the view may be one this backend cannot drive — unknown either way`;
    case "screen-limit":
      return `${base}; STOPPED AT THE SCREEN LIMIT — there is probably more below, and this reading is not the whole page`;
    case "timeout":
      return `${base}; STOPPED AT THE TIME LIMIT — there may be more below, and this reading is not the whole page`;
    case "aborted":
      return `${base}; the run was cancelled partway, so this reading is not the whole page`;
  }
}
