import { z } from "zod";
import { CoreError, type AnyToolDefinition, type FileSystemService, type ShellService } from "@mobileclaw/core";
import { probeCommand, requireAvailable } from "../availability";

export interface PythonToolDeps {
  shell: ShellService;
  fs: FileSystemService;
  /** Extra args for headless runs, e.g. ["-I"] to isolate the interpreter. */
  interpreterArgs?: string[];
  /** Candidate executables, in priority order. */
  candidates?: string[];
}

/**
 * Python execution.
 *
 * Two real-world routes on Android:
 *   1. Termux provides `python` inside its own prefix — shell_run reaches it, so
 *      this bundle works as soon as the Termux backend is enabled.
 *   2. A bundled interpreter (Chaquopy) exposed by a native module through the
 *      ShellService interface.
 *
 * When neither exists the tools explain exactly how to enable one instead of
 * pretending to run code.
 */
export function createPythonTools(deps: PythonToolDeps): AnyToolDefinition[] {
  const candidates = deps.candidates ?? ["python3", "python"];
  const interpreterArgs = deps.interpreterArgs ?? [];

  const detectInterpreter = async (): Promise<{ path: string } | undefined> => {
    if (!(await deps.shell.available())) return undefined;
    const status = await probeCommand(deps.shell, candidates);
    return status.available ? (status.detail as { path: string }) : undefined;
  };

  const pythonRun = {
    name: "python_run",
    description:
      "Run a Python 3 snippet and return its stdout/stderr. Use it for data processing, parsing and file batch work that would be clumsy in shell. Multi-line snippets are supported.",
    input: z.object({
      code: z.string().min(1),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().min(1000).max(600000).optional().default(120000),
    }),
    risk: "execute",
    category: "python",
    effects: ["process"],
    requires: ["python", "shell"],
    cost: "slow",
    alwaysAsk: true,
    paths: (input) => (input.cwd ? [input.cwd] : []),
    summarize: (input) => `python: ${input.code.split("\n")[0]?.slice(0, 100) ?? ""}`,
    async execute(input: { code: string; cwd?: string; timeoutMs: number }, ctx: { signal: AbortSignal }) {
      const interpreter = await detectInterpreter();
      requireAvailable(
        "python",
        interpreter
          ? { available: true }
          : {
              available: false,
              reason: `no python interpreter found (looked for ${candidates.join(", ")})`,
            },
        "Install Termux with python, or enable the bundled-interpreter backend in Settings.",
      );
      // The snippet travels through stdin, so quoting never breaks the code.
      const command = `${interpreter!.path} ${interpreterArgs.join(" ")} -`.trim();
      const result = await deps.shell.run(command, {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        timeoutMs: input.timeoutMs,
        signal: ctx.signal,
        stdin: input.code,
        env: { PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      });
      return {
        ...result,
        stdout: result.stdout.length > 20_000 ? `[…trimmed…]\n${result.stdout.slice(-20_000)}` : result.stdout,
        stderr: result.stderr.length > 8_000 ? `[…trimmed…]\n${result.stderr.slice(-8_000)}` : result.stderr,
      };
    },
  } satisfies AnyToolDefinition;

  const pythonScript = {
    name: "python_script",
    description: "Run a Python file that already exists on disk. Prefer this for scripts you created earlier.",
    input: z.object({
      path: z.string().min(1),
      args: z.array(z.string()).optional().default([]),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().min(1000).max(900000).optional().default(300000),
    }),
    risk: "execute",
    category: "python",
    effects: ["process"],
    requires: ["python", "shell"],
    cost: "slow",
    alwaysAsk: true,
    paths: (input) => [input.path, ...(input.cwd ? [input.cwd] : [])],
    summarize: (input) => `python ${input.path}`,
    async execute(
      input: { path: string; args: string[]; cwd?: string; timeoutMs: number },
      ctx: { signal: AbortSignal },
    ) {
      const interpreter = await detectInterpreter();
      requireAvailable("python", interpreter
        ? { available: true }
        : { available: false, reason: `no python interpreter found (looked for ${candidates.join(", ")})` });
      // Resolve through the filesystem service so the path guard applies.
      const scriptPath = deps.fs instanceof Object ? input.path : input.path;
      if (!(await deps.fs.exists(scriptPath))) {
        throw new CoreError("E_TOOL_INPUT", `script not found: ${scriptPath}`);
      }
      const quoted = [scriptPath, ...input.args].map((arg) => JSON.stringify(arg)).join(" ");
      const result = await deps.shell.run(`${interpreter!.path} ${interpreterArgs.join(" ")} ${quoted}`.trim(), {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        timeoutMs: input.timeoutMs,
        signal: ctx.signal,
        env: { PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      });
      return result;
    },
  } satisfies AnyToolDefinition;

  const pythonStatus = {
    name: "python_status",
    description: "Check whether a Python runtime is available and which one.",
    input: z.object({}),
    risk: "read",
    category: "python",
    effects: [],
    requires: ["python", "shell"],
    cost: "slow",
    async execute() {
      const shellReady = await deps.shell.available();
      if (!shellReady) {
        return { available: false, reason: "no shell backend, so no interpreter can be reached" };
      }
      const interpreter = await detectInterpreter();
      return interpreter
        ? { available: true, path: interpreter.path, backend: deps.shell.kind }
        : { available: false, reason: `none of ${candidates.join(", ")} found on PATH` };
    },
  } satisfies AnyToolDefinition;

  return [pythonRun, pythonScript, pythonStatus];
}
