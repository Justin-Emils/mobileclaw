import { describe, expect, it } from "vitest";
import {
  DUMP_COMMANDS,
  DUMP_FILE_PATH,
  formatScreenReading,
  interpretDump,
  parseBounds,
  parseScreenDump,
  projectScreen,
  shorten,
} from "@mobileclaw/capabilities";
import type { ScreenSnapshot } from "@mobileclaw/core";

/**
 * The reading channel.
 *
 * What is pinned here is the boundary between "this screen has little on it" and
 * "this screen could not be read" — the same distinction the storage tools had to be
 * fixed for, where a permission problem was reported as a finding about the user's
 * files. A parser that quietly returns nothing on a bad dump reproduces that defect
 * one layer down, and the model then tells the user their screen is empty.
 *
 * The fixtures are the real dump shape, copied from what
 * `AccessibilityNodeInfoDumper` writes (see the header of `ui-dump.ts`), including
 * the `\uXXXX` values: a dump of a Chinese app is still well-formed XML, and a parser
 * that only survives ASCII would fail on exactly the devices this is for.
 */

/** Current-generation dump: one window. */
const SINGLE_WINDOW = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.chat" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]" drawing-order="0" hint="" />
  <node index="1" text="\u641c\u7d22" resource-id="com.example.chat:id/search" class="android.widget.EditText" package="com.example.chat" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[100,200][980,300]" drawing-order="0" hint="\u641c\u7d22" />
  <node index="2" text="\u5bc6\u7801" resource-id="com.example.chat:id/pw" class="android.widget.EditText" package="com.example.chat" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="false" password="true" selected="false" bounds="[100,320][980,420]" drawing-order="0" hint="" />
  <node index="3" text="" resource-id="com.example.chat:id/avatar" class="android.widget.ImageView" package="com.example.chat" content-desc="\u5934\u50cf" checkable="false" checked="false" clickable="true" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,40][140,140]" drawing-order="0" hint="" />
  <node index="4" text="\u53d1\u9001" resource-id="com.example.chat:id/send" class="android.widget.Button" package="com.example.chat" content-desc="" checkable="false" checked="false" clickable="true" enabled="false" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[900,2200][1060,2320]" drawing-order="0" hint="" />
</hierarchy>`;

/** A pure container: no text, no label, not pressable. Structure, not information. */
const STRUCTURAL_ONLY = `<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.chat" content-desc="" clickable="false" enabled="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]" />
  <node index="1" text="" resource-id="" class="android.widget.LinearLayout" package="com.example.chat" content-desc="" clickable="false" enabled="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,300]" />
</hierarchy>`;

/** Newer shape: the same hierarchy nested inside a window on a display. */
const MULTI_WINDOW = `<displays>
  <display id="0">
    <window index="0" title="Chat" active="true" focused="true" bounds="[0,0][1080,2400]" type="application">
      <hierarchy rotation="0">
        <node index="0" text="Hello" class="android.widget.TextView" package="com.example.chat" content-desc="" clickable="false" enabled="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,100][400,200]" />
      </hierarchy>
    </window>
    <window index="1" title="Notification" active="false" focused="false" bounds="[0,0][1080,400]" type="system">
      <hierarchy rotation="0">
        <node index="0" text="New message" class="android.widget.TextView" package="com.android.systemui" content-desc="" clickable="true" enabled="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,50][900,150]" />
      </hierarchy>
    </window>
  </display>
