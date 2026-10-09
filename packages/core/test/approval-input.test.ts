import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  KeyValueConversationStore,
  MemoryKeyValueStore,
  MockProvider,
  PermissionGate,
  ToolRegistry,
  type AnyToolDefinition,
} from "@mobileclaw/core";

/**
 * What an approval is allowed to contribute to the argument that actually runs.
 *
 * These exist because of a real defect. The approval's value was shallow-merged over
 * the model's input *after* the permission rules had been evaluated against the
 * model's input, and execution then used the merged value — so an approval could supply
 * a path that a `pathPattern` deny rule had already refused, and the write went through
 * to the denied location. Confirmed by reproducing it, not by reading the code.
 *
 * The contract now: an approval may **add what the model left out** (the coordinate it
 * cannot see is the only reason the channel exists) and may never overwrite something
 * the rules were already applied to.
 */

const EXISTING = { path: "/root/notes.txt", content: "x" };
const DENIED = "/root/secret/leak.txt";

const writeTool = (written: Set<string>): AnyToolDefinition => ({
  name: "fs_write",
  description: "write a file",
  input: z.object({ path: z.string(), content: z.string() }),
  risk: "write",
  paths: (input) => [input.path],
  async execute(input) {
    written.add(input.path);
    return { ok: true };
  },
});

/** The tool the picker feeds: the model names a target, the user supplies the point. */
const tapTool = (seen: Record<string, unknown>[]): AnyToolDefinition => ({
  name: "screen_tap",
  description: "press one point",
  input: z.object({
    target: z.string(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
  }),
  risk: "system",
  neverRemember: true,
  async execute(input) {
    seen.push(input as Record<string, unknown>);
    return { ok: true };
  },
});

async function runWith(options: {
  tools: AnyToolDefinition[];
  turns: ConstructorParameters<typeof MockProvider>[0]["turns"];
  approval: ConstructorParameters<typeof PermissionGate>[1];
  permissions?: ConstructorParameters<typeof PermissionGate>[0];
}) {
  const store = new KeyValueConversationStore(new MemoryKeyValueStore());
  const agent = new Agent({
    provider: new MockProvider({ turns: options.turns }),
    registry: new ToolRegistry().registerAll(options.tools),
    permissions: new PermissionGate(options.permissions ?? { defaultMode: "ask" }, options.approval),
    store,
  });
  const result = await agent.run({ input: "go" });
  const entries = (await store.load(result.conversationId))?.entries ?? [];
  const entry = entries.find((item) => item.kind === "tool" && item.name === options.tools[0]!.name);
  return { result, store, entry };
}

const denySecret = {
  defaultMode: "ask" as const,
  rules: [{ tool: "fs_write", decision: "deny" as const, pathPattern: "**/secret/**" }],
};

describe("approval-supplied arguments", () => {
  it("cannot swap in a path that a deny rule already refused", async () => {
    const written = new Set<string>();

    await runWith({
      tools: [writeTool(written)],
      turns: [{ toolCalls: [{ id: "c1", name: "fs_write", input: EXISTING }] }, "done"],
      permissions: denySecret,
      // The approval tries to redirect the write to the location the rule forbids.
      approval: async () => ({ approved: true, input: { path: DENIED, content: "p" } }),
    });

    expect([...written]).toEqual([EXISTING.path]);
  });

  it("adds the point the model could not know, and only that", async () => {
    const seen: Record<string, unknown>[] = [];

    await runWith({
      tools: [tapTool(seen)],
      turns: [{ toolCalls: [{ id: "c1", name: "screen_tap", input: { target: "search box" } }] }, "done"],
      // `target` is the model's request and must survive; x/y are what it cannot supply.
      approval: async () => ({ approved: true, input: { x: 540, y: 120, target: "something else" } }),
    });

    expect(seen).toEqual([{ target: "search box", x: 540, y: 120 }]);
  });

  it("still puts whatever the approval added through the schema", async () => {
    const seen: Record<string, unknown>[] = [];

    const { entry } = await runWith({
      tools: [tapTool(seen)],
      turns: [{ toolCalls: [{ id: "c1", name: "screen_tap", input: { target: "search box" } }] }, "done"],
      approval: async () => ({ approved: true, input: { x: "not a number" } }),
    });

    expect(seen).toEqual([]);
    expect(entry?.kind === "tool" ? entry.status : undefined).toBe("error");
    expect(entry?.kind === "tool" ? entry.error : undefined).toMatch(/E_TOOL_INPUT/);
  });

  it("ignores an approval that tries to replace the whole argument", async () => {
    // Replacing everything would mean running something that was never evaluated at all.
    const seen: Record<string, unknown>[] = [];

    await runWith({
      tools: [tapTool(seen)],
      turns: [{ toolCalls: [{ id: "c1", name: "screen_tap", input: { target: "search box" } }] }, "done"],
      approval: async () => ({ approved: true, input: "a completely different argument" }),
    });

    expect(seen).toEqual([{ target: "search box" }]);
  });
});
