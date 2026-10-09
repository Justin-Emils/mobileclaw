import type { AnyToolDefinition, ToolEffect, ToolRequirement } from "./tool";
import { KNOWN_CATEGORIES } from "./tool";

/**
 * The tool catalogue: what exists, grouped, and what it costs.
 *
 * ## Why this exists
 *
 * The system prompt lists every tool's name and description. That is fine at thirty tools and
 * untenable at a hundred: the prompt grows with the API, every call pays for it, and the model
 * has to pick a tool out of a flat list of names it cannot see the shape of. A catalogue that
 * groups by domain, states the cost and names the external requirement keeps the *inventory*
 * navigable while the full schemas stay out of the way until a tool is chosen.
 *
 * ## Why the defaults are conservative
 *
 * `effects` and `requires` are inferred when a tool does not declare them, and the inference
 * always errs towards "touches more" and "needs more". A catalogue that guessed "harmless" for
 * an unannotated tool would be worse than one that admits it does not know, because the model
 * reasons about consent from this text. The cost default goes the other way — omitted is
 * `cheap` — since an over-cautious model that declines to act is a smaller failure than one
 * that serialises twenty network calls the user did not ask for.
 */

/** What a tool touches, inferred from its risk when it did not say. */
export function effectsOf(tool: AnyToolDefinition): readonly ToolEffect[] {
  // Presence, not length: an explicit empty list is a *declaration* that the tool touches
  // nothing, which is the truth for a tool that only asks the user a question. Falling through
  // to the inference on an empty array would report that tool as touching the disk.
  if (tool.effects !== undefined) return tool.effects;
  switch (tool.risk) {
    case "read":
      return ["disk"];
    case "write":
      return ["edit", "disk"];
    case "execute":
      return ["process"];
    case "network":
      return ["network"];
    case "system":
      // The broadest case, deliberately: `system` is the level at which a tool reaches
      // outside the app, and the specific effect is exactly what an unannotated tool has not
      // told us.
      return ["edit", "share"];
    default:
      return ["edit"];
  }
}

/** External capabilities a tool needs, inferred when it did not say. */
export function requirementsOf(tool: AnyToolDefinition): readonly ToolRequirement[] {
  if (tool.requires) return tool.requires;
  // A network-risk tool cannot work without a network. Everything else is assumed to need
  // nothing, because the alternative — assuming every `system` tool needs Shizuku — would
  // make the catalogue claim a dependency that most of them do not have.
  return tool.risk === "network" ? ["internet"] : [];
}

/** Cost, defaulted to the optimistic case. */
export function costOf(tool: AnyToolDefinition): "cheap" | "slow" {
  return tool.cost ?? "cheap";
}

/** The domain to file a tool under, with anything unlabelled collected together. */
export function categoryOf(tool: AnyToolDefinition): string {
  return tool.category ?? "other";
}

/** Tools grouped by category, categories in the shipped order and unknown ones last. */
export function groupByCategory(
  tools: readonly AnyToolDefinition[],
): Array<{ category: string; tools: AnyToolDefinition[] }> {
  const groups = new Map<string, AnyToolDefinition[]>();
  for (const tool of tools) {
    const category = categoryOf(tool);
    const bucket = groups.get(category);
    if (bucket) bucket.push(tool);
    else groups.set(category, [tool]);
  }

  const order = (category: string): number => {
    const index = (KNOWN_CATEGORIES as readonly string[]).indexOf(category);
    // Unknown domains sort after the known ones but keep a stable order among themselves.
    return index === -1 ? KNOWN_CATEGORIES.length : index;
  };

  return [...groups.entries()]
    .map(([category, entries]) => ({ category, tools: entries }))
    .sort((a, b) => order(a.category) - order(b.category) || a.category.localeCompare(b.category));
}

/**
 * A compact catalogue for the system prompt.
 *
 * One line per tool: the name, what it is for in the tool's own words, and only the qualifiers
 * that change a decision — cost, and an external requirement the model would otherwise discover
 * by failing. Effects are left out on purpose: they are already implied by the risk level the
 * permission gate reports, and repeating them here would spend prompt space twice on one fact.
 *
 * Returns an empty string for no tools, so a caller can concatenate without a conditional.
 */
export function renderCatalogue(tools: readonly AnyToolDefinition[]): string {
  if (tools.length === 0) return "";

  const lines: string[] = [];
  for (const { category, tools: entries } of groupByCategory(tools)) {
    lines.push(`${category}:`);
    for (const tool of entries) {
      const qualifiers: string[] = [];
      const requires = requirementsOf(tool);
      if (requires.length > 0) qualifiers.push(`needs ${requires.join("+")}`);
      if (costOf(tool) === "slow") qualifiers.push("slow");
      const suffix = qualifiers.length > 0 ? ` [${qualifiers.join(", ")}]` : "";
      // The first sentence of the description only: the full text is in the tool's own
      // schema, and this list is for choosing, not for instructing.
      lines.push(`- ${tool.name}${suffix}: ${firstSentence(tool.description)}`);
    }
  }
  return lines.join("\n");
}

/**
 * The opening sentence, which is where a well-written description says what the tool is *for*.
 *
 * Falls back to a truncation when there is no sentence break, because a one-line catalogue entry
 * that runs to a paragraph defeats the purpose of the catalogue.
 */
function firstSentence(description: string): string {
  const stop = description.search(/\.\s/);
  const sentence = stop === -1 ? description : description.slice(0, stop + 1);
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}
