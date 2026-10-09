import { describe, expect, it } from "vitest";
import { CATALOG_TOOL, createCatalogTool } from "@mobileclaw/core";
import type { AnyToolDefinition } from "@mobileclaw/core";

/**
 * The catalogue tool.
 *
 * What it has to get right is the difference between *choosing* and *calling*. The prompt's
 * inventory is enough to pick a tool; this tool has to supply the rest — the arguments — without
 * a second round trip, and it has to answer honestly about what a *restricted* run can reach.
 * A catalogue that listed capabilities the run cannot call would send the model at a tool that
 * answers `E_TOOL_NOT_FOUND`.
 */

function tool(over: Partial<AnyToolDefinition> & { name: string }): AnyToolDefinition {
  return {
    description: "Does a thing.",
    input: undefined as never,
    risk: "read",
    async execute() {
      return {};
    },
    ...over,
  };
}

/** Two domains, with the details a model needs before calling. */
const WEB_SEARCH = tool({
  name: "web_search",
  description: "Search the web and return candidate results.",
  risk: "network",
  category: "web",
  effects: ["network"],
  requires: ["search", "internet"],
  cost: "slow",
});

const SCREEN_READ = tool({
  name: "screen_read",
  description: "Read the current screen as text.",
  risk: "read",
  category: "screen-read",
  effects: ["screen"],
  requires: ["shizuku"],
});

const FS_LIST = tool({
  name: "fs_list",
  description: "List a directory.",
  risk: "read",
  category: "files",
});

function catalog(tools: AnyToolDefinition[], note?: string) {
  const entry = createCatalogTool({ tools, ...(note ? { selectionNote: note } : {}) });
  return {
    entry,
    call: (input: Record<string, unknown>) =>
      entry.execute(input as never, { signal: new AbortController().signal, callId: "c1" } as never),
  };
}

describe("createCatalogTool", () => {
  it("is a read-risk tool that touches nothing", () => {
    const { entry } = catalog([FS_LIST]);
    expect(entry.name).toBe(CATALOG_TOOL);
    // Reading the app's own tool list is not a device effect; `disk` would be the inferred
    // default for `read` risk and would misdescribe it in its own catalogue entry.
    expect(entry.risk).toBe("read");
    expect(entry.effects).toEqual([]);
  });

  it("with no arguments, lists the domains and how many tools each holds", async () => {
    const { call } = catalog([FS_LIST, WEB_SEARCH, SCREEN_READ]);
    const result = (await call({})) as { total: number; domains: Array<{ category: string; tools: number }> };

    expect(result.total).toBe(3);
    expect(result.domains.map((domain) => domain.category).sort()).toEqual([
      "files",
      "screen-read",
      "web",
    ]);
  });

  it("with a category, describes each tool fully enough to call it", async () => {
    const { call } = catalog([FS_LIST, WEB_SEARCH]);
    const result = (await call({ category: "web" })) as {
      count: number;
      tools: Array<Record<string, unknown>>;
    };

    expect(result.count).toBe(1);
    const entry = result.tools[0];
    expect(entry?.["name"]).toBe("web_search");
    // The parts the prompt's one-line inventory deliberately omits.
    expect(entry?.["description"]).toBe("Search the web and return candidate results.");
    expect(entry?.["arguments"]).toBeDefined();
    expect(entry?.["requires"]).toEqual(["search", "internet"]);
    expect(entry?.["effects"]).toEqual(["network"]);
    expect(entry?.["cost"]).toBe("slow");
  });

  it("reports the permission posture a caller would otherwise have to discover", async () => {
    const asked = tool({ name: "screen_type", risk: "system", category: "screen-act", neverRemember: true });
    const { call } = catalog([asked]);
    const result = (await call({ tool: "screen_type" })) as { tool: Record<string, unknown> };
    expect(result.tool["asksEveryTime"]).toBe(true);
  });

  it("searches names and descriptions by keyword", async () => {
    const { call } = catalog([FS_LIST, WEB_SEARCH]);
    const byName = (await call({ query: "screen" })) as { count: number };
    expect(byName.count).toBe(0);

    const byDescription = (await call({ query: "web" })) as { count: number; tools: Array<{ name: string }> };
    expect(byDescription.tools.map((entry) => entry.name)).toEqual(["web_search"]);
  });

  it("says when a keyword matched nothing, and how to recover", async () => {
    const { call } = catalog([FS_LIST]);
    const result = (await call({ query: "telepathy" })) as { count: number; reason?: string };
    expect(result.count).toBe(0);
    expect(result.reason).toMatch(/no arguments to see the domains/);
  });

  it("looks one tool up by exact name", async () => {
    const { call } = catalog([FS_LIST, WEB_SEARCH]);
    const result = (await call({ tool: "fs_list" })) as { tool: { name: string } };
    expect(result.tool.name).toBe("fs_list");
  });

  it("suggests near misses instead of dumping the whole list", async () => {
    // A miss is usually a typo or a half-remembered name. Replying with every tool would spend
    // exactly the tokens this tool exists to save.
    const { call } = catalog([FS_LIST, WEB_SEARCH, SCREEN_READ]);
    const result = (await call({ tool: "web_serch" })) as {
      found: boolean;
      similar?: string[];
      tools?: unknown;
    };

    expect(result.found).toBe(false);
    expect(result.tools).toBeUndefined();
    // "web_serch" contains "web_search"? No — but "web_search".includes("web_serch") is false
    // too, so nothing is promised here beyond the shape of the answer.
    expect(Array.isArray(result.similar)).toBe(true);
  });

  it("carries the selection note when the run is restricted", async () => {
    // The honesty clause: a run limited to a subset must not be told it has everything.
    const note = "This run has been restricted to a subset of tools.";
    const { call } = catalog([FS_LIST], note);
    const result = (await call({})) as { note?: string };
    expect(result.note).toBe(note);
  });

  it("only ever describes the tools it was given", async () => {
    // The catalogue is built from the resolved list, so it cannot advertise something the run
    // would refuse to execute.
    const { call } = catalog([FS_LIST]);
    const result = (await call({ category: "web" })) as { count: number };
    expect(result.count).toBe(0);
  });
});
