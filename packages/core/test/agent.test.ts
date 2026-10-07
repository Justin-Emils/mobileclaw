import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Agent,
  type AgentEvent,
  type AgentRunResult,
  type AnyToolDefinition,
  KeyValueConversationStore,
  MemoryKeyValueStore,
  MockProvider,
  PermissionGate,
  ToolRegistry,
  type ConversationStore,
  type FileSystemService,
} from "@mobileclaw/core";

/* --------------------------------------------------------------- fixtures */

const files = new Map<string, string>();

const fakeFs: FileSystemService = {
  kind: "fake",
  async roots() {
    return ["/sdcard/Download"];
  },
  async read(path) {
    const value = files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  },
  async readBytes(path) {
    return new TextEncoder().encode(await this.read(path));
  },
  async write(path, data) {
    files.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
    return { path, name: path, size: 0, isDirectory: false, isFile: true };
  },
  async stat(path) {
    if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
    return { path, name: path, size: 0, isDirectory: false, isFile: true };
  },
  async exists(path) {
    return files.has(path);
  },
  async list() {
    return [];
  },
  async mkdir() {},
  async remove() {},
  async move() {},
  async copy() {},
  async glob() {
    return [];
  },
  async grep() {
    return [];
  },
};

const readTool = {
  name: "fs_read",
  description: "read a file",
  input: z.object({ path: z.string() }),
  risk: "read" as const,
  paths: (input: { path: string }) => [input.path],
  summarize: (input: { path: string }) => `read ${input.path}`,
  async execute(input: { path: string }) {
    return { path: input.path, content: await fakeFs.read(input.path) };
  },
};

const writeTool = {
  name: "fs_write",
  description: "write a file",
  input: z.object({ path: z.string(), content: z.string() }),
  risk: "write" as const,
  paths: (input: { path: string }) => [input.path],
  async execute(input: { path: string; content: string }) {
    await fakeFs.write(input.path, input.content);
    return { ok: true };
  },
};

const failingTool = {
  name: "fs_boom",
  description: "always fails",
  input: z.object({}),
  risk: "read" as const,
  async execute(): Promise<never> {
    throw new Error("permission denied by the OS");
  },
};

function buildAgent(options: {
  turns: ConstructorParameters<typeof MockProvider>[0]["turns"];
  permissions?: ConstructorParameters<typeof PermissionGate>[0];
  approval?: ConstructorParameters<typeof PermissionGate>[1];
  tools?: AnyToolDefinition[];
  store?: ConversationStore;
  maxSteps?: number;
}): { agent: Agent; provider: MockProvider; store: ConversationStore } {
  const provider = new MockProvider({ turns: options.turns });
  const registry = new ToolRegistry().registerAll(
    options.tools ?? [readTool, writeTool, failingTool],
  );
  const gate = new PermissionGate(
    options.permissions ?? { defaultMode: "allow" },
    options.approval,
  );
  const store = options.store ?? new KeyValueConversationStore(new MemoryKeyValueStore());
  const agent = new Agent({
    provider,
    registry,
    permissions: gate,
    store,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
  });
  return { agent, provider, store };
}

async function run(agent: Agent, input: string, extra: Record<string, unknown> = {}): Promise<AgentRunResult> {
  return agent.run({ input, ...extra });
}

/* ------------------------------------------------------------------ tests */

