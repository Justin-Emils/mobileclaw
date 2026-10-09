/**
 * Parser for an Android `uiautomator dump`.
 *
 * Why this is the reading channel: the privileged backend holds shell identity
 * (uid 2000 through Shizuku), and shell may read *any* application's accessibility
 * tree. That yields the text, the content descriptions and each node's real
 * on-screen bounds — so a press can be aimed without the model ever seeing the
 * screen, and without declaring an `AccessibilityService` (a second permission, a
 * second settings visit) to get the same tree.
 *
 * The format is not guessed. `AccessibilityNodeInfoDumper` writes:
 *
 *     <hierarchy rotation="0">
 *       <node index="0" text="" resource-id="" class="android.widget.FrameLayout"
 *             package="com.example" content-desc="" checkable="false" checked="false"
 *             clickable="false" enabled="true" focusable="false" focused="false"
 *             scrollable="false" long-clickable="false" password="false"
 *             selected="false" bounds="[0,0][1080,2400]" drawing-order="0" hint="" />
 *     </hierarchy>
 *
 * and a multi-window dump nests that under `<displays><display id=..><window ..>`.
 * Both shapes are accepted here: which one a device produces depends on the
 * `uiautomator` binary, not on anything this app controls.
 *
 * Hand-written rather than DOM-based on purpose. `DOMParser` does not exist in React
 * Native's Hermes, the dump can be most of a megabyte, and only these attributes
 * matter — so the scanner walks tags once and builds no intermediate tree.
 *
 * Nothing here touches the filesystem, a process or a platform module. The command
 * that produces the XML lives in `./android-ui-dump`; this file is the projection,
 * which is the part worth testing.
 */
import { SCREEN_DEFAULTS, type ScreenBounds, type ScreenNode, type ScreenSnapshot } from "@mobileclaw/core";

/** An opening or self-closing tag, which is all the dump contains. */
const TAG_PATTERN = /<([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*\/?>/g;

/** One `name="value"` pair. Attribute values may be empty. */
const ATTRIBUTE_PATTERN = /([\w-]+)="([^"]*)"/g;

/** `[left,top][right,bottom]`, each corner optionally negative. */
const BOUNDS_PATTERN = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

/**
 * A node that carries no readable text and cannot be pressed is structure, not
 * information. Dropping them is what turns a megabyte of layout into a screenful.
 */
const STRUCTURAL_ONLY = "the dump contained only structural nodes (no text, no label, nothing pressable)";

export interface UiautomatorNode {
  text: string;
  /** `content-desc`: for an icon-only control this is the label. */
  description: string;
  className: string;
  packageName: string;
  resourceId: string;
  bounds?: ScreenBounds;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  enabled: boolean;
  password: boolean;
  checkable: boolean;
  checked: boolean;
  selected: boolean;
  focused: boolean;
}

export interface ScreenDump {
  nodes: UiautomatorNode[];
  rotation?: number;
  /** `[left,top][right,bottom]` of the dumped window, when it was reported. */
  windowBounds?: ScreenBounds;
  /** When the dump wrote a root node that could not be parsed. */
  malformed: boolean;
  /** More than one window or display was dumped. */
  multiWindow: boolean;
}

/** Shorten to a budget, saying so rather than cutting silently. */
export function shorten(text: string, maxLength: number): { text: string; truncated: boolean } {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return { text: collapsed, truncated: false };
  return { text: `${collapsed.slice(0, maxLength)}...`, truncated: true };
}

/**
 * Parse `[left,top][right,bottom]` into a rectangle with its centre resolved.
 *
 * A reversed or empty rectangle is reported as absent rather than normalised into a
 * plausible-looking one: a node whose bounds are `[0,0][0,0]` is one the platform
 * could not place, and pressing its "centre" would press the top-left corner of the
 * screen while looking perfectly well-formed.
 */
export function parseBounds(raw: string | undefined): ScreenBounds | undefined {
  if (!raw) return undefined;
  const match = BOUNDS_PATTERN.exec(raw.trim());
  if (!match) return undefined;

  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return undefined;

  return {
    left,
    top,
    right,
    bottom,
    width,
    height,
    centerX: left + Math.floor(width / 2),
    centerY: top + Math.floor(height / 2),
  };
}

