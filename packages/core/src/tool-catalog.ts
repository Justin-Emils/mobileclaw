import { z } from "zod";
import type { AnyToolDefinition } from "./tool";
import { effectsOf, requirementsOf, costOf, categoryOf } from "./catalog";
import { toToolSchema } from "./tools-registry";

/**
 * The catalogue tool — how a model finds out what it can do.
 *
 * ## Why this exists next to a prompt that already lists the tools
 *
 * The system prompt carries a compact inventory: one line per tool, grouped by domain, with
 * cost and external requirements. That is enough to *choose* a tool. It is deliberately not
 * enough to *call* one: the arguments are not there, and neither is the detail a description
 * needs to be unambiguous.
 *
 * This tool answers the two questions the inventory cannot. "What exactly does this tool take?"
 * — it returns the full description and the JSON Schema of the arguments. And "is there
 * anything for this?" — a model facing an unfamiliar request can search the catalogue by
 * keyword instead of guessing a tool name and reading an `E_TOOL_NOT_FOUND` back.
 *
 * It is also the scaling answer. When the inventory outgrows a prompt, the prompt can shrink to
 * "you have these domains; use `catalog` to look inside one", and the per-call cost stops
 * growing with the API. At thirty-three tools that is not yet necessary — but the tool has to
 * exist before the prompt can lean on it, and it costs nothing to have now.
 *
 * ## It is built by the kernel, not by a capability bundle
 *
 * It has to see every registered tool to answer, and the capability layer can only see what it
 * was handed. The agent builds it from its own resolved list, which is also what keeps the
 * answer honest for a run that has selected a subset of tools: the catalogue reports what this
 * run can actually call, not what the app ships.
 */

export const CATALOG_TOOL = "catalog";

/** Bounds, so one query cannot return the whole schema of everything. */
const CATALOG_LIMITS = {
  maxTools: 40,
  maxQueryLength: 100,
} as const;

/** One tool, in full: enough to call it without a second round trip. */
function describeTool(tool: AnyToolDefinition): Record<string, unknown> {
  const requires = requirementsOf(tool);
  return {
    name: tool.name,
    category: categoryOf(tool),
    risk: tool.risk,
    cost: costOf(tool),
    ...(requires.length > 0 ? { requires } : {}),
    effects: effectsOf(tool),
    ...(tool.neverRemember === true ? { asksEveryTime: true } : {}),
    ...(tool.mutates === false ? { mutates: false } : {}),
    description: tool.description,
    // The JSON Schema, so the model can call it correctly first time. This is the part the
    // prompt deliberately leaves out. Read through the registry's own converter so the
    // catalogue can never describe a tool differently from the way it will be called.
    arguments: toToolSchema(tool).parameters,
  };
}

export interface CatalogOptions {
  /** The tools this run can call. Supplied by the agent, not discovered. */
  tools: readonly AnyToolDefinition[];
  /** Why the list is what it is, when the run has selected a subset. */
  selectionNote?: string;
}

/**
 * Build the catalogue tool over a fixed list of tools.
 *
 * A snapshot rather than a live lookup: the list is resolved per step, and a tool that changed
 * what it can see mid-answer would be reporting something other than what the model is holding.
 */
export function createCatalogTool(options: CatalogOptions): AnyToolDefinition {
  const { tools } = options;

  return {
    name: CATALOG_TOOL,
    description:
      "Look up what the available tools are, what they take and what they need. Call it with no arguments to list every domain in one line each; with `category` to list the tools in one domain with their full argument schemas; or with `query` to search tool names and descriptions by keyword. Use it when you are unsure which tool fits a request, or when you need to know the exact arguments, instead of guessing a tool name.",
    input: z.object({
      category: z
        .string()
        .max(CATALOG_LIMITS.maxQueryLength)
        .optional()
        .describe("A domain from the summary, e.g. web or screen-read. Lists that domain in full."),
      query: z
        .string()
        .max(CATALOG_LIMITS.maxQueryLength)
        .optional()
        .describe("Keyword to match against tool names and descriptions."),
      tool: z
        .string()
        .max(CATALOG_LIMITS.maxQueryLength)
        .optional()
        .describe("One exact tool name, for when you already know which one you want."),
    }),
    risk: "read",
    category: "plan",
    // Reads the app's own tool list. It touches nothing outside the process.
    effects: [],
    cost: "cheap",
    summarize: (input: { category?: string; query?: string; tool?: string }) =>
      `catalog ${input.tool ?? input.category ?? input.query ?? "all"}`,
    async execute(input: { category?: string; query?: string; tool?: string }) {
      const all = [...tools];

      if (input.tool !== undefined) {
        const wanted = input.tool.trim().toLowerCase();
        const match = all.find((tool) => tool.name.toLowerCase() === wanted);
        return match
          ? { tool: describeTool(match), note: options.selectionNote }
          : {
              found: false,
              requested: input.tool,
              reason: "no tool by that name is available in this run",
              // Named rather than listed: a near miss is the common case, and the full list here
              // would waste the tokens this tool exists to save.
              similar: all
                .map((tool) => tool.name)
                .filter((name) => name.includes(wanted) || wanted.includes(name))
                .slice(0, 8),
            };
      }

      if (input.category !== undefined) {
        const wanted = input.category.trim().toLowerCase();
        const inCategory = all.filter((tool) => categoryOf(tool).toLowerCase() === wanted);
        return {
          category: wanted,
          count: inCategory.length,
          tools: inCategory.slice(0, CATALOG_LIMITS.maxTools).map(describeTool),
          ...(inCategory.length > CATALOG_LIMITS.maxTools
            ? { truncated: inCategory.length - CATALOG_LIMITS.maxTools }
            : {}),
          note: options.selectionNote,
        };
      }

      if (input.query !== undefined) {
        const needle = input.query.trim().toLowerCase();
        const hits = all.filter(
          (tool) =>
            tool.name.toLowerCase().includes(needle) ||
            tool.description.toLowerCase().includes(needle),
        );
        return {
          query: input.query,
          count: hits.length,
          tools: hits.slice(0, CATALOG_LIMITS.maxTools).map(describeTool),
          ...(hits.length === 0
            ? { reason: "nothing matched; try a single word, or call with no arguments to see the domains" }
            : {}),
          note: options.selectionNote,
        };
      }

      // No arguments: the domains, one line each. The whole point is that this stays short
      // enough to be worth calling — a model that can read everything here would not need
      // `category` at all.
      const domains = new Map<string, number>();
      for (const tool of all) {
        const category = categoryOf(tool);
        domains.set(category, (domains.get(category) ?? 0) + 1);
      }
      return {
        total: all.length,
        domains: [...domains.entries()].map(([category, count]) => ({ category, tools: count })),
        hint: "Call again with `category` to see that domain's tools and their arguments, or with `query` to search by keyword.",
        note: options.selectionNote,
      };
    },
  };
}