describe("Agent", () => {
  beforeEach(() => {
    files.clear();
  });

  it("returns a plain answer without touching tools", async () => {
    const { agent } = buildAgent({ turns: ["Hello there."] });
    const result = await run(agent, "hi");
    expect(result.text).toBe("Hello there.");
    expect(result.steps).toBe(1);
    expect(result.stopReason).toBe("completed");
    expect(result.toolCalls).toBe(0);
  });

  it("executes a tool, feeds the result back, then answers", async () => {
    files.set("/sdcard/Download/notes.txt", "buy milk");
    const { agent, provider, store } = buildAgent({
      turns: [
        { toolCalls: [{ name: "fs_read", input: { path: "/sdcard/Download/notes.txt" } }] },
        "The note says: buy milk.",
      ],
    });

    const events: AgentEvent[] = [];
    const result = await run(agent, "what is in my notes?", { onEvent: (e: AgentEvent) => events.push(e) });

    expect(result.text).toContain("buy milk");
    expect(result.toolCalls).toBe(1);
    expect(result.steps).toBe(2);

    // Second request must contain the tool result message.
    const secondRequest = provider.requests[1];
    const toolMessage = secondRequest?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.toolCallId).toBe("call_1");
    expect(toolMessage?.content).toContain("buy milk");

    // The system prompt advertises the tool inventory.
    expect(secondRequest?.messages[0]?.content).toContain("fs_read");

    // Events describe the whole life of the call.
    const kinds = events.map((event) => event.type);
    expect(kinds).toContain("tool_start");
    expect(kinds).toContain("tool_end");
    expect(kinds.at(-1)).toBe("done");

    // The transcript records the call and persists it.
    const conversation = await store.load(result.conversationId);
    expect(conversation?.entries.some((entry) => entry.kind === "tool" && entry.status === "ok")).toBe(true);
  });

  it("reports tool failures to the model instead of aborting", async () => {
    const { agent, provider } = buildAgent({
      turns: [
        { toolCalls: [{ name: "fs_read", input: { path: "/sdcard/Download/missing.txt" } }] },
        "That file does not exist.",
      ],
    });
    const result = await run(agent, "read missing.txt");
    expect(result.stopReason).toBe("completed");
    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("ENOENT");
  });

  it("turns a thrown tool error into a structured tool result", async () => {
    const { agent, provider } = buildAgent({
      turns: [{ toolCalls: [{ name: "fs_boom", input: {} }] }, "Understood."],
    });
    await run(agent, "try the broken thing");
    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("[E_TOOL_FAILED]");
    expect(toolMessage?.content).toContain("permission denied by the OS");
  });

  it("escalates a tool whose input fails validation", async () => {
    const { agent, provider } = buildAgent({
      turns: [{ toolCalls: [{ name: "fs_read", input: { wrong: true } }] }, "Let me retry."],
    });
    await run(agent, "read something");
    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("[E_TOOL_INPUT]");
  });

  it("denies a tool the policy blocks and tells the model not to retry", async () => {
    const { agent, provider } = buildAgent({
      turns: [{ toolCalls: [{ name: "fs_write", input: { path: "/sdcard/Download/x.txt", content: "hi" } }] }, "I need permission."],
      permissions: { defaultMode: "deny", riskModes: { read: "allow" } },
    });
    const events: AgentEvent[] = [];
    const result = await run(agent, "write x.txt", { onEvent: (e: AgentEvent) => events.push(e) });

    expect(files.has("/sdcard/Download/x.txt")).toBe(false);
    const denied = events.find((event) => event.type === "denied");
    expect(denied).toBeDefined();
    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("[E_PERMISSION_DENIED]");
    expect(toolMessage?.content).toContain("Do not retry");
    expect(result.stopReason).toBe("completed");
  });

  it("asks the user through the approval handler and remembers the answer", async () => {
    const approval = vi.fn().mockResolvedValue({ approved: true, remember: true });
    const { agent, provider } = buildAgent({
      turns: [
        { toolCalls: [{ name: "fs_write", input: { path: "/sdcard/Download/a.txt", content: "1" } }] },
        { toolCalls: [{ name: "fs_write", input: { path: "/sdcard/Download/b.txt", content: "2" } }] },
        "Both files written.",
      ],
      permissions: { defaultMode: "allow", alwaysAskRisks: ["write"] },
      approval,
    });
    await run(agent, "write two files");
    expect(approval).toHaveBeenCalledOnce();
    expect(files.get("/sdcard/Download/a.txt")).toBe("1");
    expect(files.get("/sdcard/Download/b.txt")).toBe("2");
    expect(provider.requests).toHaveLength(3);
  });

  it("stops at the step limit and records a warning notice", async () => {
    const looping = new MockProvider({
      turns: [{ toolCalls: [{ name: "fs_read", input: { path: "/sdcard/Download/notes.txt" } }] }],
      repeatLast: true,
    });
    files.set("/sdcard/Download/notes.txt", "loop");
    const registry = new ToolRegistry().register(readTool);
    const store = new KeyValueConversationStore(new MemoryKeyValueStore());
    const agent = new Agent({
      provider: looping,
      registry,
      permissions: new PermissionGate({ defaultMode: "allow" }),
      store,
      maxSteps: 3,
    });

    const result = await run(agent, "keep reading");
    expect(result.stopReason).toBe("step_limit");
    expect(result.steps).toBe(3);
    expect(result.toolCalls).toBe(3);
    const conversation = await store.load(result.conversationId);
    expect(
      conversation?.entries.some((entry) => entry.kind === "notice" && entry.level === "warn"),
    ).toBe(true);
    // Every assistant tool call must be answered, or the next request is invalid.
    const toolMessages = conversation?.messages.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(3);
  });

  it("reports provider failures without losing the conversation", async () => {
    const { agent } = buildAgent({ turns: [{ error: "context length exceeded" }] });
    const result = await run(agent, "hi");
    expect(result.stopReason).toBe("error");
    expect(result.error?.message).toContain("context length exceeded");
  });

  it("cancels cleanly when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent } = buildAgent({ turns: ["never reached"] });
    const result = await run(agent, "hi", { signal: controller.signal });
    expect(result.stopReason).toBe("cancelled");
  });

  it("continues an existing conversation and titles it from the first message", async () => {
    const { agent, store, provider } = buildAgent({ turns: ["first", "second"] });
    const first = await run(agent, "整理我的下载目录");
    const second = await run(agent, "再按大小排序", { conversationId: first.conversationId });

    expect(second.conversationId).toBe(first.conversationId);
    const conversation = await store.load(first.conversationId);
    expect(conversation?.title).toBe("整理我的下载目录");
    // The second request carries the whole history: user, assistant, user.
    expect(provider.requests[1]?.messages.filter((m) => m.role !== "system")).toHaveLength(3);
  });

  it("only offers the selected tools and reflects them in the system prompt", async () => {
    const provider = new MockProvider({ turns: ["ok"] });
    const scoped = new Agent({
      provider,
      registry: new ToolRegistry().registerAll([readTool, writeTool]),
      permissions: new PermissionGate({ defaultMode: "allow" }),
      store: new KeyValueConversationStore(new MemoryKeyValueStore()),
      toolSelection: ["fs_read"],
      systemPrompt: "Be terse.",
    });
    await run(scoped, "hi");
    const request = provider.requests[0];
    expect(request?.tools?.map((tool) => tool.name)).toEqual(["fs_read"]);
    expect(request?.messages[0]?.content).toContain("Be terse.");
    expect(request?.messages[0]?.content).not.toContain("fs_write");
  });

  it("appends the environment block supplied by the host", async () => {
    const provider = new MockProvider({ turns: ["ok"] });
    const agent = new Agent({
      provider,
      registry: new ToolRegistry().register(readTool),
      permissions: new PermissionGate({ defaultMode: "allow" }),
      store: new KeyValueConversationStore(new MemoryKeyValueStore()),
      environment: () => "Allowed roots: /sdcard/Download",
    });
    await run(agent, "where can you look?");
    expect(provider.requests[0]?.messages[0]?.content).toContain("Allowed roots: /sdcard/Download");
  });

  it("tells the model how much step budget is left", async () => {
    const provider = new MockProvider({ turns: ["ok"] });
    const agent = new Agent({
      provider,
      registry: new ToolRegistry().register(readTool),
      permissions: new PermissionGate({ defaultMode: "allow" }),
      store: new KeyValueConversationStore(new MemoryKeyValueStore()),
      maxSteps: 6,
    });
    await run(agent, "do something");
    const system = provider.requests[0]?.messages[0]?.content ?? "";
    expect(system).toContain("## Budget");
    expect(system).toContain("6 of 6 steps left");
  });

  it("urges the model to wrap up when the budget runs low", async () => {
    const provider = new MockProvider({
      turns: [
        { toolCalls: [{ name: "fs_read", input: { path: "/sdcard/Download/notes.txt" } }] },
        { toolCalls: [{ name: "fs_read", input: { path: "/sdcard/Download/notes.txt" } }] },
        { toolCalls: [{ name: "fs_read", input: { path: "/sdcard/Download/notes.txt" } }] },
      ],
    });
    files.set("/sdcard/Download/notes.txt", "x");
    const agent = new Agent({
      provider,
      registry: new ToolRegistry().register(readTool),
      permissions: new PermissionGate({ defaultMode: "allow" }),
      store: new KeyValueConversationStore(new MemoryKeyValueStore()),
      maxSteps: 3,
    });
    await run(agent, "keep going");
    // By the final step the prompt must tell the model to stop exploring.
    const lastSystem = provider.requests.at(-1)?.messages[0]?.content ?? "";
    expect(lastSystem).toContain("Stop exploring");
    expect(lastSystem).toContain("1 step(s) left");
  });

  it("explains a step-limit stop and how to resume", async () => {
    const looping = new MockProvider({
      turns: [{ toolCalls: [{ name: "fs_read", input: { path: "/sdcard/Download/notes.txt" } }] }],
      repeatLast: true,
    });
    files.set("/sdcard/Download/notes.txt", "loop");
    const store = new KeyValueConversationStore(new MemoryKeyValueStore());
    const agent = new Agent({
      provider: looping,
      registry: new ToolRegistry().register(readTool),
      permissions: new PermissionGate({ defaultMode: "allow" }),
      store,
      maxSteps: 2,
    });
    const result = await run(agent, "loop forever");
    const conversation = await store.load(result.conversationId);
    const notice = conversation?.entries.find((entry) => entry.kind === "notice");
    const text = notice?.kind === "notice" ? notice.text : "";
    expect(text).toContain("2 tool call(s)");
    expect(text).toContain("Send another message to continue");
  });

  it("instructs the model to answer in the user's language", async () => {
    const provider = new MockProvider({ turns: ["ok"] });
    const agent = new Agent({
      provider,
      registry: new ToolRegistry().register(readTool),
      permissions: new PermissionGate({ defaultMode: "allow" }),
      store: new KeyValueConversationStore(new MemoryKeyValueStore()),
    });
    await run(agent, "整理我的下载目录");
    const system = provider.requests[0]?.messages[0]?.content ?? "";
    // The instruction has to be explicit: a soft "use the user's language" was
    // ignored in practice and the model answered a Chinese request in English.
    expect(system).toMatch(/same language as the user's most recent message/i);
    expect(system).toMatch(/never switch to English/i);
  });

  it("tells the model to ask before touching app-owned folders", async () => {
    const provider = new MockProvider({ turns: ["ok"] });
    const agent = new Agent({
      provider,
      registry: new ToolRegistry().register(readTool),
      permissions: new PermissionGate({ defaultMode: "allow" }),
      store: new KeyValueConversationStore(new MemoryKeyValueStore()),
    });
    await run(agent, "tidy up");
    const system = provider.requests[0]?.messages[0]?.content ?? "";
    expect(system).toMatch(/do NOT move or delete them on your own/i);
    expect(system).toContain("WeiXin");
    expect(system).toContain(".thumbnails");
  });

  it("renders a tool-authored display for the model and data for the UI", async () => {
    const registry = new ToolRegistry().register({
      name: "fs_list",
      description: "list",
      input: z.object({ path: z.string() }),
      risk: "read" as const,
      async execute() {
        return {
          display: "/x — 2 entries\nfiles:\n  a.txt (1.2 KB)\n  b.txt (3 MB)",
          data: { count: 2, files: [{ name: "a.txt" }, { name: "b.txt" }] },
        };
      },
    });
    const provider = new MockProvider({
      turns: [{ toolCalls: [{ name: "fs_list", input: { path: "/x" } }] }, "done"],
    });
    const agent = new Agent({
      provider,
      registry,
      permissions: new PermissionGate({ defaultMode: "allow" }),
      store: new KeyValueConversationStore(new MemoryKeyValueStore()),
    });
    await run(agent, "list it");
    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
    // The model must receive the readable text, not a JSON dump cut mid-path.
    expect(toolMessage?.content).toContain("a.txt (1.2 KB)");
    expect(toolMessage?.content).not.toContain("{");
  });
});
