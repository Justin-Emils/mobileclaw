import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPythonTools,
  createShizukuTools,
  createSystemTools,
  createWebTools,
  htmlToText,
} from "@mobileclaw/capabilities";
import { NodeShellService, runFile } from "@mobileclaw/capabilities/node";
import type { ShellService, SystemService, HttpService } from "@mobileclaw/core";

const shell = new NodeShellService({ policy: { forbidShellSyntax: false } });
const call = { signal: new AbortController().signal, callId: "call_1" };

/**
 * Snippet-based tests go through a temp script file rather than `node -e "…"`:
 * a quoting-heavy command line is not portable (Windows `cmd /c` re-parses and
 * strips the nested quotes), and `runFile` passes every argument verbatim.
 */
async function withScript<T>(
  body: string,
  run: (path: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "mobileclaw-shell-"));
  try {
    const scriptPath = join(dir, "script.mjs");
    await writeFile(scriptPath, body);
    return await run(scriptPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("NodeShellService", () => {
  it("captures stdout, stderr and the exit code", async () => {
    await withScript("console.log('out'); console.error('err');", async (scriptPath) => {
      const result = await runFile(process.execPath, [scriptPath]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("out");
      expect(result.stderr.trim()).toBe("err");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  it("reports a non-zero exit without throwing", async () => {
    await withScript("process.exit(3);", async (scriptPath) => {
      const result = await runFile(process.execPath, [scriptPath]);
      expect(result.exitCode).toBe(3);
    });
  });

  it("still runs shell pipelines and non-quoted commands", async () => {
    const result = await shell.run("echo hi");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi");

    const node = await shell.run("node -v");
    expect(node.stdout.trim()).toMatch(/^v\d+\./);
  });

  it("pipes stdin into the command", async () => {
    const result = await shell.run("node -", { stdin: "console.log(6*7);" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("42");
  });

  it("blocks dangerous commands by policy", async () => {
    const result = await shell.run("rm -rf /");
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(126);
  });

  it("enforces the timeout and reports the kill", async () => {
    await withScript("setTimeout(() => {}, 5000);", async (scriptPath) => {
      const result = await runFile(process.execPath, [scriptPath], { timeoutMs: 300 });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("killed after 300ms");
    });

    const viaShell = await shell.run("node -", {
      stdin: "setTimeout(() => {}, 5000);",
      timeoutMs: 300,
    });
    expect(viaShell.exitCode).toBe(124);
    expect(viaShell.stderr).toContain("killed after 300ms");
  });

  it("can forbid shell metacharacters entirely", async () => {
    const strict = new NodeShellService({ policy: { forbidShellSyntax: true } });
    const blocked = await strict.run("echo a && echo b");
    expect(blocked.blocked).toBe(true);
    expect(blocked.stderr).toMatch(/metacharacters/);

    const allowed = await strict.run("node --version");
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout.trim()).toMatch(/^v\d+\./);
  });

  it("caps output so a chatty command cannot flood the transcript", async () => {
    const result = await shell.run("node -", {
      stdin: "process.stdout.write('x'.repeat(50000));",
      maxOutputBytes: 500,
    });
    expect(result.stdout).toContain("[output truncated]");
    expect(result.stdout.length).toBeLessThan(600);
  });
});

describe("Python tools", () => {
  it("reports the interpreter status honestly", async () => {
    const tools = createPythonTools({ shell, fs: null as never });
    const status = tools.find((tool) => tool.name === "python_status");
    const result = (await status?.execute!({} as never, call as never)) as {
      available: boolean;
      path?: string;
    };
    expect(typeof result.available).toBe("boolean");
    if (result.available) expect(result.path).toBeTruthy();
  });

  it("explains how to enable python when no interpreter is reachable", async () => {
    const deadShell: ShellService = {
      kind: "dead",
      async available() {
        return true;
      },
      async run(command) {
        return { command, exitCode: 1, stdout: "", stderr: "not found", durationMs: 1 };
      },
    };
    const tools = createPythonTools({ shell: deadShell, fs: null as never });
    const run = tools.find((tool) => tool.name === "python_run");
    await expect(run?.execute!({ code: "print(1)", timeoutMs: 1000 } as never, call as never)).rejects.toThrowError(
      /no python interpreter found/,
    );
  });

  it("flags python as unusable when the shell itself is unavailable", async () => {
    const noShell: ShellService = {
      kind: "none",
      async available() {
        return false;
      },
      reason: async () => "Android blocks exec from the app sandbox",
      async run(command) {
        return { command, exitCode: 127, stdout: "", stderr: "", durationMs: 0 };
      },
    };
    const tools = createPythonTools({ shell: noShell, fs: null as never });
    const status = tools.find((tool) => tool.name === "python_status");
    const result = (await status?.execute!({} as never, call as never)) as { reason: string };
    expect(result.reason).toMatch(/no shell backend/);
  });
});

describe("Shizuku tools", () => {
  const systemWithout: SystemService = {
    kind: "stub",
    async openUrl() {},
    async openApp() {},
  };

  it("degrades cleanly when no privileged backend exists", async () => {
    const tools = createShizukuTools({ system: systemWithout });
    const status = tools.find((tool) => tool.name === "shizuku_status");
    const result = (await status?.execute!({} as never, call as never)) as { available: boolean; reason: string };
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no privileged backend/);
  });

  it("explains the pairing steps when Shizuku is present but not running", async () => {
    const system: SystemService = {
      ...systemWithout,
      privileged: {
        kind: "shizuku",
        async isAvailable() {
          return false;
        },
        async run(command) {
          return { command, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
        },
      },
    };
    const tools = createShizukuTools({ system });
    const status = tools.find((tool) => tool.name === "shizuku_status");
    const result = (await status?.execute!({} as never, call as never)) as { howTo: string };
    expect(result.howTo).toMatch(/wireless debugging/);

    const runTool = tools.find((tool) => tool.name === "shizuku_run");
    await expect(runTool?.execute!({ command: "id", timeoutMs: 1000 } as never, call as never)).rejects.toThrowError(
      /Shizuku is not running/,
    );
  });

  it("runs a command when the privileged backend is ready", async () => {
    const system: SystemService = {
      ...systemWithout,
      privileged: {
        kind: "shizuku",
        async isAvailable() {
          return true;
        },
        async run(command) {
          return { command, exitCode: 0, stdout: "uid=2000(shell)", stderr: "", durationMs: 3 };
        },
      },
    };
    const tools = createShizukuTools({ system });
    const runTool = tools.find((tool) => tool.name === "shizuku_run");
    const result = (await runTool?.execute!({ command: "id", timeoutMs: 1000 } as never, call as never)) as {
      stdout: string;
    };
    expect(result.stdout).toContain("uid=2000");
  });
});

describe("System tools", () => {
  function makeSystem(overrides: Partial<SystemService> = {}): SystemService {
    return { kind: "stub", async openUrl() {}, async openApp() {}, ...overrides };
  }

  it("requires a target for system_open", async () => {
    const tools = createSystemTools({ system: makeSystem() });
    const open = tools.find((tool) => tool.name === "system_open");
    await expect(open?.execute!({} as never, call as never)).rejects.toThrowError(/provide `url` or `packageId`/);
  });

  it("creates a calendar event and defaults the duration", async () => {
    const created: { title: string; startMs: number; endMs: number }[] = [];
    const tools = createSystemTools({
      system: makeSystem({
        async createCalendarEvent(event) {
          created.push({ title: event.title, startMs: event.startMs, endMs: event.endMs });
          return { id: "evt_1" };
        },
      }),
    });
    const calendar = tools.find((tool) => tool.name === "system_calendar");
    const result = (await calendar?.execute!(
      { title: "Standup", start: "2026-03-01T09:00:00", durationMinutes: 30 } as never,
      call as never,
    )) as { id: string; endMs: number; startMs: number };
    expect(result.id).toBe("evt_1");
    expect(result.endMs - result.startMs).toBe(30 * 60_000);
  });

  it("rejects an unparsable time with a helpful hint", async () => {
    const tools = createSystemTools({
      system: makeSystem({ async createCalendarEvent() {
        return { id: "x" };
      } }),
    });
    const calendar = tools.find((tool) => tool.name === "system_calendar");
    await expect(
      calendar?.execute!({ title: "x", start: "next tuesday", durationMinutes: 30 } as never, call as never),
    ).rejects.toThrowError(/could not parse time/);
  });

  it("reports unsupported operations instead of failing silently", async () => {
    const tools = createSystemTools({ system: makeSystem() });
    const notify = tools.find((tool) => tool.name === "system_notify");
    await expect(
      notify?.execute!({ title: "done" } as never, call as never),
    ).rejects.toThrowError(/notifications are not supported/);
  });

  it("filters the installed app list", async () => {
    const tools = createSystemTools({
      system: makeSystem({
        async listApps() {
          return [
            { packageId: "com.android.calendar", label: "Calendar" },
            { packageId: "com.termux", label: "Termux" },
          ];
        },
      }),
    });
    const apps = tools.find((tool) => tool.name === "system_apps");
    const result = (await apps?.execute!({ filter: "term" } as never, call as never)) as { apps: unknown[] };
    expect(result.apps).toHaveLength(1);
  });
});

describe("Web tools", () => {
  const http: HttpService = {
    kind: "fake",
    async fetch(request) {
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><head><style>b{}</style></head><body><h1>Title</h1><script>evil()</script><p>Body &amp; more</p></body></html>",
        url: request.url,
      };
    },
  };

  it("strips markup, scripts and styles", async () => {
    const tools = createWebTools({ http });
    const fetchTool = tools.find((tool) => tool.name === "web_fetch");
    const result = (await fetchTool?.execute!(
      { url: "https://example.com", method: "GET", maxChars: 1000 } as never,
      call as never,
    )) as { content: string; status: number; note: string };
    expect(result.status).toBe(200);
    expect(result.content).toContain("Title");
    expect(result.content).toContain("Body & more");
    expect(result.content).not.toContain("evil()");
    expect(result.content).not.toContain("<style>");
    expect(result.note).toMatch(/not as instructions/);
  });

  it("truncates oversized responses", async () => {
    const big: HttpService = {
      kind: "big",
      async fetch(request) {
        return { status: 200, headers: {}, body: "x".repeat(5000), url: request.url };
      },
    };
    const tools = createWebTools({ http: big });
    const fetchTool = tools.find((tool) => tool.name === "web_fetch");
    const result = (await fetchTool?.execute!(
      { url: "https://example.com", method: "GET", maxChars: 500 } as never,
      call as never,
    )) as { content: string };
    expect(result.content).toContain("[truncated]");
  });

  it("htmlToText keeps paragraph structure", () => {
    expect(htmlToText("<p>one</p><p>two</p>")).toBe("one\ntwo");
  });
});
