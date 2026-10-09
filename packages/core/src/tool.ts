import { z } from "zod";

/**
 * Risk vocabulary. The permission gate maps (risk, tool) pairs onto allow/ask/deny,
 * so a plugin author declares intent once instead of implementing prompts.
 */
export const RISK_LEVELS = ["read", "write", "execute", "network", "system"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const riskLevelSchema = z.enum(RISK_LEVELS);

export interface ToolDefinition<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Snake_case identifier exposed to the model, e.g. `fs_read`. */
  name: string;
  /** One-line description; the model sees exactly this. */
  description: string;
  input: Input;
  output?: Output;
  risk: RiskLevel;
  /**
   * Paths this call touches, extracted from the validated input. The permission
   * gate runs these through the path guard before approval.
   */
  paths?: (input: z.infer<Input>) => string[];
  /** Force a prompt even when the risk level is auto-allowed. */
  alwaysAsk?: boolean;
  /**
   * Force a prompt for *every* call, immune to the allowlist and to allow rules.
   *
   * `alwaysAsk` still yields to "always allow this tool" — that is what the button
   * means. This flag is the stricter promise: an action with it set can never be
   * granted in advance, so a user who has approved it once is still asked the next
   * time. Deny rules and deny modes still win.
   */
  neverRemember?: boolean;
  /** Hard timeout. Tool executions that hang would otherwise stall the agent loop. */
  timeoutMs?: number;
  /** Produce a short human-readable summary for the transcript UI. */
  summarize?: (input: z.infer<Input>) => string;
  execute: (input: z.infer<Input>, ctx: ToolCallContext) => Promise<z.infer<Output>>;
}

export interface ToolCallContext {
  /** Cancellation signal for the enclosing agent run. */
  signal: AbortSignal;
  /** Correlation id for logs and transcript entries. */
  callId: string;
  /** Conversation the call belongs to, when driven by an agent loop. */
  conversationId?: string;
  /**
   * Directory this conversation owns, for files the agent produces.
   *
   * Supplied by the app (see apps/mobile/src/runtime/workspace.ts). Tools use it as
   * the default destination rather than inventing an output folder inside whatever
   * directory they were pointed at; it is not an access boundary.
   */
  workspace?: string;
}

export type AnyToolDefinition = ToolDefinition<z.ZodTypeAny, z.ZodTypeAny>;

/** JSON Schema shape handed to LLM providers. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
