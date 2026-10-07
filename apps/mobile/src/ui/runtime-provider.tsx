import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { bootstrapRuntime } from "@/runtime/bootstrap";
import { MobileClawRuntime } from "@/runtime/runtime";
import { ApprovalBroker } from "@/runtime/approval";
import { DEFAULT_CONFIG, type AppConfig } from "@/runtime/config";
import { AdapterKeyValueStore, MemoryKvAdapter } from "@/runtime/services/storage";
import { MemorySecretStore } from "@/runtime/services/secrets";
import { ExpoHttpService } from "@/runtime/services/expo-http";
import { ExpoSystemService } from "@/runtime/services/expo-system";
import { MemoryShellService } from "@/runtime/services/memory-shell";
import { GuardedFileSystem } from "@mobileclaw/capabilities";
import { PathGuard } from "@mobileclaw/core";

interface RuntimeState {
  runtime?: MobileClawRuntime;
  status: "loading" | "ready" | "error";
  error?: string;
  /** True when the app fell back to the offline demo agent. */
  degraded: boolean;
}

const RuntimeContext = createContext<RuntimeState>({ status: "loading", degraded: false });

/**
 * Boots the agent runtime once and shares it through context.
 *
 * If the native/Expo modules are unavailable (a bare Metro bundle, a simulator
 * without SQLite, a broken dev build) we fall back to an in-memory runtime with a
 * scripted provider, so the UI stays explorable and the failure is visible
 * instead of being a white screen.
 */
export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RuntimeState>({ status: "loading", degraded: false });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      try {
        const runtime = await bootstrapRuntime();
        setState({ runtime, status: "ready", degraded: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          const runtime = await createOfflineRuntime(message);
          setState({ runtime, status: "ready", degraded: true, error: message });
        } catch (fallbackError) {
          setState({
            status: "error",
            degraded: true,
            error:
              fallbackError instanceof Error
                ? `${message} / fallback failed: ${fallbackError.message}`
                : message,
          });
        }
      }
    })();
  }, []);

  const value = useMemo(() => state, [state]);
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useRuntimeState(): RuntimeState {
  return useContext(RuntimeContext);
}

/** Runtime accessor for screens that work with or without a live runtime. */
export function useRuntime(): MobileClawRuntime {
  const { runtime } = useRuntimeState();
  if (!runtime) throw new Error("the agent runtime is not ready yet");
  return runtime;
}

/**
 * Offline demo runtime: a memory filesystem with sample files and a scripted
 * transport. It exercises the whole pipeline (tools, permissions, transcript)
 * without a network call, which also makes it useful for screenshots.
 */
async function createOfflineRuntime(reason: string): Promise<MobileClawRuntime> {
  const demoRoot = "/demo";
  const files = new Map<string, string>([
    [`${demoRoot}/Download/report-2026-Q1.pdf`, "%PDF-1.4 (not really)"],
    [`${demoRoot}/Download/notes.md`, "# Notes\n- call the plumber\n- renew domain\n"],
    [`${demoRoot}/Download/app.log`, "2026-10-07 INFO boot\n2026-10-07 ERROR disk almost full\n"],
    [`${demoRoot}/Documents/todo.txt`, "milk\neggs\ncoffee\n"],
  ]);

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
        const exists = files.has(path) || path === demoRoot;
        if (!exists) throw new Error(`ENOENT: ${path}`);
        return {
          size: files.get(path)?.length ?? 0,
          mtimeMs: Date.now(),
          isDirectory: () => !files.has(path),
          isFile: () => files.has(path),
        };
      },
      async readdir(path) {
        const prefix = `${path.replace(/\/$/, "")}/`;
        return [
          ...new Set(
            [...files.keys()]
              .filter((key) => key.startsWith(prefix))
              .map((key) => key.slice(prefix.length).split("/")[0] ?? ""),
          ),
        ].filter(Boolean);
      },
      async mkdir() {},
      async rm(path) {
        files.delete(path);
      },
      async rename(from, to) {
        const value = files.get(from);
        if (value === undefined) throw new Error(`ENOENT: ${from}`);
        files.delete(from);
        files.set(to, value);
      },
      async copy(from, to) {
        const value = files.get(from);
        if (value === undefined) throw new Error(`ENOENT: ${from}`);
        files.set(to, value);
      },
    },
    roots: [demoRoot],
    guard: new PathGuard({ roots: [demoRoot] }, "android"),
  });

  const runtime = new MobileClawRuntime({
    config: { ...DEFAULT_CONFIG, roots: [demoRoot] } as AppConfig,
    secrets: new MemorySecretStore(),
    kv: new AdapterKeyValueStore(new MemoryKvAdapter()),
    fs,
    shell: new MemoryShellService({ available: false, reason }),
    http: new ExpoHttpService(),
    system: new ExpoSystemService({ async openUrl() {} }),
    approvals: new ApprovalBroker(),
    // The demo filesystem is rooted at `demoRoot`, so keep workspaces inside it.
    workspaceBaseDir: demoRoot,
    // A transport that always answers with the same scripted turn: the demo has
    // no API key, so the runtime would otherwise fail before streaming anything.
    fetchImpl: demoFetch,
  });
  await runtime.start();
  return runtime;
}

/** Streams one canned assistant turn, in the OpenAI wire format. */
const demoFetch = (async () => {
  const script = [
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            content:
              "连不上模型服务商，现在处于离线演示模式。\n\n我仍能浏览内置的示例文件，比如问「我的下载目录里有什么？」。",
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
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
}) as unknown as typeof globalThis.fetch;

export { demoFetch };
