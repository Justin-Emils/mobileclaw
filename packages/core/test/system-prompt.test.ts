import { describe, expect, it } from "vitest";
import {
  Agent,
  KeyValueConversationStore,
  MemoryKeyValueStore,
  PermissionGate,
  ToolRegistry,
  renderStepBudget,
  type AnyToolDefinition,
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
  /** Tools to register, for the tests that assert on the catalogue. */
  register?: AnyToolDefinition[];
}) {
  const registry = new ToolRegistry();
  if (options.register) registry.registerAll(options.register);
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

  it("still offers the catalogue when no capability is registered", async () => {
    // The catalogue is added by the agent itself, so the inventory is never empty — and that is
    // the point: a model with no capabilities can still ask what it has, rather than being left
    // to infer from silence that tools exist but are unlisted.
    const prompt = await buildAgent({}).buildSystemPrompt();
    expect(prompt).toContain("## Available tools");
    expect(prompt).toContain("- catalog:");
    expect(prompt).not.toContain("No tools are available right now.");
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

  /**
   * How the tool inventory appears.
   *
   * The full description of every tool is already sent to the provider as that tool's JSON
   * Schema, so printing it again in the prompt was the second copy — and the one that grew
   * without bound. What the prompt must carry instead is enough to *choose* a tool: its name,
   * what it is for in one sentence, and any external requirement it has.
   */
  it("lists the tools as a compact catalogue, not a copy of every schema", async () => {
    const secondSentence = "This trailing sentence must not reach the prompt at all.";
    const tool = {
      name: "fs_list",
      description: `List a directory. ${secondSentence}`,
      input: undefined as never,
      risk: "read" as const,
      category: "files",
      async execute() {
        return {};
      },
    };
    const prompt = await buildAgent({ register: [tool] }).buildSystemPrompt();

    expect(prompt).toContain("## Available tools");
    expect(prompt).toContain("files:");
    expect(prompt).toContain("- fs_list:");
    expect(prompt).toContain("List a directory.");
    // The second copy is what the catalogue exists to remove.
    expect(prompt).not.toContain(secondSentence);
  });

  it("says which tools need something the device may not have", async () => {
    // The value of the whole exercise: "this needs Shizuku" is actionable before the call,
    // whereas a failure from a tool that never had a chance reads as a bug.
    const tool = {
      name: "screen_read",
      description: "Read the screen as text.",
      input: undefined as never,
      risk: "read" as const,
      category: "screen-read",
      requires: ["shizuku"] as const,
      async execute() {
        return {};
      },
    };
    const prompt = await buildAgent({ register: [tool] }).buildSystemPrompt();
    expect(prompt).toContain("needs shizuku");
  });

  it("tells the model to look tools up rather than guess at them", async () => {
    // The inventory is one sentence per tool by design, so the arguments are not in the prompt.
    // Without this instruction the model's only options are to guess an argument shape or to
    // call a tool with the wrong fields and read the validation error back.
    const prompt = await buildAgent({}).buildSystemPrompt();
    expect(prompt).toContain("`catalog`");
    expect(prompt).toMatch(/do not guess a tool's arguments/i);
  });

  it("tells the model to verify a write instead of assuming it worked", async () => {
    // The project's rule is that a statement about the device is built from a fact. A delivered
    // keystroke is not that fact, and the tool that can supply one has to be named here.
    const prompt = await buildAgent({}).buildSystemPrompt();
    expect(prompt).toMatch(/keystroke that was delivered is not evidence/);
    expect(prompt).toContain("`expect`");
  });

  it("honours a system prompt override", async () => {    const prompt = await buildAgent({ systemPrompt: "自定义提示词" }).buildSystemPrompt();
    expect(prompt).toContain("自定义提示词");
    // The tool inventory is still appended; an override replaces the persona, not the facts.
    expect(prompt).toContain("## Available tools");
  });

  /**
   * Where information may come from.
   *
   * This is the difference between an agent that reads one playlist off the device and looks
   * the lyrics up, and one that either swipes through every screen of the music app or
   * invents lyrics from memory. The instruction has to survive in the default prompt, because
   * an override is the only thing that replaces it and nothing else teaches the split.
   */
  it("tells the model which facts come from the device and which from the web", async () => {
    const prompt = await buildAgent({}).buildSystemPrompt();

    expect(prompt).toContain("Where to get information");
    // The split itself, in both directions.
    expect(prompt).toMatch(/web_search and web_fetch/);
    expect(prompt).toMatch(/playlist/);
    // The three ways this goes wrong, each named: guessing, asking, and remembering.
    expect(prompt).toMatch(/do not ask the user/);
    expect(prompt).toMatch(/training data is out of date/);
    // The step cost, which is what makes "read the list once" the right shape.
    expect(prompt).toMatch(/each search and each fetch costs one step/i);
    // The batched lookup, named: searching twenty items one at a time is the mistake this
    // sentence exists to prevent, and it is invisible unless the tool is named here.
    expect(prompt).toContain("`enrich_list`");
    // Backticks inside the template literal have to be escaped; a missed escape would leave a
    // stray backslash in the prompt the model reads, which is how this assertion earns its place.
    expect(prompt).not.toContain("\\`");
    // And the honesty requirement, which matches the project's rule about not reporting a
    // guess as a fact: a missing lyric reported as missing is useful, an invented one is not.
    expect(prompt).toMatch(/not from memory and not from a guess/);
    expect(prompt).toMatch(/Do not reconstruct it from memory/);
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
