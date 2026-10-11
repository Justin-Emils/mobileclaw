import { describe, expect, it, vi } from "vitest";
import type { ScreenNode, ScreenSnapshot } from "@mobileclaw/core";
import { describeScrollThrough, samePage, scrollThrough } from "../src/scroll-through";

/**
 * Reading a whole scrollable page in one call.
 *
 * Two things are being protected here, and they pull in opposite directions.
 *
 * The first is **termination**. This helper loops inside a tool call, so a page that never settles
 * would hang the run rather than fail it — and a hang is worse, because nothing is reported. Every
 * boundary below (screen cap, deadline, page-did-not-move, no-new-content) exists to make that
 * impossible, and each has a case.
 *
 * The second is **honesty about what was read**. Running out of screens and reaching the end of the
 * content both stop the walk, and confusing the two is how a partial reading gets reported as the
 * whole page. `stoppedBecause` and `describeScrollThrough` keep them apart, and the limit cases
 * assert that the wording says so.
 */

function node(text: string, centerY: number, extra: Partial<ScreenNode> = {}): ScreenNode {
  return {
    index: 0,
    text,
    bounds: {
      left: 0,
      top: centerY - 10,
      right: 100,
      bottom: centerY + 10,
      width: 100,
      height: 20,
      centerX: 50,
      centerY,
    },
    ...extra,
  };
}

function page(nodes: ScreenNode[]): ScreenSnapshot {
  return { nodes, total: nodes.length };
}

/**
 * A list of fixed height that scrolls until it runs out.
 *
 * This models the real thing rather than returning a canned page per call: rows sit at fixed
 * content offsets, the view shows a window of them, and scrolling moves that window down. A reader
 * built this way cannot be misread by hand-counting — the loop's behaviour falls out of the data.
 */
function listReader(rows: string[], viewport = 3) {
  let offset = 0;
  return {
    read: async (): Promise<ScreenSnapshot> => {
      const visible = rows.slice(offset, offset + viewport);
      return page(visible.map((text, i) => node(text, 100 + i * 200)));
    },
    /** Scrolling past the end changes nothing, which is exactly what the real thing does. */
    scroll: async (): Promise<void> => {
      offset = Math.min(offset + 1, Math.max(0, rows.length - 1));
    },
    get offset() {
      return offset;
    },
  };
}

/** Well under the 20 s default, so a bug cannot turn the suite into a hang. */
const QUICK = { timeoutMs: 500 } as const;

