import { CoreError } from "./errors";
import { RISK_LEVELS, riskLevelSchema, type RiskLevel, type ToolDefinition } from "./tool";
import { z } from "zod";

export interface PermissionRule {
  /** Tool name, exact or glob (`fs_*`). */
  tool: string;
  /** Risks this rule applies to; defaults to all. */
  risk?: RiskLevel[];
  /** Verdict when the rule matches. */
  decision: "allow" | "deny";
  /** Optional path glob the call must match for the rule to apply. */
  pathPattern?: string;
}

export interface PermissionConfig {
  /** Baseline behaviour for anything not covered by a rule. */
  defaultMode: "allow" | "ask" | "deny";
  /** Per-risk overrides, checked before `defaultMode`. */
  riskModes?: Partial<Record<RiskLevel, "allow" | "ask" | "deny">>;
  rules?: PermissionRule[];
  /** Tool names auto-approved for the current conversation. */
  allowlist?: string[];
  /** Hard ceiling: these risks always prompt unless explicitly denied. */
  alwaysAskRisks?: RiskLevel[];
}

export interface PermissionRequest {
  tool: string;
  risk: RiskLevel;
  input: unknown;
  paths?: string[];
  summary?: string;
  /**
   * Why approval is needed, straight from the gate's verdict. The UI shows this
   * verbatim so the user is never asked to approve something unexplained.
   */
  reason?: string;
  conversationId?: string;
  /** The full definition, when available (enables `alwaysAsk`). */
  definition?: ToolDefinition;
}

export interface PermissionDecision {
  allowed: boolean;
  /** How the verdict was reached, surfaced in the UI and the transcript. */
  reason: string;
  /** True when the decision came from a human approval callback. */
  approved?: boolean;
  /** True when the user asked to stop being asked about this tool. */
  remember?: boolean;
}

export type ApprovalHandler = (
  request: PermissionRequest,
) => Promise<{ approved: boolean; remember?: boolean }>;

export const permissionConfigSchema = z.object({
  defaultMode: z.enum(["allow", "ask", "deny"]).default("ask"),
  riskModes: z
    .object(
      RISK_LEVELS.reduce(
        (acc, level) => ({ ...acc, [level]: z.enum(["allow", "ask", "deny"]).optional() }),
        {} as Record<RiskLevel, z.ZodOptional<z.ZodEnum<["allow", "ask", "deny"]>>>,
      ),
    )
    .partial()
    .optional(),
  rules: z
    .array(
      z.object({
        tool: z.string(),
        risk: z.array(riskLevelSchema).optional(),
        decision: z.enum(["allow", "deny"]),
        pathPattern: z.string().optional(),
      }),
    )
    .optional(),
  allowlist: z.array(z.string()).optional(),
  alwaysAskRisks: z.array(riskLevelSchema).optional(),
});

/**
 * The single place where "may this capability run?" is answered.
 *
 * Order of evaluation:
 *   1. explicit allowlist (user said "always allow this tool")
 *   2. deny rules, then allow rules
 *   3. alwaysAskRisks, then riskModes, then defaultMode
 *
 * `evaluate` never blocks; `authorize` may, by calling the host's approval
 * callback (in the app: a modal; in tests: a stub).
 *
 * ## Scope of "always allow"
 *
 * Approvals are **per conversation**. `sessionAllowlist` is the fallback for calls
 * that name no conversation (a one-off script, a test); anything carrying a
 * `conversationId` is matched only against that conversation's own list.
 *
 * This used to be a single set, so "always allow" in one chat silently authorised
 * the same tool in every other chat — including ones about unrelated folders. The
 * caller owns persistence: when `authorize` reports `remember: true`, the agent
 * appends the tool to the conversation's `allowlist` and saves it, then seeds the
 * gate from that list on the next run via `seedConversation`.
 */
export class PermissionGate {
  private readonly defaultAllowlist = new Set<string>();
  /** conversationId -> tool names the user permanently allowed in it. */
  private readonly conversationAllowlists = new Map<string, Set<string>>();
  private current: PermissionConfig;

  constructor(
    config: PermissionConfig,
    private readonly approval?: ApprovalHandler,
  ) {
    this.current = config;
    for (const tool of config.allowlist ?? []) this.defaultAllowlist.add(tool);
  }

  get config(): PermissionConfig {
    return this.current;
  }

  update(config: Partial<PermissionConfig>): void {
    this.current = { ...this.current, ...config };
    // Config edits are global (they come from the settings screen), so they land in
    // the default list rather than in whichever conversation happens to be open.
    for (const tool of config.allowlist ?? []) this.defaultAllowlist.add(tool);
  }

  /** Restore the tools permanently allowed in a stored conversation. */
  seedConversation(conversationId: string, tools: string[] | undefined): void {
    const set = this.conversationAllowlists.get(conversationId) ?? new Set<string>();
    for (const tool of tools ?? []) set.add(tool);
    this.conversationAllowlists.set(conversationId, set);
  }