function attributesOf(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  ATTRIBUTE_PATTERN.lastIndex = 0;
  for (let match = ATTRIBUTE_PATTERN.exec(raw); match; match = ATTRIBUTE_PATTERN.exec(raw)) {
    const name = match[1];
    if (name !== undefined) attributes.set(name, match[2] ?? "");
  }
  return attributes;
}

function isTrue(attributes: Map<string, string>, name: string): boolean {
  return attributes.get(name) === "true";
}

/** Walk every tag once and keep only the `<node>` elements. */
export function parseScreenDump(xml: string, options: { keepEmpty?: boolean } = {}): ScreenDump {
  const keepEmpty = options.keepEmpty === true;
  const nodes: UiautomatorNode[] = [];

  let rotation: number | undefined;
  let windowBounds: ScreenBounds | undefined;
  let displayBounds: ScreenBounds | undefined;
  let sawWindowElement = false;
  let malformed = false;
  let hierarchyCount = 0;
  let nodeCount = 0;

  TAG_PATTERN.lastIndex = 0;
  for (let match = TAG_PATTERN.exec(xml); match; match = TAG_PATTERN.exec(xml)) {
    const tag = match[1];
    const attributes = attributesOf(match[2] ?? "");

    switch (tag) {
      case "hierarchy": {
        hierarchyCount += 1;
        const raw = attributes.get("rotation");
        const parsed = raw === undefined ? Number.NaN : Number(raw);
        if (Number.isInteger(parsed) && rotation === undefined) rotation = parsed;
        break;
      }
      case "window":
      case "display": {
        // A window's own bounds are a better answer than any node's, because a window
        // is not clipped to its content. They matter: the first *node* of a dump is
        // whatever the hierarchy happens to start with, and for a dialog or a
        // notification shade that is a small rectangle, not the screen. Taking the
        // size from it made a press land on the display edge (see `projectScreen`).
        const bounds = parseBounds(attributes.get("bounds"));
        if (tag === "window") {
          sawWindowElement = true;
          if (bounds && !windowBounds) windowBounds = bounds;
        } else if (bounds && !displayBounds) {
          // `<display>` is the whole screen and outranks a window: a floating window
          // can be smaller than the display it sits on.
          displayBounds = bounds;
        }
        break;
      }
      case "node": {
        nodeCount += 1;
        const bounds = parseBounds(attributes.get("bounds"));
        // Only a fallback: used when the dump carried no `<window>`, which is the
        // older single-window shape that starts at a full-screen root.
        if (bounds && !windowBounds && !sawWindowElement) windowBounds = bounds;

        const node: UiautomatorNode = {
          text: attributes.get("text") ?? "",
          description: attributes.get("content-desc") ?? "",
          className: attributes.get("class") ?? "",
          packageName: attributes.get("package") ?? "",
          resourceId: attributes.get("resource-id") ?? "",
          clickable: isTrue(attributes, "clickable"),
          longClickable: isTrue(attributes, "long-clickable"),
          scrollable: isTrue(attributes, "scrollable"),
          enabled: attributes.get("enabled") !== "false",
          password: isTrue(attributes, "password"),
          checkable: isTrue(attributes, "checkable"),
          checked: isTrue(attributes, "checked"),
          selected: isTrue(attributes, "selected"),
          focused: isTrue(attributes, "focused"),
        };
        if (bounds) node.bounds = bounds;

        // A node with no bounds, no text and no label is either an artefact of an
        // empty window or the shape of a dump that went wrong. Both are worth
        // knowing about, and neither is worth sending to the model.
        if (keepEmpty || bounds || node.text !== "" || node.description !== "" || node.clickable) {
          nodes.push(node);
        } else {
          malformed = true;
        }
        break;
      }
      default:
        break;
    }
  }

  const dump: ScreenDump = {
    nodes,
    malformed: malformed && nodeCount > 0,
    multiWindow: hierarchyCount > 1,
  };
  if (rotation !== undefined) dump.rotation = rotation;
  // Widest rectangle wins: the display if the dump named one, otherwise the window,
  // otherwise the first node seen (the older single-window shape).
  const screen = pickWidest(displayBounds, windowBounds);
  if (screen) dump.windowBounds = screen;
  return dump;
}

