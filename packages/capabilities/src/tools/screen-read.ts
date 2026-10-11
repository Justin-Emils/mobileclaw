import { z } from "zod";
import {
  CoreError,
  SCREEN_DEFAULTS,
  type AnyToolDefinition,
  type AutomationService,
  type SystemService,
  type ScreenNode,
  type ScreenSnapshot,
} from "@mobileclaw/core";
import { available, requireAvailable, unavailable } from "../availability";
import { formatScreenReading } from "../ui-dump";
import {
  SCROLL_THROUGH_DEFAULTS,
  describeScrollThrough,
  scrollThrough,
} from "../scroll-through";

/**
 * Bounds for the scroll-through option, as the tool offers it.
 *
 * Deliberately tighter than the helper's own ceiling. Ten screens of a chat is already a lot of
 * scrolling to perform on someone's screen without asking, and the cost of a too-small cap is one
 * more call, whereas the cost of a too-large one is a run that sits there scrolling.
 */
const SCROLL_TOOL_LIMITS = { maxScreens: 25 } as const;
/**
 * The matching vocabulary, from the shared module.
 *
 * These used to live here privately. A second caller appeared — `screen_open_item`, which has to
 * decide whether a name is unambiguous *before* it presses anyone — so they moved to
 * `../screen-match`. The alternative was a copy, and a copy of this logic stays in step right up
 * until the day one of them learns about content descriptions and the other does not, at which
 * point a tool silently stops finding icon-only controls.
 */
import { MATCH_MODES, labelOf, matches, type MatchMode } from "../screen-match";

/** Re-exported so existing callers of this file (and its tests) keep working. */
export { MATCH_MODES, labelOf, matches, type MatchMode } from "../screen-match";

/**
 * Screen access through the privileged backend, in three postures.
 *
 * `cap-automation` used to be write-only: it could capture a picture, press a point
 * the *user* placed on it, scroll, and type. Nothing could read text off another app,
 * so "open A, get the number it is showing, put it into B" was not expressible — every
 * step had to be a person looking at a screenshot.
 *
 * These three close that gap using the accessibility tree that shell identity can
 * already read:
 *
 *  - `screen_read` — the whole window as text, each element numbered with its pixel
 *    centre. `risk: "read"`: it changes nothing, and it *reduces* how much screen
 *    content leaves the machine (a budgeted list of labels, never pixels). Prompting
 *    for it would mean asking the user to approve looking at a screen they are already
 *    looking at.
 *  - `screen_find` — one step instead of three. "Read the screen, remember which
 *    number the search box was, then tap it" is the same intent as "tap the search
 *    box", and a model that has to carry a number across two calls will eventually
 *    carry the wrong one. This resolves the label to a live element and presses it in
 *    a single approved action, verifying the text it read immediately before pressing.
 *  - `screen_tap_element` — the explicit form, for when the caller really does want to
 *    act on an element it identified itself.
 *
 * The two pressing tools share the same posture: `risk: "system"` with `alwaysAsk`, so nothing
 * in the conversation's allowlist can pre-grant a press. They also declare `mutates: false`,
 * consulted **only** inside a task the user confirmed as read-only — which is what lets "read
 * my playlist and look for a word" run without a prompt per swipe, while a task that sends or
 * deletes anything still asks at every step that changes something.
 *
 * Descriptions and hints are English because everything the model reads in this
 * package is; the wording a person sees is added in the app layer.
 */

/**
 * Limits for the three tools, declared once.
 *
 * `maxTextLength` bounds are the range a reading can sensibly act on: below the minimum
 * a label is too short to identify anything, above the maximum the caller should be
 * passing a narrower reading rather than one enormous field.
 */
const READ_LIMITS = {
  minTextLength: 16,
  maxTextLength: 2000,
  /** A node index is a position in a list, so the smallest one is zero. */
  minIndex: 0,
  /** Shortest label `screen_find` will act on, so "a" cannot match half a screen. */
  minQueryLength: 2,
  /** Most matches a search reports before it stops listing them. */
  maxMatches: 20,
  /**
   * What `screen_find` does when the caller does not say.
   *
   * `find`, not `tap`: a search that returns matches must not change the device as a side
   * effect. It is a named constant because it is applied in two places — the schema
   * default the model sees, and the guard inside `execute` (see the note there).
   */
  defaultFindAction: "find",
} as const;

