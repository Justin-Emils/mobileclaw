import { CoreError } from "@mobileclaw/core";

/**
 * Capability probing. Every optional backend (shell, Shizuku, Python) is asked
 * "can you actually run here?" at call time, so a phone without Termux gets a
 * clear explanation instead of a mysterious crash — and the model can decide to
 * fall back to another tool.
 */
export interface Availability {
  available: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}

export function unavailable(reason: string, detail?: Record<string, unknown>): Availability {
  return detail ? { available: false, reason, detail } : { available: false, reason };
}

export function available(detail?: Record<string, unknown>): Availability {
  return detail ? { available: true, detail } : { available: true };
}

/** Turn an Availability into a structured tool error when it is not usable. */
export function requireAvailable(kind: string, status: Availability, hint?: string): void {
  if (status.available) return;
  throw new CoreError("E_TOOL_FAILED", `${kind} is unavailable: ${status.reason ?? "unknown reason"}`, {
    ...(status.detail ?? {}),
    ...(hint ? { hint } : {}),
  });
}

/** Probe for an executable using the shell service, without throwing. */
export async function probeCommand(
  shell: { run: (command: string, options?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string }> },
  candidates: string[],
  timeoutMs = 5000,
): Promise<Availability> {
  for (const candidate of candidates) {
    try {
      const result = await shell.run(`command -v ${candidate} || which ${candidate}`, { timeoutMs });
      if (result.exitCode === 0 && result.stdout.trim() !== "") {
        return available({ path: result.stdout.trim().split("\n")[0], candidate });
      }
    } catch {
      // Try the next candidate.
    }
  }
  return unavailable(`none of these executables were found: ${candidates.join(", ")}`);
}
