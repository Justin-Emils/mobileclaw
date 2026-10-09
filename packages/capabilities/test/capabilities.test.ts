import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAutomationTools,
  createPythonTools,
  createShizukuTools,
  createSystemTools,
  createWebTools,
  htmlToText,
} from "@mobileclaw/capabilities";
import { NodeShellService, runFile } from "@mobileclaw/capabilities/node";
import type { AutomationService, ShellService, SystemService, HttpService } from "@mobileclaw/core";

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

describe("Automation tools", () => {
  const systemWithout: SystemService = {
    kind: "stub",
    async openUrl() {},
    async openApp() {},
  };

  /** A working screen backend, with any single method replaceable. */
  const screen = (over: Partial<AutomationService> = {}): SystemService => ({
    ...systemWithout,
    automation: {
      kind: "shizuku",
      async status() {
        return { available: true, backend: "shizuku", uid: 2000 };
      },
      async captureScreen() {
        return { path: "file:///w/shot.jpg", width: 720, height: 1600 };
      },
      async tap() {},
      async scroll() {},
      async typeText() {
        return { method: "input" as const };
      },
      async currentWindow() {
        return { package: "com.tencent.mm", activity: ".ui.LauncherUI", raw: "mCurrentFocus=…" };
      },
      // Required by the AutomationService port so that "can act" and "can be read"
      // stay one capability. The reading tools have their own suite.
      async readScreen() {
        return { nodes: [], total: 0 };
      },
      ...over,
    },
  });

  const toolNamed = (system: SystemService, name: string) => {
    const tool = createAutomationTools({ system }).find((entry) => entry.name === name);
    if (!tool) throw new Error(`no automation tool named ${name}`);
    return tool;
  };

  it("says the platform has no screen backend instead of failing vaguely", async () => {
    // `screen_current` is a probe: with nothing to probe it reports, it does not throw.
    const result = (await toolNamed(systemWithout, "screen_current").execute({} as never, call as never)) as {
      available: boolean;
      reason: string;
      howTo: string;
    };
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no screen backend/);
    expect(result.howTo).toMatch(/privileged backend/);
  });

  it("reports why the backend cannot act instead of throwing from the probe", async () => {
    const system = screen({
      async status() {
        return { available: false, reason: "Shizuku is not running", howTo: "Open Shizuku and start the service." };
      },
    });
    const result = (await toolNamed(system, "screen_current").execute({} as never, call as never)) as {
      available: boolean;
      reason: string;
      howTo: string;
      backend: string;
    };
    expect(result.available).toBe(false);
    expect(result.reason).toBe("Shizuku is not running");
    expect(result.howTo).toBe("Open Shizuku and start the service.");
  });

  it("throws for every action tool when there is no backend, carrying the hint", async () => {
    // Only `screen_current` returns; everything that would act on the screen throws so
    // the model is told the capability is missing and where to get it. `screen_wait`
    // shares the same `requireScreen` guard, so it must throw too, not park forever.
    const actions: Array<[string, Record<string, unknown>]> = [
      ["screen_capture", {}],
      ["screen_tap", { target: "search box", x: 0.5, y: 0.05 }],
      ["screen_scroll", { direction: "down" }],
      ["screen_type", { text: "hello" }],
      ["screen_wait", { package: "com.tencent.mm", timeoutMs: 100 }],
    ];
    for (const [name, input] of actions) {
      await expect(toolNamed(systemWithout, name).execute(input as never, call as never)).rejects.toMatchObject({
        code: "E_TOOL_FAILED",
        details: { hint: expect.stringMatching(/privileged backend/) },
      });
    }
  });

  it("passes the backend's own guidance through when it cannot act", async () => {
    const howTo = "Open Shizuku and start the service.";
    const system = screen({
      async status() {
        return { available: false, reason: "Shizuku is not running", howTo };
      },
    });
    await expect(
      toolNamed(system, "screen_tap").execute({ target: "search box", x: 0.5, y: 0.05 } as never, call as never),
    ).rejects.toMatchObject({
      code: "E_TOOL_FAILED",
      details: { hint: howTo },
    });
  });

  it("marks every screen-changing tool so one approval cannot cover the next", () => {
    // Structural, not a name list: a future screen-changing tool that forgets the
    // flag fails here, at the exact-name comparison and at the flag assertions, rather
    // than quietly becoming rememberable in production.
    const changing = createAutomationTools({ system: screen() }).filter((tool) => tool.risk === "system");
    expect(changing.map((tool) => tool.name).sort()).toEqual([
      "screen_capture",
      "screen_scroll",
      "screen_tap",
      "screen_type",
    ]);
    for (const tool of changing) {
      // `alwaysAsk` is the blanket promise: no allow rule can pre-grant any of these.
      expect(tool.alwaysAsk, tool.name).toBe(true);
    }

    // `neverRemember` is the *stronger* promise, and it belongs only to the tools that write
    // or capture. `screen_scroll` moves content and declares `mutates: false`, so a read-only
    // task scope may relax it — while typing must never be relaxable by any scope.
    const neverRememberable = changing.filter((tool) => tool.neverRemember === true).map((tool) => tool.name);
    expect(neverRememberable.sort()).toEqual(["screen_capture", "screen_tap", "screen_type"]);
    expect(changing.find((tool) => tool.name === "screen_scroll")?.mutates).toBe(false);
    expect(changing.find((tool) => tool.name === "screen_type")?.mutates).not.toBe(false);
  });

  it("refuses to tap when nobody chose a point", async () => {
    // The model cannot see the screen, so a tap without a user-chosen point is a
    // guess — and a guess at a coordinate is exactly what must never happen.
    await expect(
      toolNamed(screen(), "screen_tap").execute({ target: "search box" } as never, call as never),
    ).rejects.toThrowError(/no point was chosen/);
  });

  it("taps the chosen point and returns a screenshot as evidence", async () => {
    const taps: [number, number][] = [];
    const system = screen({
      async tap(x, y) {
        taps.push([x, y]);
      },
    });
    const result = (await toolNamed(system, "screen_tap").execute(
      { target: "search box", x: 0.5, y: 0.05 } as never,
      call as never,
    )) as { x: number; evidence: { path: string; width: number } };

    // The point reaches the service unchanged: the tool passes the fraction through and
    // the adapter is what resolves it against the display.
    expect(taps).toEqual([[0.5, 0.05]]);
    expect(result.evidence.path).toBe("file:///w/shot.jpg");
    expect(result.evidence.width).toBe(720);
  });

  it("keeps a successful tap successful when the evidence shot fails", async () => {
    // The press already happened. Turning that into a tool error would report a
    // failed action that did in fact happen, which is worse than thin evidence.
    const system = screen({
      async captureScreen() {
        throw new Error("FLAG_SECURE");
      },
    });
    const result = (await toolNamed(system, "screen_tap").execute(
      { target: "OK", x: 0.5, y: 0.9 } as never,
      call as never,
    )) as { evidenceNote: string };

    expect(result.evidenceNote).toMatch(/evidence capture failed/);
    expect(result.evidenceNote).toMatch(/FLAG_SECURE/);
  });

  it("carries a blocked frame's note into an action's evidence", async () => {
    // A blocked frame is not a blank screen: the note has to survive into the evidence
    // the user is shown, or a protected window would be reported as empty.
    const note = "the frame may be protected content and is shown black";
    const system = screen({
      async captureScreen() {
        return { path: "file:///w/black.jpg", width: 720, height: 1600, note };
      },
    });
    const result = (await toolNamed(system, "screen_tap").execute(
      { target: "OK", x: 0.2, y: 0.8 } as never,
      call as never,
    )) as { evidence: { note?: string } };

    expect(result.evidence.note).toBe(note);
  });

  it("passes a blocked-frame note through instead of reporting a blank screen", async () => {
    const note = "the frame may be protected content and is shown black";
    const system = screen({
      async captureScreen() {
        return { path: "file:///w/black.jpg", width: 720, height: 1600, note };
      },
    });
    const result = (await toolNamed(system, "screen_capture").execute(
      { maxWidth: 720, quality: 70 } as never,
      call as never,
    )) as { note: string; evidence: { note?: string } };
    expect(result.note).toBe(note);
    expect(result.evidence.note).toBe(note);
  });

  it("exposes the capture as its own evidence so the transcript can render it", async () => {
    // The transcript only picks up an explicit `evidence` key. A capture with no such
    // key would never reach the card whose whole purpose is to show the picture.
    const shot = { path: "file:///w/shot.jpg", width: 720, height: 1600 };
    const system = screen({
      async captureScreen() {
        return { ...shot };
      },
    });
    const result = (await toolNamed(system, "screen_capture").execute({} as never, call as never)) as {
      path: string;
      width: number;
      height: number;
      evidence: { path: string; width: number; height: number };
    };

    expect(result.evidence.path).toBe(shot.path);
    expect(result.evidence.width).toBe(shot.width);
    expect(result.evidence.height).toBe(shot.height);
  });

  it("saves the capture into the conversation workspace when there is one", async () => {
    let seen: string | undefined;
    const system = screen({
      async captureScreen(options) {
        seen = options?.destDir;
        return { path: "file:///w/shot.jpg", width: 720, height: 1600 };
      },
    });
    await toolNamed(system, "screen_capture").execute(
      { maxWidth: 720, quality: 70 } as never,
      { ...call, workspace: "/data/ws/conv_1" } as never,
    );
    expect(seen).toBe("/data/ws/conv_1");
  });

  describe("defaults are decided in one place", () => {
    it("leaves the capture size and quality to the backend instead of defaulting them", async () => {
      // Regression: the tool used to fill in maxWidth/quality itself, duplicating
      // SCREEN_DEFAULTS. It now forwards only what the caller supplied, so the
      // fallback lives in the service (and in SCREEN_DEFAULTS) and nowhere else.
      const calls: Array<Record<string, unknown>> = [];
      const system = screen({
        async captureScreen(options) {
          calls.push((options ?? {}) as Record<string, unknown>);
          return { path: "file:///w/shot.jpg", width: 720, height: 1600 };
        },
      });
      const tool = toolNamed(system, "screen_capture");
      await tool.execute({} as never, call as never);
      await tool.execute({ maxWidth: 1024 } as never, call as never);

      expect(Object.keys(calls[0]!)).toEqual([]);
      expect(calls[1]).toEqual({ maxWidth: 1024 });
    });

    it("lets the backend decide how far a scroll travels", async () => {
      const seen: Array<[string, number | undefined]> = [];
      const system = screen({
        async scroll(direction, fraction) {
          seen.push([direction, fraction]);
        },
      });
      const tool = toolNamed(system, "screen_scroll");
      await tool.execute({ direction: "down" } as never, call as never);
      await tool.execute({ direction: "up", amount: 0.3 } as never, call as never);

      expect(seen).toEqual([
        ["down", undefined],
        ["up", 0.3],
      ]);
    });
  });

  it("scrolls by direction without asking the model for coordinates", async () => {
    const seen: [string, number | undefined][] = [];
    const system = screen({
      async scroll(direction, fraction) {
        seen.push([direction, fraction]);
      },
    });
    const result = (await toolNamed(system, "screen_scroll").execute(
      { direction: "down", amount: 0.6 } as never,
      call as never,
    )) as { direction: string; evidence?: unknown };

    expect(seen).toEqual([["down", 0.6]]);
    expect(result.direction).toBe("down");
    expect(result.evidence).toBeDefined();
  });

  it("reports the clipboard fallback, because a paste replaces what the user copied", async () => {
    const system = screen({
      async typeText() {
        return { method: "paste" as const };
      },
    });
    const result = (await toolNamed(system, "screen_type").execute(
      { text: "hello" } as never,
      call as never,
    )) as { method: string; length: number };

    expect(result.method).toBe("paste");
    expect(result.length).toBe(5);
  });

  it("summarises each action, and never echoes the typed text", () => {
    // Whatever is typed already lands on the transcript entry; the summary is a second
    // copy in the UI, so a password typed into a field must not appear here.
    const tools = createAutomationTools({ system: screen() });
    const summary = (name: string, input: unknown) =>
      tools.find((tool) => tool.name === name)?.summarize?.(input as never);

    expect(summary("screen_capture", {})).toBe("screen capture");
    expect(summary("screen_scroll", { direction: "down" })).toBe("scroll down");
    expect(summary("screen_tap", { target: "search box" })).toBe("tap search box");
    expect(summary("screen_type", { text: "hunter2" })).toBe("type 7 characters");
  });

  /**
   * Write-then-verify.
   *
   * The failure this closes: `screen_type` returned `{ok}` from the keystroke alone, so the
   * model's only evidence that the text landed was its own intention. A read-only field, a
   * rejected paste and a field that lost focus all looked exactly like success — and the
   * project's rule is that a statement about what happened must come from a fact, not from
   * having called a function.
   */
  it("confirms the typed text really landed when asked to", async () => {
    const system = screen({
      async readScreen() {
        return {
          nodes: [{ index: 0, text: "search: hello world", className: "EditText", clickable: true }],
          total: 1,
        };
      },
    });
    const result = (await toolNamed(system, "screen_type").execute(
      { text: "hello world", expect: "hello world" } as never,
      call as never,
    )) as { verified?: boolean; verifyNote?: string; method: string };

    expect(result.verified).toBe(true);
    expect(result.verifyNote).toMatch(/is on screen/);
    // The plain report is still there: verification adds to the result, it does not replace it.
    expect(result.method).toBe("input");
  });

  it("reports that the text did NOT land, rather than reporting success", async () => {
    // A field that silently refused the input. This is the case the tool exists for.
    const system = screen({
      async readScreen() {
        return { nodes: [{ index: 0, text: "read-only field", className: "TextView" }], total: 1 };
      },
    });
    const result = (await toolNamed(system, "screen_type").execute(
      { text: "hello world", expect: "hello world" } as never,
      call as never,
    )) as { verified?: boolean; verifyNote?: string };

    expect(result.verified).toBe(false);
    expect(result.verifyNote).toMatch(/was NOT found/);
    // The instruction has to be unmistakable, because the tempting failure is to describe the
    // keystroke as if it had worked.
    expect(result.verifyNote).toMatch(/do not report this as done/);
  });

  it("passes the backend's own note through when the screen could not be read back", async () => {
    const blocked = "the window is FLAG_SECURE, so nothing readable was published";
    const system = screen({
      async readScreen() {
        return { nodes: [], total: 0, note: blocked };
      },
    });
    const result = (await toolNamed(system, "screen_type").execute(
      { text: "hello", expect: "hello" } as never,
      call as never,
    )) as { verified?: boolean; verifyNote?: string };

    expect(result.verified).toBe(false);
    expect(result.verifyNote).toBe(blocked);
  });

  it("says the check could not be made when reading back throws", async () => {
    const system = screen({
      async readScreen() {
        throw new Error("uiautomator timed out");
      },
    });
    const result = (await toolNamed(system, "screen_type").execute(
      { text: "hello", expect: "hello" } as never,
      call as never,
    )) as { verified?: boolean; verifyNote?: string };

    expect(result.verified).toBe(false);
    expect(result.verifyNote).toMatch(/could not read the screen back/);
    expect(result.verifyNote).toMatch(/timed out/);
  });

  it("does not read the screen back when nothing was asked to be verified", async () => {
    // Verification costs a second reading. Making it opt-in keeps the common case one step and
    // one round trip; making it automatic would tax every keystroke for a check most of them
    // do not need.
    let reads = 0;
    const system = screen({
      async readScreen() {
        reads += 1;
        return { nodes: [], total: 0 };
      },
    });

    const result = (await toolNamed(system, "screen_type").execute(
      { text: "hello" } as never,
      call as never,
    )) as { verified?: boolean };

    expect(reads).toBe(0);
    expect(result.verified).toBeUndefined();
  });

  it("reports the foreground app", async () => {
    const result = (await toolNamed(screen(), "screen_current").execute({} as never, call as never)) as {
      available: boolean;
      package: string;
      uid: number;
    };
    expect(result.available).toBe(true);
    expect(result.package).toBe("com.tencent.mm");
    expect(result.uid).toBe(2000);
  });

  it("waits for the foreground app, and reports a timeout rather than guessing", async () => {
    let calls = 0;
    const arriving = screen({
      async currentWindow() {
        calls += 1;
        return calls >= 2
          ? { package: "com.tencent.mm", activity: ".ui.LauncherUI", raw: "matched" }
          : { package: "com.android.launcher", activity: "", raw: "not yet" };
      },
    });
    const matched = (await toolNamed(arriving, "screen_wait").execute(
      { package: "com.tencent.mm", timeoutMs: 5000 } as never,
      call as never,
    )) as { matched: boolean };
    expect(matched.matched).toBe(true);
    expect(calls).toBe(2);

    const never = screen({
      async currentWindow() {
        return { raw: "" };
      },
    });
    const missed = (await toolNamed(never, "screen_wait").execute(
      { package: "com.tencent.mm", timeoutMs: 150 } as never,
      call as never,
    )) as { matched: boolean; reason: string };
    expect(missed.matched).toBe(false);
    expect(missed.reason).toMatch(/timed out/);
  });

  it("matches a substring of the activity name as well as the package", async () => {
    const result = (await toolNamed(screen(), "screen_wait").execute(
      { package: "com.tencent.mm", activity: "Launcher", timeoutMs: 5000 } as never,
      call as never,
    )) as { matched: boolean };
    expect(result.matched).toBe(true);
  });

  it("stops waiting when the run is cancelled", async () => {
    const controller = new AbortController();
    const never = screen({
      async currentWindow() {
        return { raw: "" };
      },
    });
    const pending = toolNamed(never, "screen_wait").execute(
      { package: "nope", timeoutMs: 30000 } as never,
      { ...call, signal: controller.signal } as never,
    );
    controller.abort();
    await expect(pending).rejects.toThrowError(/cancelled/);
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
