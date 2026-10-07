/**
 * Structured errors used across the kernel.
 *
 * Every failure that can reach the model is shaped here, because the agent loop
 * feeds tool errors back to the LLM as tool results. A machine-readable `code`
 * lets the model (and the UI) react without string matching.
 */
export type CoreErrorCode =
  | "E_PLUGIN"
  | "E_SERVICE_MISSING"
  | "E_TOOL_NOT_FOUND"
  | "E_TOOL_INPUT"
  | "E_TOOL_FAILED"
  | "E_PERMISSION_DENIED"
  | "E_PATH_ESCAPE"
  | "E_PROVIDER"
  | "E_CANCELLED"
  | "E_STEP_LIMIT";

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly details?: unknown;

  constructor(code: CoreErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: CoreErrorCode; message: string; details?: unknown } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  /** Render for the LLM: short and actionable. */
  toToolResult(): string {
    const suffix =
      this.details === undefined ? "" : `\n${safeStringify(this.details)}`;
    return `[${this.code}] ${this.message}${suffix}`;
  }
}

export function isCoreError(value: unknown): value is CoreError {
  return value instanceof CoreError;
}

export function toCoreError(value: unknown, code: CoreErrorCode = "E_TOOL_FAILED"): CoreError {
  if (isCoreError(value)) return value;
  if (value instanceof Error) return new CoreError(code, value.message);
  return new CoreError(code, String(value));
}

/** JSON.stringify that never throws (cycles, BigInt, functions). */
export function safeStringify(value: unknown, space = 0): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, val: unknown) => {
        if (typeof val === "bigint") return val.toString();
        if (typeof val === "function") return `[Function ${val.name || "anonymous"}]`;
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      },
      space,
    );
  } catch {
    return String(value);
  }
}
