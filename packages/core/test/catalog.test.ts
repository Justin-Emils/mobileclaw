import { describe, expect, it } from "vitest";
import {
  categoryOf,
  costOf,
  effectsOf,
  groupByCategory,
  renderCatalogue,
  requirementsOf,
} from "@mobileclaw/core";
import type { AnyToolDefinition } from "@mobileclaw/core";

/**
 * The catalogue.
 *
 * Two properties matter and both are about not overstating what is known. An unannotated tool
 * must be reported as touching *more* than it might, because the model reasons about consent
 * from this text and a catalogue that guessed "harmless" would be worse than one that admits
 * ignorance. And the rendered form has to be short — the whole point is that the inventory does
 * not grow without bound while the full schemas stay out of the way.
 */

function tool(over: Partial<AnyToolDefinition> = {}): AnyToolDefinition {
  return {
    name: "t",
    description: "Does a thing. And then says more about it, at length, in a second sentence.",
    input: undefined as never,
    risk: "read",
    async execute() {
      return {};
    },
    ...over,
  };
}

describe("effectsOf", () => {
  it("uses what the tool declared", () => {
    expect(effectsOf(tool({ effects: ["screen"] }))).toEqual(["screen"]);
  });

  it("infers disk for a plain read", () => {
    expect(effectsOf(tool({ risk: "read" }))).toEqual(["disk"]);
  });

  it("infers an edit for a write", () => {
    expect(effectsOf(tool({ risk: "write" }))).toContain("edit");
  });

  it("infers the broadest case for a system tool that said nothing", () => {
    // The important direction: guessing "harmless" here would let the catalogue describe a tool
    // that reaches outside the app as if it did not.
    expect(effectsOf(tool({ risk: "system" }))).toEqual(["edit", "share"]);
  });

  it("respects a declaration of no effects at all", () => {
    // The one case where an empty list is the truth: a tool that only asks a question.
    expect(effectsOf(tool({ effects: [] }))).toEqual([]);
  });
});

describe("requirementsOf", () => {
  it("uses what the tool declared", () => {
    expect(requirementsOf(tool({ requires: ["shizuku"] }))).toEqual(["shizuku"]);
  });

  it("assumes a network tool needs a network", () => {
    expect(requirementsOf(tool({ risk: "network" }))).toEqual(["internet"]);
  });

  it("does not invent a dependency for a system tool", () => {
    // Assuming every `system` tool needs Shizuku would make the catalogue claim a dependency
    // most of them do not have, and a model that believes it would give up early.
    expect(requirementsOf(tool({ risk: "system" }))).toEqual([]);
  });
});

describe("costOf", () => {
  it("defaults to cheap, so an unannotated tool is not skipped out of caution", () => {
    expect(costOf(tool())).toBe("cheap");
  });

  it("honours a declared slow cost", () => {
    expect(costOf(tool({ cost: "slow" }))).toBe("slow");
  });
});

describe("categoryOf", () => {
  it("collects anything unlabelled under one heading rather than dropping it", () => {
    // A tool missing from the catalogue is a tool the model does not know exists.
    expect(categoryOf(tool())).toBe("other");
  });
});

describe("groupByCategory", () => {
  it("orders the known domains consistently and puts unknown ones last", () => {
    const groups = groupByCategory([
      tool({ name: "w", category: "web" }),
      tool({ name: "f", category: "files" }),
      tool({ name: "z", category: "plugin-made-up" }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(["files", "web", "plugin-made-up"]);
  });

  it("keeps every tool, including ones with no category", () => {
    const groups = groupByCategory([tool({ name: "a" }), tool({ name: "b", category: "web" })]);
    const names = groups.flatMap((group) => group.tools.map((entry) => entry.name));
    expect(names.sort()).toEqual(["a", "b"]);
  });
});

describe("renderCatalogue", () => {
  it("returns nothing for no tools, so a caller can concatenate it", () => {
    expect(renderCatalogue([])).toBe("");
  });

  it("gives one line per tool with only the first sentence", () => {
    const text = renderCatalogue([tool({ name: "fs_read", category: "files" })]);
    expect(text).toContain("files:");
    expect(text).toContain("- fs_read:");
    expect(text).toContain("Does a thing.");
    // The rest of the description lives in the tool's own schema; repeating it here defeats
    // the purpose of a compact inventory.
    expect(text).not.toContain("And then says more");
  });

  it("flags an external requirement, which is the thing a model would otherwise learn by failing", () => {
    const text = renderCatalogue([tool({ name: "screen_read", category: "screen-read", requires: ["shizuku"] })]);
    expect(text).toContain("needs shizuku");
  });

  it("flags a slow tool", () => {
    const text = renderCatalogue([tool({ name: "enrich_list", category: "web", cost: "slow" })]);
    expect(text).toContain("slow");
  });

  it("leaves a cheap, requirement-free tool unqualified", () => {
    const text = renderCatalogue([tool({ name: "fs_list", category: "files" })]);
    expect(text).not.toContain("[");
  });

  it("truncates a description with no sentence break instead of printing a paragraph", () => {
    const long = "x".repeat(400);
    const text = renderCatalogue([tool({ name: "t", category: "files", description: long })]);
    const line = text.split("\n").find((entry) => entry.startsWith("- t:")) ?? "";
    expect(line.length).toBeLessThan(200);
    expect(line).toContain("...");
  });
});
