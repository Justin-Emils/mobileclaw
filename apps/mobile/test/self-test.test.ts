import { describe, expect, it } from "vitest";
import { GuardedFileSystem } from "@mobileclaw/capabilities";
import { PathGuard } from "@mobileclaw/core";
import { mergeConfig } from "@/runtime/config";
import { MobileClawRuntime } from "@/runtime/runtime";
import { AdapterKeyValueStore, MemoryKvAdapter } from "@/runtime/services/storage";
import { MemorySecretStore } from "@/runtime/services/secrets";
import { MemoryShellService } from "@/runtime/services/memory-shell";
import { ExpoHttpService } from "@/runtime/services/expo-http";
import { ExpoSystemService } from "@/runtime/services/expo-system";
import { ApprovalBroker } from "@/runtime/approval";

/**
 * The in-app self-test exists so the agent pipeline can be exercised with no API key, no
 * network and no user input. That is what makes it the one end-to-end check possible on a
 * device that has none of those.
 *
 * What must hold: it really runs a turn, the tool call is real (gated and executed by the
 * normal code), the result is persisted, and afterwards the app is exactly as it was --
 * a self-test that left a fake key or a scripted transport behind would be worse than none.
 */

function buildRuntime() {
  // A directory the scripted tool call actually lists, so `fs_list` succeeds for real.
  const files = new Map<string, string>([
    ["/demo/a.txt", "content"],
    ["/demo/Download/report.pdf", "pdf"],
    ["/demo/Download/notes.md", "notes"],
  ]);
  const fs = new GuardedFileSystem({
    driver: {
      async readFile(path: string) {
        const value = files.get(path);
        if (value === undefined) throw new Error(`ENOENT: ${path}`);
        return value;
      },
      async readFileBytes(path: string) {
        return new TextEncoder().encode(await this.readFile(path));
      },
      async writeFile(path: string, data: string | Uint8Array) {
        files.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
      },
      async stat(path: string) {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return { size: 0, mtimeMs: 0, isDirectory: () => false, isFile: () => true };
      },
      async readdir(path: string) {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const names = new Set<string>();
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const head = key.slice(prefix.length).split("/")[0];
          if (head) names.add(head);
        }
        return [...names];
      },
      async mkdir() {},
      async rm() {},
      async rename() {},
      async copy() {},
    },
    roots: ["/demo"],
    guard: new PathGuard({ roots: ["/demo"] }, "android"),
  });

  const secrets = new MemorySecretStore();
  const broker = new ApprovalBroker();
  broker.autoAnswer = () => ({ approved: true });

  const runtime = new MobileClawRuntime({
    config: mergeConfig({
      roots: ["/demo"],
      provider: { ...mergeConfig(undefined).provider, baseUrl: "https://test.local/v1" },
    }),
    secrets,
    kv: new AdapterKeyValueStore(new MemoryKvAdapter()),
    fs,
    workspaceBaseDir: "/demo/.workspaces",
    shell: new MemoryShellService({ available: false, reason: "none" }),
    http: new ExpoHttpService(),
    system: new ExpoSystemService({ async openUrl() {} }),
    approvals: broker,
  });
  return { runtime, secrets };
}

describe("runSelfTest", () => {
  it("runs a real tool call and reports it", async () => {
    const { runtime } = buildRuntime();
    await runtime.start();

    const result = await runtime.runSelfTest();

    expect(result.ok).toBe(true);
    // The scripted model asked for fs_list, so the tool really ran.
    expect(result.toolCalls).toContain("fs_list");
    expect(result.detail).toContain("工具结果回到模型: 是");
  });

  it("persists the turn, which is the thing worth proving", async () => {
    const { runtime } = buildRuntime();
    await runtime.start();

    const result = await runtime.runSelfTest();

    // Read back through the public API, from the store rather than from memory.
    const stored = await runtime.loadConversation(result.conversationId);
    expect(stored).toBeDefined();
    expect((stored?.entries?.length ?? 0)).toBeGreaterThan(0);
    // It shows up in the history list, which is what the user would see.
    const listed = await runtime.listConversations();
    expect(listed.some((item) => item.id === result.conversationId)).toBe(true);
  });

  it("assigns the conversation its own workspace", async () => {
    const { runtime } = buildRuntime();
    await runtime.start();
    const result = await runtime.runSelfTest();
    expect(result.workspace).toContain(result.conversationId);
    expect(result.detail).toContain("会话工作区:");
  });

  it("leaves no API key behind", async () => {
    // A self-test that installed a placeholder key permanently would make the app look
    // configured when it is not.
    const { runtime, secrets } = buildRuntime();
    await runtime.start();
    expect(runtime.hasApiKey()).toBe(false);

    await runtime.runSelfTest();

    expect(runtime.hasApiKey()).toBe(false);
    expect(await secrets.get("provider.apiKey")).toBeUndefined();
  });

  it("restores a real key that was already configured", async () => {
    const { runtime, secrets } = buildRuntime();
    await secrets.set("provider.apiKey", "sk-real");
    await runtime.start();
    expect(runtime.hasApiKey()).toBe(true);

    await runtime.runSelfTest();

    expect(runtime.hasApiKey()).toBe(true);
    expect(await secrets.get("provider.apiKey")).toBe("sk-real");
  });

  it("does not leave the scripted transport installed", async () => {
    // If it survived, a later real turn would be answered by the script and the user
    // would never know their model was not being consulted.
    const { runtime } = buildRuntime();
    await runtime.start();
    await runtime.runSelfTest();

    const info = runtime.providerInfo();
    expect(info.model).toBe(mergeConfig(undefined).provider.model);
    // The provider is rebuilt from config, so it points where the config says.
    const check = await runtime.checkProvider();
    // Fails on network, but crucially NOT with the self-test's placeholder key error.
    expect(check.message).not.toContain("selftest");
  });

  it("creates a new conversation per run rather than reusing one", async () => {
    const { runtime } = buildRuntime();
    await runtime.start();
    const first = await runtime.runSelfTest();
    const second = await runtime.runSelfTest();
    expect(first.conversationId).not.toBe(second.conversationId);
    // Both are listed, so each run left its own record rather than overwriting one.
    const ids = (await runtime.listConversations()).map((item) => item.id);
    expect(ids).toContain(first.conversationId);
    expect(ids).toContain(second.conversationId);
  });
});