describe("scrollThrough", () => {
  it("collects elements from every screen into one result", async () => {
    // The whole point: four reads that used to cost four steps now cost one.
    const screens = [page([node("a", 10)]), page([node("b", 20)]), page([node("c", 30)]), page([node("c", 30)])];
    let i = 0;
    const result = await scrollThrough(async () => screens[Math.min(i++, screens.length - 1)]!, async () => {}, QUICK);

    expect(result.nodes.map((n) => n.text)).toEqual(["a", "b", "c"]);
    expect(result.screens).toBe(4);
  });

  it("deduplicates an element that stays on screen across a scroll", async () => {
    // A partial scroll leaves elements in both readings. Counting them twice would inflate the
    // result and, worse, make the walk look productive when it is not.
    const screens = [page([node("a", 10), node("b", 20)]), page([node("b", 20), node("c", 30)])];
    let i = 0;
    const result = await scrollThrough(async () => screens[Math.min(i++, screens.length - 1)]!, async () => {}, QUICK);
    expect(result.nodes.map((n) => n.text)).toEqual(["a", "b", "c"]);
  });

  it("treats the same label at a different position as a distinct row", async () => {
    // Content-only identity, stated as a case so the tradeoff is visible rather than surprising.
    // Including bounds in the signature would make every element on every screen look new, which
    // defeats deduplication entirely; the cost is that two rows with identical text are one entry.
    const screens = [page([node("重复", 10)]), page([node("重复", 900)]), page([node("重复", 900)])];
    let i = 0;
    const result = await scrollThrough(async () => screens[Math.min(i++, screens.length - 1)]!, async () => {}, QUICK);
    expect(result.nodes).toHaveLength(1);
  });

  it("walks a real list to its end and stops there", async () => {
    // A six-row list in a three-row view. The walk must reach every row and stop at the end rather
    // than running to the cap — running on would be real scrolling on the user's screen for no
    // information.
    const list = listReader(["r1", "r2", "r3", "r4", "r5", "r6"]);
    const result = await scrollThrough(list.read, list.scroll, { ...QUICK, maxScreens: 50 });

    expect(result.nodes.map((n) => n.text)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
    // The reason is `no-new-content`, not `not-scrolling`. At the end of a list the page still moves
    // as the remaining rows shift up — what stops is the appearance of anything new. `not-scrolling`
    // is reserved for a page that does not move at all, which is a different observation and is
    // covered separately below.
    expect(result.stoppedBecause).toBe("no-new-content");
    // `incomplete` is false on purpose: reaching the end of the content is a *complete* reading.
    // The flag marks a limit that cut the walk short, and folding "end of page" into it would make
    // it mean "possibly incomplete", which is not something a caller can act on.
    expect(result.incomplete).toBe(false);
  });

  it("stops when the page stops moving, and says so rather than claiming the end", async () => {
    // A view that cannot scroll (a fixed layout, a video page) reports the same screen forever. It
    // must not run to the cap, and "the page did not move" is not the same claim as "that is all".
    const fixed = page([node("still here", 500)]);
    const scroll = vi.fn(async () => {});
    const result = await scrollThrough(async () => fixed, scroll, { ...QUICK, maxScreens: 50 });

    expect(result.stoppedBecause).toBe("not-scrolling");
    expect(scroll.mock.calls.length).toBe(1);
    // Not `incomplete`: "the page would not move" is an unknown rather than a truncation. It may be
    // the end of the content or it may be a view this backend cannot drive, and the wording below
    // says exactly that instead of picking one.
    expect(result.incomplete).toBe(false);
    expect(describeScrollThrough(result, result.nodes.length)).toMatch(/would not scroll/);
    expect(describeScrollThrough(result, result.nodes.length)).toMatch(/unknown either way/);
  });

  it("honours the screen cap and reports the reading as incomplete", async () => {
    // The anti-hang boundary. A page that keeps producing new elements forever — an infinite feed —
    // must stop, and the result must not read as the whole page.
    let counter = 0;
    const result = await scrollThrough(
      async () => page([node(`row-${counter++}`, 10)]),
      async () => {},
      { ...QUICK, maxScreens: 3 },
    );

    expect(result.screens).toBe(3);
    expect(result.stoppedBecause).toBe("screen-limit");
    expect(result.incomplete).toBe(true);
    expect(describeScrollThrough(result, result.nodes.length)).toMatch(/STOPPED AT THE SCREEN LIMIT/);
    expect(describeScrollThrough(result, result.nodes.length)).toMatch(/not the whole page/);
  });

  it("honours the deadline", async () => {
    // The other anti-hang boundary. A slow backend must not be able to keep the loop alive past the
    // budget, and the result again must not read as complete.
    let counter = 0;
    const result = await scrollThrough(
      async () => page([node(`row-${counter++}`, 10)]),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      { timeoutMs: 1, maxScreens: 1000 },
    );

    expect(result.stoppedBecause).toBe("timeout");
    expect(result.incomplete).toBe(true);
    expect(describeScrollThrough(result, result.nodes.length)).toMatch(/STOPPED AT THE TIME LIMIT/);
  });

  it("stops for an already-aborted run without scrolling", async () => {
    const controller = new AbortController();
    controller.abort();
    const scroll = vi.fn(async () => {});
    const result = await scrollThrough(async () => page([node("a", 10)]), scroll, {
      ...QUICK,
      maxScreens: 100,
      signal: controller.signal,
    });

    expect(result.stoppedBecause).toBe("aborted");
    expect(result.incomplete).toBe(true);
    expect(scroll).not.toHaveBeenCalled();
    // Whatever was collected before the cancellation is still returned rather than thrown away.
    expect(result.nodes.map((n) => n.text)).toEqual(["a"]);
  });

  it("keeps the last reading separately, since only its coordinates are still valid", async () => {
    // Bounds are relative to the screen they were read from, so the collected list is for reading
    // and searching, not for pressing. Handing back `last` is what lets a caller press safely.
    const screens = [page([node("a", 10)]), page([node("b", 20)])];
    let i = 0;
    const result = await scrollThrough(async () => screens[Math.min(i++, screens.length - 1)]!, async () => {}, QUICK);

    expect(result.last.nodes.map((n) => n.text)).toEqual(["b"]);
    expect(result.nodes.map((n) => n.text)).toEqual(["a", "b"]);
  });

  it("never reads more than maxScreens", async () => {
    let reads = 0;
    await scrollThrough(
      async () => {
        reads++;
        return page([node(`row-${reads}`, 10)]);
      },
      async () => {},
      { ...QUICK, maxScreens: 4 },
    );
    expect(reads).toBe(4);
  });

  it("does not claim the end of the content when the cap stopped it", async () => {
    // The distinction that matters most: an incomplete reading must not be worded like a complete
    // one, because the model will act on it as though it had seen everything.
    let counter = 0;
    const capped = await scrollThrough(async () => page([node(`r${counter++}`, 10)]), async () => {}, {
      ...QUICK,
      maxScreens: 2,
    });
    // A real list with more rows than the viewport, walked to its end — `no-new-content`, the case
    // that legitimately means "this is everything".
    //
    // Deliberately not a one-row list: something shorter than the viewport cannot scroll at all, so
    // it reports `not-scrolling`, and that case must *not* claim to be the end precisely because it
    // cannot be told apart from a view this backend fails to drive.
    //
    // One instance: `read` and `scroll` must share a cursor, and two calls to `listReader` would
    // each get their own.
    const walkable = listReader(["a", "b", "c", "d", "e", "f"]);
    const finished = await scrollThrough(walkable.read, walkable.scroll, QUICK);

    expect(describeScrollThrough(capped, capped.nodes.length)).not.toBe(
      describeScrollThrough(finished, finished.nodes.length),
    );
    expect(describeScrollThrough(finished, finished.nodes.length)).toMatch(/end of the content/);
    expect(capped.incomplete).toBe(true);
    expect(finished.incomplete).toBe(false);
  });

  it("distinguishes a page that moved without revealing anything from one that did not move", async () => {
    // Two different observations, and the caller needs both. `not-scrolling` means the view cannot
    // scroll at all (a fixed layout, a video page). `no-new-content` means it scrolled over content
    // it had already shown. Only the second is "scrolling is not finding me anything new".
    const constant = page([node("still here", 500)]);
    const fixed = await scrollThrough(async () => constant, async () => {}, { ...QUICK, maxScreens: 50 });
    expect(fixed.stoppedBecause).toBe("not-scrolling");

    let n = 0;
    const movedButNothingNew = await scrollThrough(
      async () => {
        n++;
        return page([node("same row", 100 + n * 50)]);
      },
      async () => {},
      { ...QUICK, maxScreens: 20 },
    );
    expect(movedButNothingNew.stoppedBecause).toBe("no-new-content");
    expect(movedButNothingNew.incomplete).toBe(false);
    expect(describeScrollThrough(movedButNothingNew, movedButNothingNew.nodes.length)).toMatch(
      /end of the content/,
    );
  });
});

describe("samePage", () => {
  it("is true when nothing moved", () => {
    expect(samePage(page([node("a", 10)]), page([node("a", 10)]))).toBe(true);
  });

  it("is false when an element moved, which is what scrolling looks like", () => {
    expect(samePage(page([node("a", 10)]), page([node("a", 900)]))).toBe(false);
  });

  it("is false when the content changed even at the same positions", () => {
    expect(samePage(page([node("a", 10)]), page([node("b", 10)]))).toBe(false);
  });

  it("is false when the count changed", () => {
    expect(samePage(page([node("a", 10)]), page([node("a", 10), node("b", 20)]))).toBe(false);
  });

  it("treats two empty readings as the same page", () => {
    expect(samePage(page([]), page([]))).toBe(true);
  });
});

describe("describeScrollThrough", () => {
  it("always reports how many screens and elements, so a partial reading is visible", () => {
    for (const stoppedBecause of ["no-new-content", "not-scrolling", "screen-limit", "timeout", "aborted"] as const) {
      const text = describeScrollThrough(
        { nodes: [], screens: 3, stoppedBecause, last: page([]), incomplete: stoppedBecause !== "no-new-content" },
        42,
      );
      expect(text).toContain("3 screen(s)");
      expect(text).toContain("42 element(s)");
    }
  });
});
