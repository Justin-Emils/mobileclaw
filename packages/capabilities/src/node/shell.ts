import { spawn } from "node:child_process";
import { CoreError } from "@mobileclaw/core";
import type { ShellResult, ShellRunOptions, ShellService } from "@mobileclaw/core";

export interface CommandPolicy {
  /** Commands that may never run, regardless of approval. */
  denyPatterns?: RegExp[];
  /** Command names that are auto-permitted when bash-less execution is used. */
  allowCommands?: string[];
  /** Reject commands containing shell metacharacters. */
  forbidShellSyntax?: boolean;
}

export interface NodeShellOptions {
  /** Default working directory. */
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  policy?: CommandPolicy;
  /** Shell binary used for `run`. Defaults to sh on POSIX, cmd on Windows. */
  shellBin?: string;
  platform?: string;
}

const DEFAULT_DENY: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/, // rm -rf /
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+.*of=\/dev\//,
  /:\(\)\s*\{/, // fork bomb
  /\b(shutdown|reboot|halt|poweroff)\b/,
  />\s*\/dev\/sd[a-z]/,
];

const METACHARACTERS = /[;&|`$><(){}[\]*?!~\\]/;

/**
 * Executes shell commands on Node hosts.
 *
 * On Android this class is *not* used: the platform forbids exec from the app
 * data directory, so the phone backend is either the Termux RUN_COMMAND intent
 * or a bundled helper run through Shizuku. Both implement `ShellService`, so the
 * tools above them stay unchanged.
 */
export class NodeShellService implements ShellService {
  readonly kind = "node-shell";
  private readonly platform: string;
  private readonly maxOutputBytes: number;
  private readonly denyPatterns: RegExp[];

  constructor(private readonly options: NodeShellOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    this.denyPatterns = [...DEFAULT_DENY, ...(options.policy?.denyPatterns ?? [])];
  }

  async available(): Promise<boolean> {
    return true;
  }

  async run(command: string, options: ShellRunOptions = {}): Promise<ShellResult> {
    const trimmed = command.trim();
    const started = Date.now();
    if (trimmed === "") {
      throw new CoreError("E_TOOL_INPUT", "command must not be empty");
    }

    for (const pattern of this.denyPatterns) {
      if (pattern.test(trimmed)) {
        return {
          command: trimmed,
          exitCode: 126,
          stdout: "",
          stderr: `refused by command policy (matched ${pattern})`,
          durationMs: Date.now() - started,
          blocked: true,
        };
      }
    }
    if (this.options.policy?.forbidShellSyntax && METACHARACTERS.test(trimmed)) {
      return {
        command: trimmed,
        exitCode: 126,
        stdout: "",
        stderr: "shell metacharacters are not allowed by the current policy",
        durationMs: Date.now() - started,
        blocked: true,
      };
    }

    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    const cwd = options.cwd ?? this.options.cwd;
    try {
      const result = await this.spawnCapture(trimmed, {
        ...(cwd ? { cwd } : {}),
        timeoutMs,
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      });
      return { command: trimmed, durationMs: Date.now() - started, ...result };
    } catch (error) {
      throw new CoreError(
        "E_TOOL_FAILED",
        error instanceof Error ? error.message : String(error),
        { command: trimmed },
      );
    }
  }

  /**
   * Use a real shell so pipes/redirects work, but cap output and kill the tree
   * on timeout so a runaway command cannot wedge the agent.
   *
   * Known caveat: on Windows a `cmd /c` command line is re-parsed by cmd, so
   * nested quotes are unreliable (`node -e "…"` loses its quotes). Pass snippets
   * through `stdin` or use {@link runFile} instead of quoting them.
   */
  private spawnCapture(
    command: string,
    options: {
      cwd?: string;
      timeoutMs: number;
      env?: Record<string, string>;
      signal?: AbortSignal;
      stdin?: string;
      maxOutputBytes?: number;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const isWindows = this.platform === "win32";
      const bin = this.options.shellBin ?? (isWindows ? "cmd.exe" : "/bin/sh");
      const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];
      const child = spawn(bin, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
      });

      const limit = options.maxOutputBytes ?? this.maxOutputBytes;
      let stdout = "";
      let stderr = "";
      let killed = false;
      const append = (target: "out" | "err", chunk: string): void => {
        if (target === "out") {
          stdout = cap(stdout + chunk, limit);
        } else {
          stderr = cap(stderr + chunk, limit);
        }
      };

      const timer = setTimeout(() => {
        killed = true;
        killTree(child, this.platform);
      }, options.timeoutMs);

      const onAbort = (): void => {
        killed = true;
        killTree(child, this.platform);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      if (options.stdin !== undefined) {
        child.stdin?.on("error", () => {
          // The command may exit before reading stdin; that is not an error.
        });
        child.stdin?.end(options.stdin);
      }

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => append("out", chunk));
      child.stderr?.on("data", (chunk: string) => append("err", chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (killed) stderr += `\n[killed after ${options.timeoutMs}ms or by cancellation]`;
        // A killed process reports whatever exit code its shell produced, which
        // is meaningless; surface the conventional timeout code instead.
        resolvePromise({ exitCode: killed ? 124 : (code ?? 0), stdout, stderr });
      });
    });
  }
}

/**
 * Non-shell execution: each argument is passed verbatim, so quoting and
 * metacharacters are irrelevant. This is the safest backend for script runners
 * (`python script.py --flag "value with spaces"`) and the recommended fallback
 * wherever `run` would need nested quotes.
 */
export function runFile(
  file: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number; stdin?: string; env?: Record<string, string> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    if (options.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.stdin);
    }
    const timer = setTimeout(() => {
      killed = true;
      killTree(child, process.platform);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new CoreError("E_TOOL_FAILED", `executable not found: ${file}`));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) stderr += `\n[killed after ${timeoutMs}ms]`;
      resolvePromise({
        exitCode: killed ? 124 : (code ?? 0),
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[output truncated]`;
}

/**
 * Kill a command and everything it spawned.
 *
 * On Windows `child.kill()` only terminates the shell, so a grandchild process
 * keeps the stdio pipe open and the `close` event never fires — a "timed out"
 * command would hang the agent until the child exited on its own. `taskkill /T`
 * walks the tree instead.
 */
export function killTree(child: { pid?: number | undefined; kill: (signal?: NodeJS.Signals) => boolean }, platform: string): void {
  if (platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {
        child.kill("SIGKILL");
      });
      return;
    } catch {
      // Fall through to the direct kill.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may already be gone.
  }
}