/**
 * The thing that would actually receive a press aimed at `node`.
 *
 * In an Android accessibility tree the label usually sits on an inner `TextView` while
 * `clickable="true"` is on an ancestor `ViewGroup` — a bottom-navigation item, a list row, a
 * settings entry. Pressing the text node's centre is not a no-op that reports failure; the platform
 * dispatches the touch to the clickable ancestor anyway, so it usually *works*. But reporting the
 * text node as the target is wrong twice over: `screen_tap_element` refused it as "not pressable",
 * and the agent then fell back to a coordinate tap, which needs explicit user approval — turning an
 * ordinary press into a dialog the user has to answer.
 *
 * The ancestor is found by geometry rather than by walking the tree, because the parser flattens the
 * hierarchy and `ScreenNode` carries no parent. An ancestor's rectangle always contains its
 * descendant's, so "the smallest clickable node that contains this one" is the nearest clickable
 * ancestor. Smallest, not first: an outer clickable container (a whole scroll view) would swallow
 * the press in the wrong place.
 *
 * Returns `node` unchanged when it is already a usable target, and `undefined` when nothing
 * clickable contains it — in which case the honest answer is still "not pressable".
 */
export function pressTargetFor(node: ScreenNode, nodes: ScreenNode[]): ScreenNode | undefined {
  // Checked before the clickable test. A disabled control is `clickable="true"` with `enabled="false"`,
  // so folding the two together let it fall through to the ancestor search, find nothing, and report
  // "not pressable" — losing the real reason, which is the one the caller can act on.
  if (node.disabled === true) return node;
  if (node.clickable === true && node.bounds) return node;
  if (!node.bounds) return undefined;

  const { centerX, centerY } = node.bounds;
  let best: ScreenNode | undefined;
  let bestArea = Number.POSITIVE_INFINITY;

  for (const candidate of nodes) {
    if (candidate === node) continue;
    // A disabled ancestor is the control the press would have gone to, so returning it is more
    // useful than "nothing clickable here": the caller learns the thing is switched off.
    if (candidate.clickable !== true) continue;
    if (candidate.disabled === true) return candidate;
    const bounds = candidate.bounds;
    if (!bounds) continue;
    // The centre of the text is what a finger would land on, so containment is tested with the
    // point rather than by comparing the two rectangles: a wide row's bounds can extend past the
    // label it holds, and a point test asks the question that matters.
    if (centerX < bounds.left || centerX > bounds.right) continue;
    if (centerY < bounds.top || centerY > bounds.bottom) continue;
    const area = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
    if (area < bestArea) {
      best = candidate;
      bestArea = area;
    }
  }

  return best;
}

/**
 * Pick the element a query most likely means.
 *
 * An exact label wins outright. Otherwise a *pressable* element beats a larger one that
 * merely contains the text: in an accessibility tree the text is usually carried by an
 * inner `TextView` while the thing that responds to a finger is its clickable ancestor,
 * so preferring the container is what makes a search for a label press what a person
 * would press. Length is the final tie-break — the shortest label that still matched is
 * the most specific one.
 */
function bestMatch(nodes: ScreenNode[]): ScreenNode | undefined {
  const pressable = nodes.filter((node) => node.clickable === true && node.disabled !== true);
  const pool = pressable.length > 0 ? pressable : nodes;
  return [...pool].sort((a, b) => labelOf(a).length - labelOf(b).length)[0];
}

/** One match, as the caller sees it. */
function describeMatch(node: ScreenNode): Record<string, unknown> {
  return {
    index: node.index,
    label: labelOf(node),
    ...(node.className ? { className: node.className } : {}),
    pressable: node.clickable === true,
    ...(node.disabled === true ? { disabled: true } : {}),
    ...(node.bounds ? { center: { x: node.bounds.centerX, y: node.bounds.centerY } } : {}),
  };
}

