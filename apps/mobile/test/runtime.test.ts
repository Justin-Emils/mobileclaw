import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@mobileclaw/core";
import { AsyncEventQueue } from "@/runtime/event-queue";
import { MobileClawRuntime } from "@/runtime/runtime";
import { ApprovalBroker } from "@/runtime/approval";
import { DEFAULT_CONFIG, mergeConfig } from "@/runtime/config";
import { AdapterKeyValueStore, MemoryKvAdapter } from "@/runtime/services/storage";
import { MemorySecretStore } from "@/runtime/services/secrets";
import { MemoryShellService, RecordingShellService } from "@/runtime/services/memory-shell";
import { ExpoHttpService } from "@/runtime/services/expo-http";
import { ExpoSystemService } from "@/runtime/services/expo-system";
import { GuardedFileSystem } from "@mobileclaw/capabilities";
import { PathGuard } from "@mobileclaw/core";

/**
 * Fake transport that speaks the OpenAI streaming protocol.
 *
 * Driving a fake `fetch` instead of a fake provider means these tests exercise
 * the real request building, SSE parsing and tool-call aggregation.
 */
function streamingFetch(scripts: string[]): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  let cursor = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    const script = scripts[Math.min(cursor, scripts.length - 1)] ?? "";
    cursor += 1;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(script));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: impl, bodies };
}

/** One assistant turn that answers with plain text. */
function textTurn(text: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

/** One assistant turn that requests a tool call. */
function toolTurn(id: string, name: string, args: unknown): string {
  const payload = JSON.stringify(args);
  return [
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: "" } }] } }],
    })}\n\n`,
    // Split the arguments across chunks, exactly as real providers do.
    `data: ${JSON.stringify({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: payload.slice(0, 4) } }] } },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: payload.slice(4) } }] } },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

describe("AsyncEventQueue", () => {
  it("delivers events as they arrive instead of after the run finishes", async () => {
    const queue = new AsyncEventQueue();
    const seen: string[] = [];

    const consumer = (async () => {
      while (true) {
        const event = await queue.shift();
        if (!event) break;
        seen.push(event.type);
      }
    })();

    // Wait until the consumer is actually parked, then assert that a single push
    // reaches it without waiting for the producer to finish.
    await queue.waitForConsumer();
    queue.push({ type: "step", step: 1 });
    await queue.waitForConsumer();
    expect(seen).toEqual(["step"]);

    queue.push({ type: "text", delta: "hi" });
    await queue.waitForConsumer();
    expect(seen).toEqual(["step", "text"]);

    queue.close();
    await consumer;
    expect(seen).toEqual(["step", "text"]);
  });

  it("drains buffered events before reporting the end", async () => {
    const queue = new AsyncEventQueue();
    queue.push({ type: "text", delta: "a" });
    queue.push({ type: "text", delta: "b" });
    queue.close();

    const drained: AgentEvent[] = [];
    while (true) {
      const event = await queue.shift();
      if (!event) break;
      drained.push(event);
    }
    expect(drained.map((event) => (event.type === "text" ? event.delta : ""))).toEqual(["a", "b"]);
    expect(queue.isClosed).toBe(true);
  });

  it("ignores pushes after close and unblocks a waiting consumer", async () => {
    const queue = new AsyncEventQueue();
    const pending = queue.shift();
    queue.push({ type: "done", text: "x", steps: 1, stopReason: "completed" });
    expect((await pending)?.type).toBe("done");

    const second = queue.shift();
    queue.close();
    expect(await second).toBeUndefined();
    queue.push({ type: "step", step: 9 });
    expect(queue.size).toBe(0);
  });
});

describe("ApprovalBroker", () => {
  it("parks a request until the UI answers it", async () => {
    const broker = new ApprovalBroker();
    const answer = broker.request({
      tool: "fs_write",
      risk: "write",
      input: { path: "/x" },
      reason: "risk \"write\" needs confirmation",
    });

    expect(broker.pending()).toHaveLength(1);
    const [pending] = broker.pending();
    expect(pending?.title).toBe("fs_write (write)");
    expect(pending?.detail).toContain("/x");

    broker.answer(pending!.id, { approved: true, remember: true });
    await expect(answer).resolves.toEqual({ approved: true, remember: true });
    expect(broker.pending()).toHaveLength(0);
  });

  it("notifies subscribers on enqueue and answer", async () => {
    const broker = new ApprovalBroker();
    let notifications = 0;
    const unsubscribe = broker.subscribe(() => {
      notifications += 1;
    });

    const promise = broker.request({ tool: "shell_run", risk: "execute", input: {} });
    expect(notifications).toBe(1);
    broker.flush({ approved: false });
    await expect(promise).resolves.toEqual({ approved: false });
    expect(notifications).toBe(2);

    unsubscribe();
    void broker.request({ tool: "shell_run", risk: "execute", input: {} }).then(() => undefined);
    expect(notifications).toBe(2);
    broker.flush({ approved: false });
  });

  it("short-circuits when an auto-answer is configured", async () => {
    const broker = new ApprovalBroker();
    broker.autoAnswer = () => ({ approved: true });
    await expect(broker.request({ tool: "fs_read", risk: "read", input: {} })).resolves.toEqual({
      approved: true,
    });
    expect(broker.pending()).toHaveLength(0);
  });
});