</displays>`;

/** What a failed dump actually looks like: no hierarchy at all. */
const FAILED_DUMP = `ERROR: could not get idle state.`;

describe("parseBounds", () => {
  it("resolves the centre, so a press can be aimed without recomputing it", () => {
    const bounds = parseBounds("[100,200][300,400]");
    expect(bounds).toEqual({
      left: 100,
      top: 200,
      right: 300,
      bottom: 400,
      width: 200,
      height: 200,
      centerX: 200,
      centerY: 300,
    });
  });

  it("keeps an odd extent inside the rectangle", () => {
    // 0..101 is 101px wide; the centre must land on a pixel that is really inside it.
    const bounds = parseBounds("[0,0][101,1]");
    expect(bounds?.centerX).toBe(50);
    expect(bounds?.centerX).toBeLessThan(101);
  });

  it("handles negative corners, which a scrolled-away node reports", () => {
    const bounds = parseBounds("[-40,-60][60,40]");
    expect(bounds?.width).toBe(100);
    expect(bounds?.centerX).toBe(10);
    expect(bounds?.centerY).toBe(-10);
  });

  it("refuses an empty or reversed rectangle instead of inventing a point", () => {
    // `[0,0][0,0]` is what the platform writes for a node it could not place.
    // Normalising it would produce a plausible-looking centre at the screen corner.
    expect(parseBounds("[0,0][0,0]")).toBeUndefined();
    expect(parseBounds("[300,400][100,200]")).toBeUndefined();
  });

  it("refuses what it cannot parse, rather than defaulting to the origin", () => {
    expect(parseBounds(undefined)).toBeUndefined();
    expect(parseBounds("")).toBeUndefined();
    expect(parseBounds("nonsense")).toBeUndefined();
    expect(parseBounds("[0,0][100,100] trailing")).toBeUndefined();
  });
});

describe("shorten", () => {
  it("leaves text within the budget untouched", () => {
    expect(shorten("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  it("marks text it had to cut", () => {
    const result = shorten("a".repeat(50), 10);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("a".repeat(10))).toBe(true);
  });

  it("collapses whitespace, which a dump uses for layout rather than meaning", () => {
    expect(shorten("  a\n\n  b  ", 20).text).toBe("a b");
  });
});

describe("parseScreenDump", () => {
  it("reads every node of a single window", () => {
    const dump = parseScreenDump(SINGLE_WINDOW);
    expect(dump.nodes).toHaveLength(5);
    expect(dump.rotation).toBe(0);
    expect(dump.multiWindow).toBe(false);
    expect(dump.malformed).toBe(false);
  });

  it("decodes non-ASCII text rather than dropping it", () => {
    const dump = parseScreenDump(SINGLE_WINDOW);
    // The literal characters, not their escapes: this is what a Chinese app dumps.
    expect(dump.nodes[1]?.text).toBe("\u641c\u7d22");
    expect(dump.nodes[3]?.description).toBe("\u5934\u50cf");
  });

  it("reads the attributes a decision actually depends on", () => {
    const dump = parseScreenDump(SINGLE_WINDOW);
    const send = dump.nodes[4];
    expect(send?.className).toBe("android.widget.Button");
    expect(send?.resourceId).toBe("com.example.chat:id/send");
    expect(send?.clickable).toBe(true);
    expect(send?.enabled).toBe(false);
    expect(send?.bounds?.centerX).toBe(980);
  });

  it("reports a password field as one", () => {
    // A password field's text must not be presented as ordinary content, and the
    // reading has to be able to say so.
    const dump = parseScreenDump(SINGLE_WINDOW);
    expect(dump.nodes[2]?.password).toBe(true);
    expect(dump.nodes[1]?.password).toBe(false);
  });

  it("accepts the multi-window shape and flags that more than one was dumped", () => {
    const dump = parseScreenDump(MULTI_WINDOW);
    expect(dump.nodes).toHaveLength(2);
    expect(dump.multiWindow).toBe(true);
    // Both windows' nodes are kept: which one is "the" screen is the caller's
    // decision, and a parser that guessed would hide a notification overlay.
    expect(dump.nodes.map((node) => node.packageName)).toEqual([
      "com.example.chat",
      "com.android.systemui",
    ]);
  });

  it("returns nothing, and no false confidence, for a failed dump", () => {
    const dump = parseScreenDump(FAILED_DUMP);
    expect(dump.nodes).toEqual([]);
    // Zero nodes with `malformed: false` is the honest reading here: there was no
    // hierarchy to have trouble with.
    expect(dump.malformed).toBe(false);
  });

  it("keeps a root node that has bounds but no text, and drops one with neither", () => {
    const dump = parseScreenDump(`<hierarchy rotation="0">
      <node index="0" text="" class="android.widget.FrameLayout" package="com.example" bounds="[0,0][1080,2400]" />
      <node index="1" text="" class="android.widget.View" package="com.example" />
    </hierarchy>`);
    expect(dump.nodes).toHaveLength(1);
    expect(dump.malformed).toBe(true);
  });

  it("survives a truncated dump without throwing", () => {
    // A read that hit a byte ceiling leaves an incomplete document. Half a screen is
    // still usable; an exception in the middle of a tool call is not.
    const truncated = SINGLE_WINDOW.slice(0, Math.floor(SINGLE_WINDOW.length / 2));
    expect(() => parseScreenDump(truncated)).not.toThrow();
    expect(parseScreenDump(truncated).nodes.length).toBeGreaterThan(0);
  });
});

describe("projectScreen", () => {
  it("drops structure and keeps what can be read or pressed", () => {
    const snapshot = projectScreen(parseScreenDump(STRUCTURAL_ONLY));
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.total).toBe(2);
    // The distinction that matters: nodes were seen, none were informative. This is
    // not the same as a screen that could not be read.
    expect(snapshot.note).toMatch(/structural/);
  });

  it("says the screen could not be read when there were no nodes at all", () => {
    const snapshot = projectScreen(parseScreenDump(FAILED_DUMP));
    expect(snapshot.note).toMatch(/could not be read/);
  });

  it("carries the display size from the dumped window", () => {
    const snapshot = projectScreen(parseScreenDump(SINGLE_WINDOW));
    expect(snapshot.width).toBe(1080);
    expect(snapshot.height).toBe(2400);
    expect(snapshot.rotation).toBe(0);
  });

  it("takes the size from the window, not from whichever node the dump starts at", () => {
    // The bug this pins: a dump that starts at a small window — a notification shade,
    // a dialog — used to report that rectangle as the screen. The press fraction was
    // then computed against it and the tap *clamped to the display edge*, landing
    // somewhere real, silently, and nowhere near the element that was meant.
    const dialogFirst = `<displays>
      <display id="0" bounds="[0,0][1080,2400]">
        <window index="0" title="Notification" bounds="[0,0][1080,400]" type="system">
          <hierarchy rotation="0">
            <node index="0" text="New message" class="android.widget.TextView" package="com.android.systemui" content-desc="" clickable="true" enabled="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,50][900,150]" />
          </hierarchy>
        </window>
      </display>
    </displays>`;
    const snapshot = projectScreen(parseScreenDump(dialogFirst));
    // The display, not the 900x150 node and not the 1080x400 window.
    expect(snapshot.width).toBe(1080);
    expect(snapshot.height).toBe(2400);
  });

  it("prefers a measured display size over anything the dump implies", () => {
    // What the Android backend does: `wm size` decides, so no shape of dump can make
    // the reading disagree with the coordinate space taps are resolved against.
    const snapshot = projectScreen(parseScreenDump(SINGLE_WINDOW), {
      display: { width: 1440, height: 3120 },
    });
    expect(snapshot.width).toBe(1440);
    expect(snapshot.height).toBe(3120);
  });

  it("numbers the nodes in array order, which is the invariant the tap relies on", () => {
    // If the printed `#n` and the array position could disagree, `screen_tap_element`
    // would press an element the model never chose. That is the one thing this
    // projection must never get wrong.
    const snapshot = projectScreen(parseScreenDump(SINGLE_WINDOW));
    snapshot.nodes.forEach((node, position) => expect(node.index).toBe(position));
  });

  it("marks the traits that decide whether a press is safe", () => {
    const snapshot = projectScreen(parseScreenDump(SINGLE_WINDOW));
    const send = snapshot.nodes.find((node) => node.resourceId === "com.example.chat:id/send");
    expect(send?.clickable).toBe(true);
    expect(send?.disabled).toBe(true);

    const label = snapshot.nodes.find((node) => node.resourceId === "com.example.chat:id/avatar");
    // An icon-only control's label is its content description; without it the reading
    // would show an unlabelled element and the model could not know what it presses.
    expect(label?.description).toBe("\u5934\u50cf");
    expect(label?.text).toBeUndefined();
    expect(label?.clickable).toBe(true);
  });

  it("omits false flags rather than carrying them", () => {
    // Every boolean sent is context spent; only the surprising values earn a place.
    const snapshot = projectScreen(parseScreenDump(SINGLE_WINDOW));
    const search = snapshot.nodes.find((node) => node.resourceId === "com.example.chat:id/search");
    expect(search).not.toHaveProperty("disabled");
    expect(search).not.toHaveProperty("password");
  });

  it("does not send the same label twice for the same rectangle", () => {
    // The dumper repeats a container's text on the child that draws it. Sending both
    // spends the budget twice and makes one label look like two controls.
    const duplicate = `<hierarchy rotation="0">
      <node index="0" text="Inbox" class="android.widget.TextView" package="com.example" content-desc="Inbox" clickable="true" enabled="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][500,100]" />
    </hierarchy>`;
    const snapshot = projectScreen(parseScreenDump(duplicate));
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]?.text).toBe("Inbox");
    expect(snapshot.nodes[0]?.description).toBeUndefined();
  });

  it("flags shortened text instead of cutting it silently", () => {
    // The fixture carries no long label — a real chat screen does, and a label that is
    // quietly halved reads as if the app truncated it.
    const long = "x".repeat(400);
    const withLongLabel = `<hierarchy rotation="0">
      <node index="0" text="${long}" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][500,100]" />
    </hierarchy>`;
    const snapshot = projectScreen(parseScreenDump(withLongLabel), { maxTextLength: 10 });
    expect(snapshot.truncatedText).toBe(true);
    expect(snapshot.nodes[0]?.text?.length).toBeLessThan(long.length);
    expect(snapshot.nodes[0]?.text).toMatch(/\.\.\.$/);
  });

  it("reports how many elements the budget dropped", () => {
    const snapshot = projectScreen(parseScreenDump(SINGLE_WINDOW), { maxNodes: 2 });
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.truncatedNodes).toBeGreaterThan(0);
  });

  it("stops on the character budget even when the node budget is generous", () => {
    const snapshot = projectScreen(parseScreenDump(SINGLE_WINDOW), { maxChars: 5, maxNodes: 100 });
    expect(snapshot.nodes.length).toBeLessThan(5);
    expect(snapshot.truncatedNodes).toBeGreaterThan(0);
  });
});