export function createScreenReadTools(deps: { system: SystemService }): AnyToolDefinition[] {
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
   * Warn rather than guess when the app that was read is no longer the app in front.
   *
   * The gap between a reading and a press is exactly when a stray notification or the
   * user's own thumb can move the foreground, and pressing a remembered coordinate in
   * the wrong app is a real, unlogged action.
   */
  async function foregroundChangedFrom(
    automation: AutomationService,
    reading: string | undefined,
  ): Promise<string | undefined> {
    if (!reading) return undefined;
    try {
      const current = await automation.currentWindow();
      if (current.package && current.package !== reading) {
        return `the foreground app changed from ${reading} to ${current.package} since this reading`;
      }
    } catch {
      // Best effort, like `screen_current`: an unreadable foreground is not a finding.
    }
    return undefined;
  }

  const screenRead = {
    name: "screen_read",
    description:
      "Read the current screen as text through the privileged backend: each element with its label, its kind, its state, and the pixel point to press. Prefer this over screen_capture whenever you need to know what is on screen — a picture cannot be read by you, and this returns the same window as text. Reach for it as a fallback, though, not as the first move: if the job can be done with system_open (an app or a URL), a deep link, or a purpose-built tool, do that instead — this path depends on the current layout, breaks on animation, and every action it enables is a real tap the user did not ask for. It reads the accessibility tree, so it sees only what an app publishes: a canvas, a game or a video may return little or nothing, and an app that hides its contents (FLAG_SECURE, banking) returns nothing at all. When the reading is thin, say so instead of assuming the screen is empty.\n" +
      "Set `scrollThrough` when you need the *whole* of a scrolling page (a long chat, a playlist, a list you have to search): it scrolls and reads repeatedly **inside this one call**, so a page that would cost a step per screen costs one step. It reports how many screens it read and whether it found the end, and the result is for reading and searching — press points stay valid only for the screen that is in front, so re-read before tapping.",
    input: z.object({
      maxTextLength: z
        .number()
        .int()
        .min(READ_LIMITS.minTextLength)
        .max(READ_LIMITS.maxTextLength)
        .optional()
        .describe("Longest label to return per element. Longer text is shortened and the result says so."),
      scrollThrough: z
        .boolean()
        .optional()
        .describe(
          "Keep scrolling and reading until the content stops growing, and return everything found. " +
            "Use it instead of alternating screen_read and screen_scroll by hand.",
        ),
      maxScreens: z
        .number()
        .int()
        .min(1)
        .max(SCROLL_TOOL_LIMITS.maxScreens)
        .optional()
        .describe(
          `Most screens to read when scrollThrough is set. Defaults to ${SCROLL_THROUGH_DEFAULTS.maxScreens}; ` +
            "the result says so when this limit stopped it.",
        ),
    }),
    risk: "read",
    category: "screen-read",
    requires: ["shizuku"],
    async execute(
      input: { maxTextLength?: number; scrollThrough?: boolean; maxScreens?: number },
      ctx: { signal?: AbortSignal },
    ) {
      const automation = await requireScreen("reading the screen");
      const readOptions = input.maxTextLength === undefined ? {} : { maxTextLength: input.maxTextLength };

      if (!input.scrollThrough) {
        const snapshot = await automation.readScreen(readOptions);
        const reading = formatScreenReading(snapshot);
        return { ...reading.snapshot, reading: reading.text };
      }

      const walk = await scrollThrough(
        () => automation.readScreen(readOptions),
        // Down, because the walk is about moving onwards through the content. The amount is left to
        // the platform's own step: overriding it here would guess at a geometry this layer cannot see.
        (amount) => automation.scroll("down", amount),
        {
          ...(input.maxScreens === undefined ? {} : { maxScreens: input.maxScreens }),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
      );

      // The collected elements are described from the **last** reading, because that is the only one
      // whose press points are still valid: bounds are relative to the screen they came from. The
      // earlier screens are reported as what they are — content that was read, to be searched.
      const lastReading = formatScreenReading(walk.last);
      const earlier = walk.nodes.length - walk.last.nodes.length;
      return {
        ...lastReading.snapshot,
        reading: lastReading.text,
        scrolled: {
          screens: walk.screens,
          elementsAcrossScreens: walk.nodes.length,
          elementsBeforeTheLastScreen: Math.max(0, earlier),
          stoppedBecause: walk.stoppedBecause,
          incomplete: walk.incomplete,
          note: describeScrollThrough(walk, walk.nodes.length),
        },
      };
    },
  } satisfies AnyToolDefinition;

  /**
   * Press an element that a previous reading numbered.
   *
   * This is the other half of the contract `screen_tap` already had: the point still
   * has to come from somewhere real (the model cannot see the screen), but now it can
   * come from a node's reported bounds instead of only from a person's thumb. It stays
   * a separate tool so the two ways of aiming — by node, by hand — are both explicit
   * and neither is guessed from the shape of the input.
   */
  const screenTapElement = {
    name: "screen_tap_element",
    description:
      "Press an element by the `#` number that screen_read printed, through the privileged backend. An element that reported `tap` is pressed directly; a label inside a clickable control is resolved to that control, because the platform dispatches the touch there anyway and refusing it would send the caller to a by-hand coordinate press that the user has to approve. An element that nothing clickable contains cannot be pressed. Call screen_read first, in the same turn, so the number refers to the screen that is actually in front. Returns a screenshot of the result.",
    input: z.object({
      index: z
        .number()
        .int()
        .min(READ_LIMITS.minIndex)
        .describe("The # number of an element from the most recent screen_read."),
      target: z
        .string()
        .min(1)
        .optional()
        .describe("What you expect that element to be, for the transcript. Taken from the reading."),
      reading: z
        .string()
        .optional()
        .describe("The app package the reading was taken from, so a changed foreground can be reported."),
    }),
    risk: "system",
    category: "screen-act",
    requires: ["shizuku"],
    alwaysAsk: true,
    /** Same reasoning as `screen_find`: a press navigates, and only a scope relaxes it. */
    mutates: false,
    summarize: (input: { index: number; target?: string }) =>
      `tap element #${input.index}${input.target ? ` (${input.target})` : ""}`,
    async execute(
      input: { index: number; target?: string; reading?: string },
      ctx: { workspace?: string },
    ) {
      const automation = await requireScreen("pressing a screen element");

      // The reading is re-taken here rather than trusted from an earlier turn: the
      // numbering belongs to a screen, and a screen that has scrolled has a different
      // one. Re-reading costs a command and removes the whole class of "pressed what
      // used to be there" mistakes.
      const snapshot = await automation.readScreen({});
      const node: ScreenNode | undefined = snapshot.nodes.find(
        (candidate) => candidate.index === input.index,
      );
      if (!node) {
        // The reading's own note goes into the error when it has one. A re-read that
        // could not see the screen (a protected window, a canvas, a failed dump) leaves
        // no elements at all, and "the numbering changed" would then be a confident
        // explanation for something that did not happen — the same conflation of
        // "nothing readable" with "nothing there" that `screen_read` exists to avoid.
        const note = snapshot.note === undefined ? "" : ` The reading also reported: ${snapshot.note}.`;
        // The actual range is stated, not just the fact of a mismatch. "The numbering changed" leaves
        // the caller to re-read and guess again; knowing the screen now holds 0..44 says immediately
        // whether #49 was one node past the end, or whether the screen is a different one entirely.
        const range =
          snapshot.nodes.length === 0
            ? "it currently has no numbered elements at all"
            : `it currently numbers elements 0..${snapshot.nodes.length - 1}`;
        throw new CoreError("E_TOOL_FAILED", `element #${input.index} is not on the current screen`, {
          hint: `Read the screen again with screen_read in the same turn and use a number from that reading: ${range}, so #${input.index} is not a number this screen uses.${note}`,
        });
      }
      // Resolve to whatever would really receive the press. An index pointing at a label inside a
      // clickable row is a legitimate thing to ask for: the reading numbers the text because that is
      // what has the words on it, and refusing it would send the agent to `screen_tap`, which needs
      // the user to approve every coordinate by hand.
      const target = pressTargetFor(node, snapshot.nodes);
      if (!target || !target.bounds) {
        throw new CoreError("E_TOOL_FAILED", `element #${input.index} is not pressable`, {
          hint: "Nothing clickable contains this element, so a press at its centre would do nothing. Elements shown with `tap` in screen_read are the ones that respond; read again to see the current numbering.",
        });
      }
      if (target.disabled === true) {
        throw new CoreError("E_TOOL_FAILED", `element #${input.index} is present but disabled`, {
          hint: "The app has it on screen but switched off. Wait for the state to change, or choose another element.",
        });
      }

      const width = snapshot.width;
      const height = snapshot.height;
      if (width === undefined || height === undefined || width <= 0 || height <= 0) {
        throw new CoreError("E_TOOL_FAILED", "the display size is unknown for this reading", {
          hint: "The display size comes from the privileged backend (`wm size`), not from the picture, so a reading without one means the backend could not measure the screen. Read the screen again, and if it keeps happening the privileged backend is not working: check shizuku_status.",
        });
      }

      const changed = await foregroundChangedFrom(automation, input.reading);
      await automation.tap(target.bounds.centerX / width, target.bounds.centerY / height);

      const result: Record<string, unknown> = {
        index: input.index,
        pressed: { x: target.bounds.centerX, y: target.bounds.centerY },
        label: node.text ?? node.description ?? null,
      };
      // Said explicitly when the press went to an ancestor, so the transcript records what was
      // actually pressed rather than only what was asked for. A caller reading back the result
      // should not have to infer that the coordinates belong to a container.
      if (target !== node) {
        result.resolvedTo = {
          index: target.index,
          className: target.className ?? null,
          label: labelOf(target),
          note: "the numbered element is a label inside this control; the press was aimed at the control",
        };
      }
      if (input.target !== undefined) result.target = input.target;
      if (changed !== undefined) result.warning = changed;

      try {
        const shot = await automation.captureScreen({
          quality: SCREEN_DEFAULTS.evidenceQuality,
          ...(ctx.workspace ? { destDir: ctx.workspace } : {}),
        });
        result.evidence = {
          path: shot.path,
          width: shot.width,
          height: shot.height,
          ...(shot.note ? { note: shot.note } : {}),
        };
      } catch (error) {
        result.evidenceNote = `evidence capture failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      return result;
    },
  } satisfies AnyToolDefinition;

  /**
   * Find an element by what it says, and optionally press it.
   *
   * This exists because the two-step version is what a model actually gets wrong. Asking
   * for "read the screen, then press element #7" makes correctness depend on a number
   * surviving across two tool calls, and on nothing having scrolled in between. Asking
   * for "press the thing labelled 搜索" states the intent once, and the resolution happens
   * against the screen that is in front at the moment of the press.
   *
   * `do` defaults to `find` rather than `tap` so that discovery is free of consequence:
   * the tool only changes the screen when the caller says so.
   */
  const screenFind = {
    name: "screen_find",
    description:
      "Find an element on the current screen by its label, and optionally press it. Use this instead of reading the screen and pressing by number: it resolves the label against the live screen in one step, so no element number has to survive across calls. Matches text and content descriptions, so it finds icon-only controls by their accessible name. With `do: \"find\"` (the default) nothing is pressed and it only reports what matched — use that first when you are unsure, then repeat with `do: \"tap\"`.",
    input: z.object({
      query: z
        .string()
        .min(READ_LIMITS.minQueryLength)
        .describe("The label to look for, for example 搜索 or Sign in."),
      mode: z
        .enum(MATCH_MODES)
        .optional()
        .default("contains")
        .describe("contains (default), exact, or regex. Contains is case-insensitive."),
      do: z
        .enum(["find", "tap"])
        .optional()
        .default(READ_LIMITS.defaultFindAction)
        .describe("find only reports; tap presses the best match. Nothing is pressed by default."),
      expect: z
        .string()
        .optional()
        .describe("Text you expect the screen to be showing, checked before acting. Use it to prove the app reached the right state rather than assuming it."),
    }),
    risk: "system",
    category: "screen-act",
    requires: ["shizuku"],
    alwaysAsk: true,
    /**
     * A press navigates. It is not itself a change — the change is what the app decides to
     * do about it, which is why the tool name says the element, not the outcome.
     *
     * The declaration is only consulted inside a read-only task scope. Outside one, this
     * still asks every time; inside one, "read my playlist" no longer needs approval to open
     * a song.
     *
     * `neverRemember` is deliberately **absent**. Leaving it on would keep the prompt alive
     * even in a read-only task and defeat the scope entirely, while removing it costs
     * nothing outside the scope: without `mutates: false` in force, an allowlist is still
     * the only way to pre-grant this, and `alwaysAsk` still blocks that.
     */
    mutates: false,
    summarize: (input: { query: string; do?: string }) =>
      `${input.do === "tap" ? "tap" : "find"} "${input.query}"`,
    async execute(
      input: { query: string; mode?: MatchMode; do?: "find" | "tap"; expect?: string },
      ctx: { workspace?: string },
    ) {
      const automation = await requireScreen("searching the screen");
      const snapshot: ScreenSnapshot = await automation.readScreen({});

      // The defaults are applied here as well as in the schema on purpose. Zod fills an
      // omitted optional only when the input passes through the registry's parse; a caller
      // that invokes `execute` directly (a test, or any future host) would otherwise reach
      // the tap branch having asked for nothing of the sort. An unsafe default that
      // depends on how the tool was called is not a default.
      const mode: MatchMode = input.mode ?? "contains";
      const action: "find" | "tap" = input.do ?? READ_LIMITS.defaultFindAction;

      const matchesList = snapshot.nodes.filter((node) => matches(node, input.query, mode));
      const found = matchesList.slice(0, READ_LIMITS.maxMatches).map(describeMatch);

      if (matchesList.length === 0) {
        // Told apart on purpose: "the screen could not be read" and "the label is not
        // here" look identical in a zero-match result, and only one of them means the
        // caller should try a different label.
        const because =
          snapshot.note ??
          (snapshot.nodes.length === 0
            ? "the screen produced no readable elements"
            : `${snapshot.nodes.length} element(s) were read, none matching`);
        return {
          found: false,
          matches: [],
          searched: snapshot.nodes.length,
          app: snapshot.package ?? null,
          reason: because,
        };
      }

      // A guard against acting on the wrong screen, not a guess about what is there: the
      // caller states what it expects to see, and the reading is what decides.
      if (input.expect !== undefined && !snapshot.nodes.some((node) => matches(node, input.expect as string, "contains"))) {
        throw new CoreError("E_TOOL_FAILED", `the screen does not show "${input.expect}"`, {
          hint: `The query "${input.query}" did match ${matchesList.length} element(s), but only after the expected text was missing — which usually means the app is on a different screen than intended. Re-read with screen_read and look at app and elements count before acting.`,
          ...(snapshot.package ? { app: snapshot.package } : {}),
        });
      }

      if (action === "find") {
        return {
          found: true,
          matches: found,
          searched: snapshot.nodes.length,
          app: snapshot.package ?? null,
          ...(matchesList.length > found.length ? { moreMatches: matchesList.length - found.length } : {}),
        };
      }

      const chosen = bestMatch(matchesList);
      if (!chosen || !chosen.bounds) {
        throw new CoreError("E_TOOL_FAILED", `"${input.query}" matched but has no pressable position`, {
          hint: "The element is present in the tree without bounds, so there is nowhere to press. Re-read with screen_read to see what is actually on screen.",
        });
      }
      if (chosen.clickable !== true) {
        throw new CoreError("E_TOOL_FAILED", `"${input.query}" is not pressable`, {
          hint: `The match is a ${chosen.className ?? "node"} that reports no click action — its text is displayed, not tapped. Nothing else on screen matched either.`,
        });
      }
      if (chosen.disabled === true) {
        throw new CoreError("E_TOOL_FAILED", `"${input.query}" is present but disabled`, {
          hint: "The app shows it but has it switched off. Wait for the state to change, or choose another element.",
        });
      }

      const width = snapshot.width;
      const height = snapshot.height;
      if (width === undefined || height === undefined || width <= 0 || height <= 0) {
        throw new CoreError("E_TOOL_FAILED", "the display size is unknown for this reading", {
          hint: "The display size comes from the privileged backend (`wm size`), not from the picture. Read the screen again; if it keeps happening, check shizuku_status.",
        });
      }

      const changed = await foregroundChangedFrom(automation, snapshot.package);
      await automation.tap(chosen.bounds.centerX / width, chosen.bounds.centerY / height);

      const result: Record<string, unknown> = {
        tapped: describeMatch(chosen),
        matches: found,
        app: snapshot.package ?? null,
      };
      if (changed !== undefined) result.warning = changed;

      // The reading that was used for the decision is kept, so the transcript records
      // what the press was aimed at rather than only where it landed.
      const reading = formatScreenReading(snapshot);
      result.reading = reading.text;

      try {
        const shot = await automation.captureScreen({
          quality: SCREEN_DEFAULTS.evidenceQuality,
          ...(ctx.workspace ? { destDir: ctx.workspace } : {}),
        });
        result.evidence = {
          path: shot.path,
          width: shot.width,
          height: shot.height,
          ...(shot.note ? { note: shot.note } : {}),
        };
      } catch (error) {
        result.evidenceNote = `evidence capture failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      return result;
    },
  } satisfies AnyToolDefinition;

  return [screenRead, screenFind, screenTapElement];
}
