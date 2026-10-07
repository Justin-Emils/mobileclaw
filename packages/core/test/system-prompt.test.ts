import { describe, expect, it } from "vitest";
import {
  Agent,
  KeyValueConversationStore,
  MemoryKeyValueStore,
  PermissionGate,
  ToolRegistry,
  renderStepBudget,
} from "@mobileclaw/core";

/**
 * The assembled system prompt is the model's entire briefing: which tools exist, what the
 * device looks like, where its workspace is, and how much budget is left.
 *
 * Every one of those sections is conditional, and a missing section is silent -- the model
 * simply does not know a fact. That is how the agent came to report a full folder as empty:
 * nothing told it that storage access was missing. These assertions pin which sections
 * appear under which conditions.
 */

function buildAgent(options: {
  systemPrompt?: string;
  environment?: () => string | Promise<string>;
  describeWorkspace?: (workspace: string) => string;
  tools?: number;
}) {
  const registry = new ToolRegistry();
  return new Agent({
    provider: {
      id: "test",
      label: "Test",
      model: "test-model",
      // Not exercised: the tests only build prompts.
      async *stream() {
        return;
      },
      async complete() {
        return { text: "", toolCalls: [] };
      },
      async ping() {
        return { ok: true, message: "ok" };
      },
    } as never,
    registry,
    permissions: new PermissionGate({ defaultMode: "ask" }),
    store: new KeyValueConversationStore(new MemoryKeyValueStore()),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.describeWorkspace ? { describeWorkspace: options.describeWorkspace } : {}),
  });
}

describe("buildSystemPrompt", () => {
  it("always carries the base prompt and the tool inventory heading", async () => {
    const prompt = await buildAgent({}).buildSystemPrompt();
    expect(prompt).toContain("MobileClaw");
    expect(prompt).toContain("## Available tools");
  });

  it("says so explicitly when no tools are registered", async () => {
    // Silence would read as "tools exist but are unlisted", which invites the model to
    // invent a tool name.
    const prompt = await buildAgent({}).buildSystemPrompt();
    expect(prompt).toContain("No tools are available right now.");
  });

  it("includes the environment block when one is supplied", async () => {
    const prompt = await buildAgent({ environment: () => "Storage: NOT readable." }).buildSystemPrompt();
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Storage: NOT readable.");
  });

  it("omits the environment heading when there is none", async () => {
    expect(await buildAgent({}).buildSystemPrompt()).not.toContain("## Environment");
  });

  it("awaits an async environment, so a probe runs per turn", async () => {
    // The storage probe is async and must be awaited; a promise leaking into the prompt
    // would render as "[object Promise]" and tell the model nothing.
    const prompt = await buildAgent({
      environment: async () => {
        await Promise.resolve();
        return "Storage: readable (all-files access granted).";
      },
    }).buildSystemPrompt();
    expect(prompt).toContain("all-files access granted");
    expect(prompt).not.toContain("[object Promise]");
  });

  it("adds the workspace section only when there is both a path and wording", async () => {
    const withBoth = await buildAgent({
      describeWorkspace: (workspace) => `Conversation workspace: ${workspace}`,
    }).buildSystemPrompt(5, 10, "/workspaces/c1");
    expect(withBoth).toContain("## Your workspace");
    expect(withBoth).toContain("/workspaces/c1");

    // A workspace with no wording would print an empty heading.
    const noWording = await buildAgent({}).buildSystemPrompt(5, 10, "/workspaces/c1");
    expect(noWording).not.toContain("## Your workspace");

    // Wording with no workspace has nothing to point at.
    const noPath = await buildAgent({
      describeWorkspace: (workspace) => `Conversation workspace: ${workspace}`,
    }).buildSystemPrompt(5, 10);
    expect(noPath).not.toContain("## Your workspace");
  });

  it("includes the budget only when the step counts are known", async () => {
    const withBudget = await buildAgent({}).buildSystemPrompt(3, 12);
    expect(withBudget).toContain("## Budget");
    expect(withBudget).toContain(renderStepBudget(3, 12));

    const withoutBudget = await buildAgent({}).buildSystemPrompt();
    expect(withoutBudget).not.toContain("## Budget");
  });

  it("honours a system prompt override", async () => {
    const prompt = await buildAgent({ systemPrompt: "自定义提示词" }).buildSystemPrompt();
    expect(prompt).toContain("自定义提示词");
    // The tool inventory is still appended; an override replaces the persona, not the facts.
    expect(prompt).toContain("## Available tools");
  });

  it("orders the sections consistently", async () => {
    // Later sections override earlier framing, so the order is part of the meaning:
    // environment and workspace must come after the persona and the tool list.
    const prompt = await buildAgent({
      environment: () => "ENV_MARK",
      describeWorkspace: () => "WS_MARK",
    }).buildSystemPrompt(3, 12, "/w");
    const order = ["## Available tools", "## Budget", "ENV_MARK", "## Your workspace", "WS_MARK"].map((marker) =>
      prompt.indexOf(marker),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