describe("formatScreenReading", () => {
  const snapshotOf = (): ScreenSnapshot => projectScreen(parseScreenDump(SINGLE_WINDOW));

  it("returns the same snapshot it formatted, so the two views cannot disagree", () => {
    const snapshot = snapshotOf();
    const reading = formatScreenReading(snapshot);
    expect(reading.snapshot).toBe(snapshot);
  });

  it("prints each element with the number and the point to press", () => {
    const { text } = formatScreenReading(snapshotOf());
    expect(text).toContain("#0");
    expect(text).toMatch(/center=\d+,\d+/);
    expect(text).toContain("tap");
  });

  it("names the app and the display", () => {
    const { text } = formatScreenReading(snapshotOf());
    expect(text).toContain("app: com.example.chat");
    expect(text).toContain("display: 1080x2400");
  });

  it("leaves a small reading alone", () => {
    // The other half of the contract: the omission notice must be a fact, not a
    // permanent footer that trains the reader to ignore it.
    const { text } = formatScreenReading(snapshotOf());
    expect(text).not.toMatch(/omitted/);
    expect(text).toContain("#3");
  });

  it("says how much it left out rather than stopping mid-list", () => {
    // A real dump runs to far more than a screenful, so the budget is what keeps one
    // reading from spending the whole context. What is pinned is that the cut is
    // reported: a list that simply stops looks like a screen that simply ends.
    const snapshot = snapshotOf();
    snapshot.nodes = Array.from({ length: 400 }, (_, index) => ({
      index,
      text: `element number ${index} with a reasonably long label`,
      clickable: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, centerX: 50, centerY: 50 },
    }));
    const { text } = formatScreenReading(snapshot, { maxChars: 400 });
    expect(text).toMatch(/omitted/);
    // The list must still begin at the top of the screen: dropping from the front
    // would silently shift which element each number refers to.
    expect(text).toContain("#0");
  });

  it("passes a backend note through to the reader", () => {
    const snapshot = snapshotOf();
    snapshot.note = "the screen could not be read: timed out";
    expect(formatScreenReading(snapshot).text).toContain("could not be read");
  });

  it("says when more than one window was dumped", () => {
    const { text } = formatScreenReading(projectScreen(parseScreenDump(MULTI_WINDOW)));
    expect(text).toContain("more than one window");
  });

  it("still produces a line for an empty reading", () => {
    const { text } = formatScreenReading(projectScreen(parseScreenDump(FAILED_DUMP)));
    expect(text).toContain("elements: 0");
    expect(text).toContain("could not be read");
  });
});