/**
 * The rectangle that most plausibly describes the whole screen.
 *
 * Not the union of every node: window decor can report bounds slightly outside the
 * display, and a union would then produce a screen larger than the device, which
 * would push every press fraction towards the centre. Between the two candidates the
 * larger area is the safer answer, because the failure it produces (a point computed
 * against a slightly generous screen) is bounded, while the failure of a too-small
 * one is a press clamped to the display edge.
 */
function pickWidest(
  a: ScreenBounds | undefined,
  b: ScreenBounds | undefined,
): ScreenBounds | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.width * a.height >= b.width * b.height ? a : b;
}

/** Short class name, so the reading says `EditText` rather than the full package. */
function shortClassName(className: string): string | undefined {
  if (className === "") return undefined;
  const parts = className.split(".");
  return parts[parts.length - 1] ?? undefined;
}

/** Whether this node is worth a line: something to read, or something to press. */
function isInformative(node: UiautomatorNode): boolean {
  return node.text !== "" || node.description !== "" || node.clickable || node.scrollable;
}

/**
 * Project a dump down to the nodes a model can act on, inside a budget.
 *
 * Deduplication is not cosmetic: the dumper repeats a container's text on the child
 * that actually draws it, so `text` and `content-desc` frequently hold the same
 * string at the same rectangle. Sending both spends the budget twice on one fact and
 * shows the model a list where every label appears to be its own button.
 */
