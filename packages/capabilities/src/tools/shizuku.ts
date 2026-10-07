import { z } from "zod";
import { CoreError, type AnyToolDefinition, type SystemService } from "@mobileclaw/core";
import { requireAvailable } from "../availability";

/**
 * Shizuku / ADB-backed privileged operations.
 *
 * Shizuku lets an app call system APIs with the identity of shell (uid 2000) or
 * run commands through `sh` without root. It is the only realistic way to, say,
 * change a system setting or grant a permission from inside the app.
 *
 * The plumbing lives in the native module behind `SystemService.privileged`; the
 * tools here define the contract and degrade cleanly when the user has not paired
 * Shizuku (or started it after a reboot, which stops the service).
 */
export function createShizukuTools(deps: { system: SystemService }): AnyToolDefinition[] {
  const getPrivileged = () => deps.system.privileged;

  const shizukuStatus = {
    name: "shizuku_status",
    description:
      "Report whether privileged (Shizuku/ADB) execution is available. Check this before promising system-level changes.",
    input: z.object({}),
    risk: "read",
    async execute() {
      const privileged = getPrivileged();
      if (!privileged) {
        return {
          available: false,
          reason: "this platform has no privileged backend",
          howTo: "Shizuku is Android-only.",
        };
      }
      const ready = await privileged.isAvailable();
      return {
        available: ready,
        backend: privileged.kind,
        howTo: ready
          ? undefined
          : "Start the Shizuku app, enable wireless debugging, then grant MobileClaw the Shizuku permission.",
      };
    },
  } satisfies AnyToolDefinition;

  const shizukuRequest = {
    name: "shizuku_request",
    description: "Ask the user to grant Shizuku permission to this app (opens the Shizuku consent dialog).",
    input: z.object({}),
    risk: "system",
    alwaysAsk: true,
    async execute() {
      const privileged = getPrivileged();
      if (!privileged?.requestPermission) {
        throw new CoreError("E_TOOL_FAILED", "Shizuku is not integrated on this platform");
      }
      const granted = await privileged.requestPermission();
      return { granted };
    },
  } satisfies AnyToolDefinition;

  const shizukuRun = {
    name: "shizuku_run",
    description:
      "Run a command with elevated privileges via Shizuku (shell identity, no root). Use for system settings, package queries and files the normal app sandbox cannot reach. Irreversible commands need the user's explicit confirmation.",
    input: z.object({
      command: z.string().min(1),
      timeoutMs: z.number().int().min(1000).max(300000).optional().default(60000),
    }),
    risk: "system",
    alwaysAsk: true,
    summarize: (input) => `shizuku: ${input.command.slice(0, 120)}`,
    async execute(input: { command: string; timeoutMs: number }, ctx: { signal: AbortSignal }) {
      const privileged = getPrivileged();
      if (!privileged) throw new CoreError("E_TOOL_FAILED", "Shizuku is not integrated on this platform");
      const ready = await privileged.isAvailable();
      requireAvailable(
        "privileged execution",
        ready
          ? { available: true }
          : { available: false, reason: "Shizuku is not running or the permission was not granted" },
        "Call shizuku_status for setup steps, or shizuku_request to open the consent dialog.",
      );
      const result = await privileged.run(input.command, {
        timeoutMs: input.timeoutMs,
        signal: ctx.signal,
      });
      return result;
    },
  } satisfies AnyToolDefinition;

  return [shizukuStatus, shizukuRequest, shizukuRun];
}
