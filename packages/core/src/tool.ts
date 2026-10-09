import { z } from "zod";

/**
 * Risk vocabulary. The permission gate maps (risk, tool) pairs onto allow/ask/deny,
 * so a plugin author declares intent once instead of implementing prompts.
 */
export const RISK_LEVELS = ["read", "write", "execute", "network", "system"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const riskLevelSchema = z.enum(RISK_LEVELS);

/**
 * What a tool touches when it runs.
 *
 * Kept short and coarse on purpose: this exists to be summarised in a prompt and reasoned
 * about by a model, and a vocabulary with twenty entries would be neither. The distinction
 * that earns its place is between seeing something and changing it — `screen` and `edit` —
 * because that is the line the user's approval model draws.
 */
export const TOOL_EFFECTS = [
  /** Reads a screen. Sees what is displayed; changes nothing. */
  "screen",
  /** Changes what is on a screen, or what an app contains. */
  "edit",
  /** Reads or writes the filesystem. */
  "disk",
  /** Leaves the device. */
  "network",
  /** Starts a process or runs a command. */
  "process",
  /** Sends something to another app or the user. */
  "share",
] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

/**
 * External capabilities a tool can need.
 *
 * Named rather than described, so a host can check them and a UI can explain them without
 * parsing prose.
 */
export const TOOL_REQUIREMENTS = [
  /** Shizuku, for shell identity on Android. */
  "shizuku",
  /** A shell backend: Shizuku or Termux. */
  "shell",
  /** A Python interpreter reachable through the shell. */
  "python",
  /** A search backend, which is optional even when a network is present. */
  "search",
  /** The device's own network access. */
  "internet",
] as const;
export type ToolRequirement = (typeof TOOL_REQUIREMENTS)[number];

/**
 * The domains the shipped bundles use.
 *
 * A constant rather than a union so a plugin can introduce its own: the kernel should not have
 * to be edited to add a capability. These exist so the catalogue can order and label the common
 * ones predictably.
 */
export const KNOWN_CATEGORIES = [
  "files",
  "shell",
  "python",
  "system",
  "screen-read",
  "screen-act",
  "web",
  "plan",
] as const;

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
  /**
   * Declares that running this leaves no lasting change.
   *
   * Needed because risk level alone cannot answer the question that matters. `screen_tap`
   * is `system` risk and may press "send"; `screen_scroll` is not on the screen at all in
   * terms of risk, yet does nothing but move content. A user who asked the agent to *read*
   * something should not be interrupted to approve scrolling, and no static rule over
   * (tool, risk) can tell those apart — so the tool says which it is.
   *
   * This is consulted **only** inside a confirmed read-only task scope (see
   * `PermissionGate.beginReadOnlyTask`). It never widens permission on its own: a tool that
   * declares `mutates: false` is still asked when there is no scope, and a tool that says
   * nothing is treated as mutating.
   *
   * Omitted means "assume it changes something", because the safe default for a capability
   * that reaches outside the app is the cautious one.
   */
  mutates?: boolean;
  /**
   * Declares that one argument comes from the user pointing at a picture.
   *
   * The model cannot see the screen, so a coordinate it produced would be a guess.
   * This is the channel that lets the human supply it instead: the approval UI offers a
   * point picker over the image found in the input field named `image`, and merges the
   * choice in as `{ [x]: …, [y]: … }` for the call that runs.
   *
   * Declared rather than sniffed from the input's shape, so the UI never has to guess
   * which tools want a point — the same reason `paths` and `alwaysAsk` are declared.
   */
  pickPoint?: { x: string; y: string; image: string };
  /**
   * Which domain this tool belongs to, for the catalogue the model reads.
   *
   * Free-form rather than an enum so a plugin can add its own domain without a kernel change;
   * the shipped ones are listed in `KNOWN_CATEGORIES`. Grouping matters once there are more
   * tools than fit comfortably in a prompt: eight domains are navigable, a flat list of a
   * hundred names is not.
   */
  category?: string;
  /**
   * What this tool touches when it runs, independent of how risky that is.
   *
   * Separate from `risk` because the two answer different questions. `risk` asks "how much
   * should the user be asked about this?"; `effects` asks "what will have been touched
   * afterwards?" — and the two come apart in both directions: `screen_scroll` moves content
   * and changes nothing, while `fs_read` can touch a network share.
   *
   * Omitted means **unknown**, and unknown is reported as the broadest case. A catalogue that
   * guessed "harmless" for a tool nobody annotated would be worse than one that admits it.
   */
  effects?: readonly ToolEffect[];
  /**
   * External capabilities this tool needs in order to work at all.
   *
   * Declared so the absence can be reported *before* the call instead of after it fails:
   * "this needs Shizuku, which is not running" is actionable, whereas `E_TOOL_FAILED` from a
   * tool that never had a chance reads as a bug. Omitted means "needs nothing beyond the app".
   */
  requires?: readonly ToolRequirement[];
  /**
   * Rough cost, for a catalogue that has to fit in a prompt.
   *
   * `cheap` is a local call or a small read; `slow` makes the user wait — launching an app, a
   * shell command, or one network round trip per item. Omitted is treated as `cheap`, because
   * an over-cautious model that declines to act is the smaller failure than one that
   * serialises twenty requests the user did not ask for.
   */
  cost?: "cheap" | "slow";
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
