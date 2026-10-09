import { z } from "zod";
import { CoreError, type AnyToolDefinition, type ShellService } from "@mobileclaw/core";
import type { FsToolDeps } from "./filesystem";
import { dirName } from "../guarded-fs";

/**
 * A tool needs both the service layer (for execution) and the path guard. Rather
 * than hiding those in module state, every bundle is built by a factory so the
 * kernel, the tests and the app each wire their own instance.
 */
export interface BundleDeps extends FsToolDeps {
  shell: ShellService;
}

/** Like `ctx.services`, but explicit: deps are captured per bundle. */
export function createShellTools(deps: Pick<BundleDeps, "shell">): AnyToolDefinition[] {
  const shellRun = {
    name: "shell_run",
    description:
      "Run a shell command on this device and return stdout/stderr/exit code. On Android this only works when a shell backend (Termux or Shizuku) is configured; the result says so when it is not.",
    input: z.object({
      command: z.string().min(1).describe("Command line to execute."),
      cwd: z.string().optional().describe("Working directory."),
      timeoutMs: z.number().int().min(1000).max(600000).optional().default(60000),
    }),
    risk: "execute",
    category: "shell",
    effects: ["process"],
    requires: ["shell"],
    cost: "slow",
    alwaysAsk: true,
    paths: (input) => (input.cwd ? [input.cwd] : []),
    summarize: (input) => input.command.slice(0, 120),
    async execute(input: { command: string; cwd?: string; timeoutMs: number }, ctx: { signal: AbortSignal }) {
      if (!(await deps.shell.available())) {
        const reason = (await deps.shell.reason?.()) ?? "no shell backend is available on this device";
        throw new CoreError("E_TOOL_FAILED", `shell is unavailable: ${reason}`, {
          hint: "Enable a shell backend in Settings (Termux or Shizuku), or use the filesystem tools instead.",
        });
      }
      const result = await deps.shell.run(input.command, {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        timeoutMs: input.timeoutMs,
        signal: ctx.signal,
      });
      return {
        ...result,
        // Keep the transcript readable and the model focused on the tail of long output.
        stdout: tail(result.stdout, 20_000),
        stderr: tail(result.stderr, 8_000),
      };
    },
  } satisfies AnyToolDefinition;

  const shellWhich = {
    name: "shell_which",
    description: "Report which shell backends are available on this device and why the others are not.",
    input: z.object({}),
    risk: "read",
    category: "shell",
    effects: [],
    requires: ["shell"],
    async execute() {
      const available = await deps.shell.available();
      return {
        backend: deps.shell.kind,
        available,
        ...(available ? {} : { reason: (await deps.shell.reason?.()) ?? "unavailable" }),
      };
    },
  } satisfies AnyToolDefinition;

  return [shellRun, shellWhich];
}

export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[…${text.length - max} chars trimmed…]\n${text.slice(-max)}`;
}

export { dirName };
