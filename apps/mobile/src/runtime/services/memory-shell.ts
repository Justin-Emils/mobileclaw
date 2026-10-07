import type { ShellResult, ShellRunOptions, ShellService } from "@mobileclaw/core";

/**
 * Shell backends on Android are *optional integrations*, never assumptions.
 *
 * The app ships this memory backend so `shell_*` tools answer meaningfully before
 * the user wires anything up, and so the UI can demo the flow. The real backends
 * implement the same interface:
 *
 *   - `TermuxShellService`   → RUN_COMMAND intent into Termux (needs the user to
 *     enable `allow-external-apps` and grant com.termux.permission.RUN_COMMAND).
 *   - `ShizukuShellService`  → a Shizuku UserService executing commands as uid 2000.
 *
 * Both are native-side and arrive with the Kotlin module; see
 * docs/android-capabilities.md.
 */
export class MemoryShellService implements ShellService {
  readonly kind = "memory";

  constructor(
    private readonly options: {
      available?: boolean;
      reason?: string;
      /** Optional canned response table keyed by a substring of the command. */
      responses?: { match: string; result: Partial<ShellResult> }[];
    } = {},
  ) {}

  async available(): Promise<boolean> {
    return this.options.available ?? false;
  }

  async reason(): Promise<string> {
    return (
      this.options.reason ??
      "no shell backend is enabled: turn on Termux integration or pair Shizuku in Settings"
    );
  }

  async run(command: string, options: ShellRunOptions = {}): Promise<ShellResult> {
    const started = Date.now();
    if (!(await this.available())) {
      return {
        command,
        exitCode: 127,
        stdout: "",
        stderr: await this.reason(),
        durationMs: Date.now() - started,
        blocked: true,
      };
    }
    const canned = this.options.responses?.find((entry) => command.includes(entry.match));
    return {
      command,
      exitCode: canned?.result.exitCode ?? 0,
      stdout: canned?.result.stdout ?? "",
      stderr: canned?.result.stderr ?? "",
      durationMs: Date.now() - started,
      ...(options.signal?.aborted ? { exitCode: 130 } : {}),
    };
  }
}

/**
 * A shell backend that records the commands it was asked to run and returns
 * scripted output. Used by tests and by the "dry run" mode in Settings, where a
 * user can watch what the agent would execute before enabling a real backend.
 */
export class RecordingShellService implements ShellService {
  readonly kind = "recording";
  readonly commands: { command: string; options: ShellRunOptions }[] = [];

  constructor(
    private readonly options: {
      available?: boolean;
      respond?: (command: string) => Partial<ShellResult> | undefined;
      reason?: string;
    } = {},
  ) {}

  async available(): Promise<boolean> {
    return this.options.available ?? true;
  }

  async reason(): Promise<string> {
    return this.options.reason ?? "recording backend: commands are not executed";
  }

  async run(command: string, options: ShellRunOptions = {}): Promise<ShellResult> {
    this.commands.push({ command, options });
    const started = Date.now();
    const scripted = this.options.respond?.(command) ?? {};
    return {
      command,
      exitCode: scripted.exitCode ?? 0,
      stdout: scripted.stdout ?? "",
      stderr: scripted.stderr ?? "",
      durationMs: Date.now() - started,
    };
  }
}