describe("config", () => {
  it("merges a stored config over the defaults", () => {
    const merged = mergeConfig({
      provider: { model: "deepseek-reasoner" },
      permissions: { riskModes: { write: "allow" } },
      roots: ["/sdcard/Download"],
    });
    expect(merged.provider.model).toBe("deepseek-reasoner");
    // Untouched fields keep their defaults.
    expect(merged.provider.baseUrl).toBe(DEFAULT_CONFIG.provider.baseUrl);
    expect(merged.permissions.riskModes?.read).toBe("allow");
    expect(merged.permissions.riskModes?.write).toBe("allow");
    expect(merged.roots).toEqual(["/sdcard/Download"]);
  });

  it("falls back to defaults for corrupt input", () => {
    expect(mergeConfig(null).provider.model).toBe(DEFAULT_CONFIG.provider.model);
    expect(mergeConfig("nonsense").roots).toEqual([]);
  });
});

describe("storage adapters", () => {
  it("round-trips values and lists by prefix", async () => {
    const store = new AdapterKeyValueStore(new MemoryKvAdapter());
    await store.set("conversation:a", "1");
    await store.set("conversation:b", "2");
    await store.set("other", "3");
    expect(await store.get("conversation:a")).toBe("1");
    expect(await store.keys("conversation:")).toEqual(["conversation:a", "conversation:b"]);
    await store.delete("conversation:a");
    expect(await store.get("conversation:a")).toBeUndefined();
  });

  it("keeps secrets out of plain storage", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("provider.apiKey", "sk-test");
    expect(await secrets.get("provider.apiKey")).toBe("sk-test");
    await secrets.delete("provider.apiKey");
    expect(await secrets.get("provider.apiKey")).toBeUndefined();
  });
});

describe("shell backends", () => {
  it("answers honestly when no backend is available", async () => {
    const shell = new MemoryShellService({ available: false, reason: "no Termux, no Shizuku" });
    expect(await shell.available()).toBe(false);
    const result = await shell.run("ls");
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("no Termux");
  });

  it("records commands in dry-run mode without executing them", async () => {
    const shell = new RecordingShellService({ respond: () => ({ stdout: "simulated" }) });
    const result = await shell.run("rm -rf ~/notes", { timeoutMs: 1000 });
    expect(shell.commands).toHaveLength(1);
    expect(shell.commands[0]?.command).toBe("rm -rf ~/notes");
    expect(result.stdout).toBe("simulated");
  });
});

describe("HTTP service", () => {
  it("normalises headers, body and cancellation", async () => {
    const fakeFetch = (async () =>
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
    const http = new ExpoHttpService(fakeFetch);
    const response = await http.fetch({ url: "https://example.com" });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(response.body).toBe("hello");
  });

  it("reports failures as structured tool errors", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const http = new ExpoHttpService(failing);
    await expect(http.fetch({ url: "https://example.com" })).rejects.toThrowError(/network down/);
  });
});

describe("system service", () => {
  it("reports unsupported platform features instead of pretending", async () => {
    const system = new ExpoSystemService({ async openUrl() {} });
    await expect(system.listApps()).rejects.toThrowError(/native module/);
    await expect(system.getClipboard()).rejects.toThrowError(/clipboard read is unavailable/);
    await expect(system.notify({ title: "x" })).rejects.toThrowError(/notifications are unavailable/);
  });

  it("delegates to the platform ports when present", async () => {
    const opened: string[] = [];
    const system = new ExpoSystemService({
      async openUrl(url) {
        opened.push(url);
      },
      async getClipboard() {
        return "copied";
      },
    });
    await system.openUrl("https://example.com");
    expect(opened).toEqual(["https://example.com"]);
    expect(await system.getClipboard()).toBe("copied");
  });
});