export function projectScreen(
  dump: ScreenDump,
  options: {
    maxNodes?: number;
    maxChars?: number;
    maxTextLength?: number;
    /** The measured display size; overrides anything the dump implies. */
    display?: { width: number; height: number };
  } = {},
): ScreenSnapshot {
  const maxNodes = options.maxNodes ?? SCREEN_DEFAULTS.readMaxNodes;
  const maxChars = options.maxChars ?? SCREEN_DEFAULTS.readMaxChars;
  const maxTextLength = options.maxTextLength ?? SCREEN_DEFAULTS.readMaxTextLength;

  const selected: ScreenNode[] = [];
  const seen = new Set<string>();
  let chars = 0;
  let truncatedNodes = 0;
  let truncatedText = false;
  let dominantPackage = "";

  for (const node of dump.nodes) {
    if (node.packageName !== "" && dominantPackage === "") dominantPackage = node.packageName;

    if (!isInformative(node)) continue;

    const key = `${node.text}|${node.description}|${node.bounds?.left ?? ""},${node.bounds?.top ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const text = node.text === "" ? undefined : shorten(node.text, maxTextLength);
    const description =
      node.description === "" || node.description === node.text
        ? undefined
        : shorten(node.description, maxTextLength);
    if (text?.truncated === true || description?.truncated === true) truncatedText = true;

    const cost = (text?.text.length ?? 0) + (description?.text.length ?? 0);
    if (selected.length >= maxNodes || chars + cost > maxChars) {
      truncatedNodes += 1;
      continue;
    }
    chars += cost;

    const entry: ScreenNode = { index: selected.length };
    if (text) entry.text = text.text;
    if (description) entry.description = description.text;
    const className = shortClassName(node.className);
    if (className) entry.className = className;
    if (node.resourceId !== "") entry.resourceId = node.resourceId;
    if (node.bounds) entry.bounds = node.bounds;
    if (node.clickable) entry.clickable = true;
    if (node.longClickable) entry.longClickable = true;
    if (node.scrollable) entry.scrollable = true;
    if (!node.enabled) entry.disabled = true;
    if (node.password) entry.password = true;
    if (node.checkable) {
      entry.checkable = true;
      if (node.checked) entry.checked = true;
    }
    if (node.selected) entry.selected = true;
    if (node.focused) entry.focused = true;

    selected.push(entry);
  }

  const display = options.display ?? dump.windowBounds;
  const snapshot: ScreenSnapshot = {
    nodes: selected,
    total: dump.nodes.length,
  };
  if (display) {
    snapshot.width = display.width;
    snapshot.height = display.height;
  }
  if (dump.rotation !== undefined) snapshot.rotation = dump.rotation;
  if (dominantPackage !== "") snapshot.package = dominantPackage;
  if (truncatedNodes > 0) snapshot.truncatedNodes = truncatedNodes;
  if (truncatedText) snapshot.truncatedText = true;
  if (dump.multiWindow) snapshot.multiWindow = true;
  if (selected.length === 0) {
    snapshot.note = dump.nodes.length === 0 ? "the screen could not be read" : STRUCTURAL_ONLY;
  }
  return snapshot;
}

/** Scratch space between the header and the element list, where the cut is reported. */
const OMITTED_MARKER_BUDGET = 48;

/** One element, as the model sees it. */
function formatNode(node: ScreenNode): string {
  const label = node.text ?? node.description ?? "(unlabelled)";
  const traits: string[] = [];
  if (node.clickable) traits.push("tap");
  if (node.scrollable) traits.push("scroll");
  if (node.disabled) traits.push("disabled");
  if (node.password) traits.push("password");
  if (node.checkable) traits.push(node.checked ? "checked" : "unchecked");
  if (node.focused) traits.push("focused");

  const parts = [`#${node.index}`, `"${label}"`];
  if (node.text !== undefined && node.description !== undefined) {
    parts.push(`label="${node.description}"`);
  }
  if (node.className) parts.push(node.className);
  if (traits.length > 0) parts.push(traits.join(","));
  if (node.bounds) parts.push(`center=${node.bounds.centerX},${node.bounds.centerY}`);
  return `- ${parts.join(" ")}`;
}

/**
 * The text form handed to the model, and the structured form kept for the caller.
 *
 * Both come out of one call so the numbered list the model reads and the array an
 * adapter iterates can never disagree about which element is `#3`.
 *
 * The character budget is a parameter rather than the global default because each
 * reading's size is decided per call: a caller that narrowed `projectScreen` to a
 * smaller budget must not have the formatter quietly re-expand it to the default,
 * which would make the "kept within N characters" promise a lie.
 */
export function formatScreenReading(
  snapshot: ScreenSnapshot,
  options: { maxChars?: number } = {},
): { text: string; snapshot: ScreenSnapshot } {
  const maxChars = options.maxChars ?? SCREEN_DEFAULTS.readMaxChars;
  const head: string[] = [];
  if (snapshot.package) head.push(`app: ${snapshot.package}`);
  if (snapshot.width !== undefined && snapshot.height !== undefined) {
    const rotation = snapshot.rotation === undefined ? "" : ` rotation=${snapshot.rotation}`;
    head.push(`display: ${snapshot.width}x${snapshot.height}${rotation}`);
  }
  head.push(`elements: ${snapshot.nodes.length} of ${snapshot.total} nodes`);

  const lines = snapshot.nodes.map(formatNode);

  // The character budget is applied by dropping whole elements from the end, never by
  // cutting one in half: a half element reads as a real, unlabelled control.
  let omitted = 0;
  let body = lines.join("\n");
  const headLength = head.join("\n").length;
  const room = Math.max(maxChars - headLength, 0);
  if (body.length > room) {
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > Math.max(room - OMITTED_MARKER_BUDGET, 0)) break;
      kept.push(line);
      used += line.length + 1;
    }
    omitted = lines.length - kept.length;
    body = kept.join("\n");
  }

  const footer: string[] = [];
  if (omitted > 0) footer.push(`... ${omitted} more element(s) omitted to fit the reading budget`);
  if (snapshot.truncatedNodes !== undefined && snapshot.truncatedNodes > 0) {
    footer.push(`${snapshot.truncatedNodes} further node(s) were dropped as low-information`);
  }
  if (snapshot.truncatedText === true) footer.push("some text was shortened");
  if (snapshot.multiWindow === true) footer.push("more than one window was dumped");
  if (snapshot.note !== undefined) footer.push(snapshot.note);

  const text = [head.join("\n"), body, footer.join("\n")]
    .filter((part) => part !== "")
    .join("\n");

  return { text, snapshot };
}