describe("interpretDump", () => {
  it("accepts a dump that contains a hierarchy", () => {
    const outcome = interpretDump({ exitCode: 0, stdout: SINGLE_WINDOW, stderr: "" });
    expect(outcome.xml).toContain("<hierarchy");
    expect(outcome.error).toBeUndefined();
  });

  it("treats 'could not get idle state' as a failure even when the exit code is 0", () => {
    // Some builds print this and exit 0. Reading it as success is how a screen that
    // could not be read becomes a screen reported as empty.
    const outcome = interpretDump({ exitCode: 0, stdout: FAILED_DUMP, stderr: "" });
    expect(outcome.xml).toBeUndefined();
    expect(outcome.error).toMatch(/idle state/);
  });

  it("reports a timeout as the wait it is, not as an empty screen", () => {
    const outcome = interpretDump({ exitCode: 1, stdout: "", stderr: "", timedOut: true });
    expect(outcome.error).toMatch(/timed out/);
    expect(outcome.error).toMatch(/never does/);
  });

  it("reports a non-zero exit with the stderr it produced", () => {
    const outcome = interpretDump({ exitCode: 137, stdout: "", stderr: "Killed" });
    expect(outcome.error).toContain("137");
    expect(outcome.error).toContain("Killed");
  });

  it("does not mistake an element whose text says 'error' for a failed dump", () => {
    // The hierarchy is checked before the message markers for exactly this reason:
    // the screen is user content, and user content talks about errors all the time.
    const withErrorText = `<hierarchy rotation="0">
      <node index="0" text="Error: payment declined" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][500,100]" />
    </hierarchy>`;
    const outcome = interpretDump({ exitCode: 0, stdout: withErrorText, stderr: "" });
    expect(outcome.xml).toBeDefined();
    expect(outcome.error).toBeUndefined();
  });

  it("refuses an empty file rather than calling it an empty screen", () => {
    const outcome = interpretDump({ exitCode: 0, stdout: "   ", stderr: "" });
    expect(outcome.error).toBeDefined();
  });
});

describe("the dump command", () => {
  it("writes the dump where both shell and the app can reach it", () => {
    // /data/local/tmp is writable by shell and unreadable by the app, which is why a
    // capture crosses the binder. The dump does not have to: shared storage is
    // reachable from both sides.
    expect(DUMP_FILE_PATH.startsWith("/sdcard/")).toBe(true);
    expect(DUMP_COMMANDS.dump).toContain(DUMP_FILE_PATH);
    expect(DUMP_COMMANDS.read).toContain(DUMP_FILE_PATH);
    expect(DUMP_COMMANDS.clean).toContain(DUMP_FILE_PATH);
  });

  it("tries the compressed form first and keeps a fallback for builds that reject it", () => {
    expect(DUMP_COMMANDS.dump).toContain("--compressed");
    expect(DUMP_COMMANDS.dumpPlain).not.toContain("--compressed");
    expect(DUMP_COMMANDS.dumpPlain).toContain(DUMP_FILE_PATH);
  });
});