describe("MobileClawRuntime", () => {
  /** A runtime over an in-memory filesystem with a scripted model transport. */
  function buildRuntime(options: { scripts?: string[]; approve?: boolean } = {}) {
    return buildRuntimeOver(new AdapterKeyValueStore(new MemoryKvAdapter()), options);
  }

  /**
   * Same, but over a caller-supplied key-value store.
   *
   * Lets a test construct a second runtime on the store a first one wrote to, which
   * is how a restart is modelled without touching the filesystem.
   */
  function buildRuntimeOver(
    kv: AdapterKeyValueStore,
    options: { scripts?: string[]; approve?: boolean } = {},
  ) {
    const files = new Map<string, string>([["/demo/a.txt", "content"]]);
    const fs = new GuardedFileSystem({
      driver: {
        async readFile(path) {
          const value = files.get(path);
          if (value === undefined) throw new Error(`ENOENT: ${path}`);
          return value;
        },
        async readFileBytes(path) {
          return new TextEncoder().encode(await this.readFile(path));
        },
        async writeFile(path, data) {
          files.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
        },
        async stat(path) {
          if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
          return { size: 0, mtimeMs: 0, isDirectory: () => false, isFile: () => true };
        },
        async readdir() {
          return [];
        },
        async mkdir() {},
        async rm() {},
        async rename() {},
        async copy() {},
      },
      roots: ["/demo"],
      guard: new PathGuard({ roots: ["/demo"] }, "android"),
    });

    const transport = streamingFetch(
      options.scripts ?? [
        toolTurn("call_1", "fs_read", { path: "/demo/a.txt" }),
        textTurn("The file says: content"),
      ],
    );

    const broker = new ApprovalBroker();
    broker.autoAnswer = () => ({ approved: options.approve ?? true });

    // A key must exist, otherwise the provider refuses before any request is
    // made (which is itself covered as an error path below).
    const secrets = new MemorySecretStore();
    void secrets.set("provider.apiKey", "sk-test");

    const runtime = new MobileClawRuntime({
      config: mergeConfig({
        roots: ["/demo"],
        provider: { ...mergeConfig(undefined).provider, baseUrl: "https://test.local/v1" },
      }),
      secrets,
      kv,
      fs,
      workspaceBaseDir: "/demo/.workspaces",
      shell: new MemoryShellService({ available: false, reason: "none" }),
      http: new ExpoHttpService(),
      system: new ExpoSystemService({ async openUrl() {} }),
      fetchImpl: transport.fetch,
      approvals: broker,
    });
    return { runtime, files, broker, bodies: transport.bodies, secrets, kv };
  }

  /** Drive one turn to completion and return the conversation id it landed in. */
  async function runToEnd(
    runtime: MobileClawRuntime,
    input: string,
    conversationId?: string,
  ): Promise<string> {
    const stream = runtime.send(input, conversationId ? { conversationId } : {});
    while (true) {
      const step = await stream.next();
      if (step.done) return step.value.conversationId;
    }
  }

  it("loads every capability plugin with its tools", async () => {
    const { runtime } = buildRuntime();
    await runtime.start();
    const tools = runtime.toolNames();
    expect(tools).toContain("fs_read");
    expect(tools).toContain("shell_run");
    expect(tools).toContain("web_fetch");
    expect(tools).toContain("system_open");
    expect(runtime.pluginStatus().every((plugin) => plugin.status === "loaded")).toBe(true);
  });

  it("reports storage access as unknown when no probe path is allowed at all", async () => {
    // buildRuntime roots the fake fs at /demo, so every shared-storage probe is
    // rejected by the path guard. That is a third state on purpose: "cannot even
    // look" is not the same as "allowed to look and it is empty", and only the latter
    // means the user must grant all-files access.
    const harness = buildRuntime();
    await harness.runtime.start();
    const report = await harness.runtime.checkStorageAccess();
    expect(report.status).toBe("unknown");
    expect(report.detail).toContain("无法探测");
  });

  it("gives each conversation its own workspace and keeps approvals apart", async () => {
    // The app's actual wiring: one runtime (and therefore one permission gate) serving
    // several conversations. This is where a leak or a shared workspace would show up.
    const harness = buildRuntime({ scripts: [textTurn("ok"), textTurn("ok")] });
    await harness.runtime.start();

    const first = await runToEnd(harness.runtime, "第一个会话");
    const second = await runToEnd(harness.runtime, "第二个会话");
    expect(first).not.toBe(second);

    const one = await harness.runtime.loadConversation(first);
    const two = await harness.runtime.loadConversation(second);
    expect(one?.workspace).toBeTruthy();
    expect(two?.workspace).toBeTruthy();
    // Different directories, or the "separate workspace" guarantee is empty.
    expect(one?.workspace).not.toBe(two?.workspace);

    // Approvals granted in one must not be visible to the other. Ask the gate the
    // same question the agent asks, for both conversations.
    harness.broker.autoAnswer = () => ({ approved: true, remember: true });
    const gate = harness.runtime.permissions;
    await gate.authorize({ tool: "fs_write", risk: "write", input: {}, conversationId: first });
    expect(gate.evaluate({ tool: "fs_write", risk: "write", input: {}, conversationId: first }).allowed).toBe(true);
    expect(gate.evaluate({ tool: "fs_write", risk: "write", input: {}, conversationId: second }).allowed).toBe(false);
  });

  it("keeps conversations across a restart", async () => {
    const harness = buildRuntime({ scripts: [textTurn("第一次回答")] });
    await harness.runtime.start();

    let conversationId = "";
    const stream = harness.runtime.send("第一个问题");
    while (true) {
      const step = await stream.next();
      if (step.done) {
        conversationId = step.value.conversationId;
        break;
      }
    }
    expect(conversationId).not.toBe("");

    const listed = await harness.runtime.listConversations();
    expect(listed.map((entry) => entry.id)).toContain(conversationId);
    expect(listed[0]?.title).toContain("第一个问题");

    // A second runtime over the same key-value store is exactly what a restart is:
    // in-memory state is gone, storage is not. This is the behaviour the app was
    // missing entirely -- conversations were written but never read back.
    const restarted = buildRuntimeOver(harness.kv);
    await restarted.runtime.start();

    const afterRestart = await restarted.runtime.listConversations();
    expect(afterRestart.map((entry) => entry.id)).toContain(conversationId);

    const restored = await restarted.runtime.loadConversation(conversationId);
    expect(
      restored?.messages.some((message) => message.role === "user" && message.content === "第一个问题"),
    ).toBe(true);
    expect(
      restored?.messages.some(
        (message) => message.role === "assistant" && message.content.includes("第一次回答"),
      ),
    ).toBe(true);
    // The transcript cards need the tool entries too, not just the prose.
    expect(Array.isArray(restored?.entries)).toBe(true);
  });

  it("streams a full turn and records the transcript", async () => {
    const { runtime } = buildRuntime();
    await runtime.start();

    const events: string[] = [];
    let conversationId = "";
    const stream = runtime.send("read my file");
    while (true) {
      const step = await stream.next();
      if (step.done) {
        conversationId = step.value.conversationId;
        expect(step.value.text).toContain("content");
        break;
      }
      events.push(step.value.type);
    }

    expect(events).toContain("tool_start");
    expect(events).toContain("tool_end");
    expect(events.at(-1)).toBe("done");

    const conversation = await runtime.loadConversation(conversationId);
    expect(conversation?.entries.some((entry) => entry.kind === "tool" && entry.status === "ok")).toBe(true);
  });

  it("refuses a write the user denies, without running the tool", async () => {
    const { runtime, files } = buildRuntime({
      approve: false,
      // The model asks for a write, then wraps up.
      scripts: [
        toolTurn("call_9", "fs_write", { path: "/demo/new.txt", content: "x" }),
        textTurn("I could not write the file."),
      ],
    });
    await runtime.start();

    const statuses: string[] = [];
    const stream = runtime.send("write a file");
    while (true) {
      const step = await stream.next();
      if (step.done) break;
      if (step.value.type === "tool_end") statuses.push(step.value.status);
    }

    expect(statuses).toEqual(["denied"]);
    // The decisive assertion: the file must not exist on disk.
    expect(files.has("/demo/new.txt")).toBe(false);
  });

  it("sends the tool result back to the model on the next request", async () => {
    const { runtime, bodies } = buildRuntime();
    await runtime.start();
    const stream = runtime.send("read my file");
    while (!(await stream.next()).done) {
      // drain
    }

    expect(bodies).toHaveLength(2);
    const second = bodies[1] as { messages: { role: string; content: string }[] };
    const toolMessage = second.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("content");
  });

  it("round-trips conversation history through the store", async () => {
    const { runtime } = buildRuntime();
    await runtime.start();
    const stream = runtime.send("hello");
    let result;
    while (true) {
      const step = await stream.next();
      if (step.done) {
        result = step.value;
        break;
      }
    }
    const list = await runtime.listConversations();
    expect(list.map((entry) => entry.id)).toContain(result!.conversationId);
    await runtime.deleteConversation(result!.conversationId);
    expect(await runtime.loadConversation(result!.conversationId)).toBeUndefined();
  });

  it("fails the turn with a clear message when no API key is stored", async () => {
    const { runtime, secrets } = buildRuntime();
    await secrets.delete("provider.apiKey");
    // Rebuild so the runtime picks up the now-empty secret store.
    await runtime.setApiKey("");
    const stream = runtime.send("hello");
    let result;
    while (true) {
      const step = await stream.next();
      if (step.done) {
        result = step.value;
        break;
      }
    }
    expect(result?.stopReason).toBe("error");
    expect(result?.error?.message).toContain("no API key configured");
  });

  it("reports a healthy self-check when the key is stored", async () => {
    const { runtime } = buildRuntime();
    await runtime.start();
    const diag = await runtime.diagnostics();
    expect(diag.apiKeyPresent).toBe(true);
    expect(diag.apiKeyLength).toBeGreaterThan(0);
    // The probe write/read/delete round trip is what proves the store works.
    expect(diag.secretStore.ok).toBe(true);
    expect(diag.tools).toBeGreaterThan(15);
    expect(diag.plugins.every((plugin) => plugin.status === "loaded")).toBe(true);
    expect(diag.provider.baseUrl).toBe("https://test.local/v1");
  });

  it("flags a secret store that silently drops writes, instead of failing later", async () => {
    const { runtime, secrets } = buildRuntime();
    await runtime.start();
    // Simulate a device where writes do not stick (missing native module, broken
    // Keystore). Without this check it would only surface as "no API key
    // configured" in the middle of a chat turn.
    const originalSet = secrets.set.bind(secrets);
    secrets.set = async (key: string, value: string) => {
      if (key === "diagnostics.probe") return; // the write vanishes
      await originalSet(key, value);
    };

    const diag = await runtime.diagnostics();
    expect(diag.secretStore.ok).toBe(false);
    expect(diag.secretStore.detail).toMatch(/read back nothing/);
    // The probe must not disturb the real key.
    expect(diag.apiKeyPresent).toBe(true);
    expect(await secrets.get("provider.apiKey")).toBe("sk-test");
  });

  it("reports a missing key explicitly in the self-check", async () => {
    const { runtime } = buildRuntime();
    await runtime.start();
    await runtime.setApiKey("");
    const diag = await runtime.diagnostics();
    expect(diag.apiKeyPresent).toBe(false);
    expect(diag.apiKeyLength).toBe(0);
  });

  it("verifies the key by reading it back, and notices when it does not persist", async () => {
    const { runtime, secrets } = buildRuntime();
    await runtime.start();

    const ok = await runtime.setApiKey("sk-fresh");
    expect(ok.stored).toBe(true);
    expect(ok.detail).toContain("stored");
    expect(runtime.hasApiKey()).toBe(true);

    // A store that accepts writes but loses them must be reported at save time.
    const originalSet = secrets.set.bind(secrets);
    secrets.set = async (key: string, value: string) => {
      if (key === "provider.apiKey") return; // the write vanishes
      await originalSet(key, value);
    };
    const lost = await runtime.setApiKey("sk-vanishing");
    expect(lost.stored).toBe(false);
    // Storage still holds the previous key, so the runtime adopts that rather
    // than the value the user just typed. A failed save must not leave the app
    // claiming to use a key it never stored.
    expect(lost.detail).toMatch(/returned a different value on read-back/);
    expect(await secrets.get("provider.apiKey")).toBe("sk-fresh");
    expect(runtime.hasApiKey()).toBe(true);
  });

  it("reloadApiKey picks up a key written outside the runtime", async () => {
    const { runtime, secrets } = buildRuntime();
    await runtime.start();
    await runtime.setApiKey("");

    await secrets.set("provider.apiKey", "sk-external");
    expect(runtime.hasApiKey()).toBe(false);
    expect(await runtime.reloadApiKey()).toBe(true);
    expect(runtime.hasApiKey()).toBe(true);
  });

  it("stops an in-flight run", async () => {
    const { runtime } = buildRuntime();
    await runtime.start();
    const stream = runtime.send("long task");
    runtime.stop();
    let stopReason = "";
    while (true) {
      const step = await stream.next();
      if (step.done) {
        stopReason = step.value.stopReason;
        break;
      }
    }
    expect(["cancelled", "completed"]).toContain(stopReason);
  });

  it("persists config changes through the provided callback", async () => {
    const saved: unknown[] = [];
    const { runtime } = buildRuntime();
    await runtime.start();
    const updated = await runtime.updateConfig({
      provider: { ...runtime.getConfig().provider, model: "deepseek-reasoner" },
    });
    saved.push(updated);
    expect(runtime.providerInfo().model).toBe("deepseek-reasoner");
    expect(saved).toHaveLength(1);
  });
});