  /** Drop a conversation's approvals, e.g. when it is deleted. */
  forgetConversation(conversationId: string): void {
    this.conversationAllowlists.delete(conversationId);
  }

  allowForSession(tool: string, conversationId?: string): void {
    if (!conversationId) {
      this.defaultAllowlist.add(tool);
      return;
    }
    const set = this.conversationAllowlists.get(conversationId) ?? new Set<string>();
    set.add(tool);
    this.conversationAllowlists.set(conversationId, set);
  }

  revoke(tool: string, conversationId?: string): void {
    if (!conversationId) {
      this.defaultAllowlist.delete(tool);
      return;
    }
    this.conversationAllowlists.get(conversationId)?.delete(tool);
  }

  /** Tool names allowed in a given conversation, defaults included. */
  sessionAllows(conversationId?: string): string[] {
    if (!conversationId) return [...this.defaultAllowlist];
    const scoped = this.conversationAllowlists.get(conversationId);
    return [...new Set([...this.defaultAllowlist, ...(scoped ?? [])])];
  }

  private isAllowed(tool: string, conversationId?: string): boolean {
    if (this.defaultAllowlist.has(tool)) return true;
    if (!conversationId) return false;
    return this.conversationAllowlists.get(conversationId)?.has(tool) ?? false;
  }

  /** Pure verdict; no user interaction. */
  evaluate(request: PermissionRequest): PermissionDecision {
    if (this.isAllowed(request.tool, request.conversationId)) {
      return {
        allowed: true,
        reason: request.conversationId ? "allowlisted for this conversation" : "allowlisted",
      };
    }

    for (const rule of this.config.rules ?? []) {
      if (rule.decision !== "deny") continue;
      if (!matchTool(rule.tool, request.tool)) continue;
      if (rule.risk && !rule.risk.includes(request.risk)) continue;
      if (rule.pathPattern && !(request.paths ?? []).some((p) => globMatch(rule.pathPattern!, p))) {
        continue;
      }
      return { allowed: false, reason: `denied by rule for "${rule.tool}"` };
    }

    for (const rule of this.config.rules ?? []) {
      if (rule.decision !== "allow") continue;
      if (!matchTool(rule.tool, request.tool)) continue;
      if (rule.risk && !rule.risk.includes(request.risk)) continue;
      if (rule.pathPattern && !(request.paths ?? []).some((p) => globMatch(rule.pathPattern!, p))) {
        continue;
      }
      return { allowed: true, reason: `allowed by rule for "${rule.tool}"` };
    }

    if (request.definition?.alwaysAsk) {
      return { allowed: false, reason: "tool requires explicit confirmation" };
    }

    if (this.config.alwaysAskRisks?.includes(request.risk)) {
      return { allowed: false, reason: `risk "${request.risk}" always requires confirmation` };
    }

    const mode = this.config.riskModes?.[request.risk] ?? this.config.defaultMode;
    if (mode === "allow") return { allowed: true, reason: `risk "${request.risk}" auto-allowed` };
    if (mode === "deny") return { allowed: false, reason: `risk "${request.risk}" is disabled` };
    return { allowed: false, reason: `risk "${request.risk}" needs confirmation` };
  }

  /**
   * Verdict plus approval. A request that `evaluate` rejects may still be granted
   * when an approval handler exists and is configured to be asked — denial by
   * `deny` mode/rule is final, everything else is a prompt.
   */
  async authorize(request: PermissionRequest): Promise<PermissionDecision> {
    const verdict = this.evaluate(request);
    if (verdict.allowed) return verdict;
    if (isHardDenial(verdict.reason)) return verdict;
    if (!this.approval) {
      throw new CoreError("E_PERMISSION_DENIED", `permission denied for "${request.tool}"`, {
        reason: verdict.reason,
      });
    }
    const { approved, remember } = await this.approval(request);
    if (!approved) {
      return { allowed: false, reason: `user declined "${request.tool}"`, approved: false };
    }
    // Recorded in this conversation only; the caller persists it onto the
    // conversation so the next run can seed the gate from there.
    if (remember) this.allowForSession(request.tool, request.conversationId);
    return {
      allowed: true,
      reason: `user approved "${request.tool}"`,
      approved: true,
      ...(remember ? { remember: true } : {}),
    };
  }
}

function isHardDenial(reason: string): boolean {
  return reason.startsWith("denied by rule") || reason.endsWith("is disabled");
}

/** Glob matcher for tool names and paths (`*` matches within a segment, `**` across). */
export function globMatch(pattern: string, value: string): boolean {
  const regex = globToRegExp(pattern);
  return regex.test(value);
}

export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += "[^/\\\\]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/\\\\]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function matchTool(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes("*")) return false;
  return globMatch(pattern, name);
}
