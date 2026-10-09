import { describe, expect, it, vi } from "vitest";
import { PermissionGate, type PermissionRequest } from "@mobileclaw/core";
import type { AnyToolDefinition } from "@mobileclaw/core";

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  tool: "fs_read",
  risk: "read",
  input: { path: "/sdcard/Download/a.txt" },
  paths: ["/sdcard/Download/a.txt"],
  ...over,
});

/**
 * A tool definition carrying only what the gate reads.
 *
 * Built by hand rather than importing a real tool: these tests are about the gate's rules,
 * and dragging a real capability in would make a failure here look like a failure there.
 */
function definitionOf(over: Partial<AnyToolDefinition> = {}): AnyToolDefinition {
  return {
    name: "screen_scroll",
    description: "test",
    input: undefined as never,
    risk: "system",
    async execute() {
      return {};
    },
    ...over,
  };
}

/**
 * The read-only task scope.
 *
 * The point of these is not that the scope relaxes prompts — it is that it relaxes **nothing
 * else**. A permission relaxation is the easiest place in this codebase to lose the property
 * that a user's refusal cannot be undone by configuration, so each guarantee is pinned
 * separately: deny rules still win, `neverRemember` still wins, a mutating tool is unaffected,
 * a different conversation is unaffected, and the scope ends when the run does.
 */
describe("PermissionGate read-only task scope", () => {
  const conversation = "conv_1";
  const readOnly = (over: Partial<PermissionRequest> = {}) =>
    request({
      tool: "screen_scroll",
      risk: "system",
      conversationId: conversation,
      definition: definitionOf({ alwaysAsk: true, mutates: false }),
      ...over,
    });

  it("stops asking for a non-mutating action once the task is confirmed read-only", () => {
    const gate = new PermissionGate({ defaultMode: "ask" });
    // Before the confirmation there is no scope, so the ordinary rules apply.
    expect(gate.evaluate(readOnly()).allowed).toBe(false);

    gate.beginReadOnlyTask(conversation);
    const verdict = gate.evaluate(readOnly());
    expect(verdict.allowed).toBe(true);
    // The reason names the scope and the grounds, so the transcript explains why nothing was
    // asked. Both halves matter: "the user confirmed" (who allowed it) and "changes nothing"
    // (why this action qualified).
    expect(verdict.reason).toMatch(/task scope/);
    expect(verdict.reason).toMatch(/only reads/);
    expect(verdict.reason).toMatch(/changes nothing/);
  });

  it("does not relax a tool that changes something", () => {
    // Typing writes into another app's field. A read-only task must not be able to authorise
    // it, whatever the user confirmed.
    const gate = new PermissionGate({ defaultMode: "ask" });
    gate.beginReadOnlyTask(conversation);
    const verdict = gate.evaluate(
      readOnly({ tool: "screen_type", definition: definitionOf({ name: "screen_type", alwaysAsk: true }) }),
    );
    expect(verdict.allowed).toBe(false);
  });

  it("treats a tool that says nothing as mutating", () => {
    // The safe default for something reaching outside the app is the cautious one.
    const gate = new PermissionGate({ defaultMode: "ask" });
    gate.beginReadOnlyTask(conversation);
    expect(gate.evaluate(readOnly({ definition: definitionOf({ alwaysAsk: true }) })).allowed).toBe(false);
  });

  it("still honours neverRemember inside the scope", () => {
    // The stronger promise wins: a tool that promised to ask every time keeps asking, so a
    // scope can never erase it.
    const gate = new PermissionGate({ defaultMode: "ask" });
    gate.beginReadOnlyTask(conversation);
    const verdict = gate.evaluate(
      readOnly({ definition: definitionOf({ alwaysAsk: true, neverRemember: true, mutates: false }) }),
    );
    expect(verdict.allowed).toBe(false);
  });

  it("still honours a deny rule inside the scope", () => {
    const gate = new PermissionGate({
      defaultMode: "ask",
      rules: [{ tool: "screen_scroll", decision: "deny" }],
    });
    gate.beginReadOnlyTask(conversation);
    const verdict = gate.evaluate(readOnly());
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/denied by rule/);
  });

  it("does not cover a different conversation", () => {
    const gate = new PermissionGate({ defaultMode: "ask" });
    gate.beginReadOnlyTask(conversation);
    expect(gate.evaluate(readOnly({ conversationId: "conv_2" })).allowed).toBe(false);
  });

  it("does not cover a call that names no conversation", () => {
    // The scope belongs to a task the user saw. An anonymous call has no task to belong to.
    const gate = new PermissionGate({ defaultMode: "ask" });
    gate.beginReadOnlyTask(conversation);
    expect(gate.evaluate(readOnly({ conversationId: undefined })).allowed).toBe(false);
  });

  it("ends when the run ends, so the next task starts from scratch", () => {
    const gate = new PermissionGate({ defaultMode: "ask" });
    gate.beginReadOnlyTask(conversation);
    expect(gate.evaluate(readOnly()).allowed).toBe(true);

    gate.endReadOnlyTask();
    expect(gate.evaluate(readOnly()).allowed).toBe(false);
  });

  it("is replaced, not accumulated, by a second confirmation", () => {
    const gate = new PermissionGate({ defaultMode: "ask" });
    gate.beginReadOnlyTask(conversation);
    gate.beginReadOnlyTask("conv_2");
    expect(gate.evaluate(readOnly()).allowed).toBe(false);
    expect(gate.evaluate(readOnly({ conversationId: "conv_2" })).allowed).toBe(true);
  });

  it("leaves an ordinary allow auto-allowed with no scope at all", () => {
    const gate = new PermissionGate({ defaultMode: "ask", riskModes: { read: "allow" } });
    expect(gate.evaluate(request({ tool: "screen_read", risk: "read" })).allowed).toBe(true);
  });
});

describe("PermissionGate", () => {
  it("asks by default and auto-allows read-only risks when configured", () => {
    const gate = new PermissionGate({ defaultMode: "ask", riskModes: { read: "allow" } });
    expect(gate.evaluate(request()).allowed).toBe(true);
    expect(gate.evaluate(request({ tool: "fs_write", risk: "write" })).allowed).toBe(false);
  });

  it("never runs a denied risk, even with an approval handler present", async () => {
    const approve = vi.fn().mockResolvedValue({ approved: true });
    const gate = new PermissionGate({ defaultMode: "ask", riskModes: { execute: "deny" } }, approve);
    const decision = await gate.authorize(request({ tool: "shell_run", risk: "execute" }));
    expect(decision.allowed).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  it("prompts for confirmable risks and remembers an approval when asked", async () => {
    const approve = vi.fn().mockResolvedValue({ approved: true, remember: true });
    const gate = new PermissionGate({ defaultMode: "ask" }, approve);

    const first = await gate.authorize(request({ tool: "fs_write", risk: "write" }));
    expect(first.allowed).toBe(true);
    expect(approve).toHaveBeenCalledOnce();

    // Remembered: no second prompt.
    const second = await gate.authorize(request({ tool: "fs_write", risk: "write" }));
    expect(second.allowed).toBe(true);
    expect(second.reason).toMatch(/allowlisted/);
    expect(approve).toHaveBeenCalledOnce();
  });

  it("remembers an approval only for the conversation it was granted in", async () => {
    // This was the bug: "always allow" in one chat authorised the same tool in every
    // other chat, so an approval given while organising one folder silently applied
    // to unrelated work.
    const approve = vi.fn().mockResolvedValue({ approved: true, remember: true });
    const gate = new PermissionGate({ defaultMode: "ask" }, approve);

    const inChatOne = await gate.authorize(
      request({ tool: "fs_write", risk: "write", conversationId: "c1" }),
    );
    expect(inChatOne.allowed).toBe(true);
    expect(inChatOne.remember).toBe(true);
    expect(approve).toHaveBeenCalledOnce();

    // Same conversation: already allowed, no second prompt.
    const again = await gate.authorize(request({ tool: "fs_write", risk: "write", conversationId: "c1" }));
    expect(again.allowed).toBe(true);
    expect(approve).toHaveBeenCalledOnce();

    // Different conversation: must ask again.
    const elsewhere = await gate.authorize(
      request({ tool: "fs_write", risk: "write", conversationId: "c2" }),
    );
    expect(elsewhere.allowed).toBe(true);
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it("seeds a conversation's approvals from its stored allowlist", async () => {
    const approve = vi.fn().mockResolvedValue({ approved: false });
    const gate = new PermissionGate({ defaultMode: "ask" }, approve);
    gate.seedConversation("c1", ["fs_write"]);

    // Restored from storage, so reopening a conversation does not re-ask.
    const decision = await gate.authorize(request({ tool: "fs_write", risk: "write", conversationId: "c1" }));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("this conversation");
    expect(approve).not.toHaveBeenCalled();

    // A conversation without the entry still asks.
    await gate.authorize(request({ tool: "fs_write", risk: "write", conversationId: "c2" }));
    expect(approve).toHaveBeenCalledOnce();
  });

  it("keeps global config approvals separate from conversation approvals", async () => {
    const gate = new PermissionGate({ defaultMode: "ask", allowlist: ["fs_read"] });
    // From the settings screen, so it applies everywhere.
    expect(gate.evaluate(request({ tool: "fs_read", conversationId: "c1" })).allowed).toBe(true);
    expect(gate.evaluate(request({ tool: "fs_read", conversationId: "c2" })).allowed).toBe(true);
    expect(gate.evaluate(request({ tool: "fs_read" })).allowed).toBe(true);

    gate.allowForSession("fs_write", "c1");
    expect(gate.sessionAllows("c1")).toContain("fs_write");
    expect(gate.sessionAllows("c2")).not.toContain("fs_write");
  });

  it("forgets a conversation's approvals when it is dropped", async () => {
    const gate = new PermissionGate({ defaultMode: "ask" });
    gate.seedConversation("c1", ["fs_write"]);
    expect(gate.evaluate(request({ tool: "fs_write", conversationId: "c1" })).allowed).toBe(true);
    gate.forgetConversation("c1");
    expect(gate.evaluate(request({ tool: "fs_write", conversationId: "c1" })).allowed).toBe(false);
  });

  it("surfaces a decline without throwing from authorize", async () => {    const gate = new PermissionGate({ defaultMode: "ask" }, async () => ({ approved: false }));
    const decision = await gate.authorize(request({ tool: "fs_organize", risk: "write" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/user declined/);
  });

  it("throws E_PERMISSION_DENIED when nothing can prompt", async () => {
    const gate = new PermissionGate({ defaultMode: "ask" });
    await expect(gate.authorize(request({ tool: "shell_run", risk: "execute" }))).rejects.toThrowError(
      /permission denied for "shell_run"/,
    );
  });

  it("lets a deny rule win over a broader allow rule", () => {
    const gate = new PermissionGate({
      defaultMode: "deny",
      rules: [
        { tool: "fs_*", decision: "allow" },
        { tool: "fs_organize", decision: "deny" },
      ],
    });
    expect(gate.evaluate(request()).allowed).toBe(true);
    const denied = gate.evaluate(request({ tool: "fs_organize", risk: "write" }));
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/denied by rule/);
  });

  it("scopes allow rules to a path pattern", () => {
    const gate = new PermissionGate({
      defaultMode: "deny",
      rules: [{ tool: "fs_write", decision: "allow", pathPattern: "/sdcard/Download/**" }],
    });
    expect(
      gate.evaluate(request({ tool: "fs_write", risk: "write", paths: ["/sdcard/Download/x.txt"] })).allowed,
    ).toBe(true);
    expect(
      gate.evaluate(request({ tool: "fs_write", risk: "write", paths: ["/sdcard/DCIM/x.txt"] })).allowed,
    ).toBe(false);
  });

  it("always asks for tools that opt into confirmation", () => {
    const gate = new PermissionGate({ defaultMode: "allow" });
    const decision = gate.evaluate(
      request({
        tool: "fs_organize",
        risk: "write",
        definition: {
          name: "fs_organize",
          description: "organise",
          input: { safeParse: () => ({ success: true }) } as never,
          risk: "write",
          alwaysAsk: true,
          execute: async () => ({}),
        },
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/explicit confirmation/);
  });

  it("tracks session allowlist changes", () => {
    const gate = new PermissionGate({ defaultMode: "deny" });
    gate.allowForSession("shell_run");
    expect(gate.evaluate(request({ tool: "shell_run", risk: "execute" })).allowed).toBe(true);
    gate.revoke("shell_run");
    expect(gate.evaluate(request({ tool: "shell_run", risk: "execute" })).allowed).toBe(false);
  });

  describe("neverRemember", () => {
    const definition = (over: Record<string, unknown> = {}): NonNullable<PermissionRequest["definition"]> => ({
      name: "screen_tap",
      description: "tap something on screen",
      input: { safeParse: () => ({ success: true }) } as never,
      risk: "system",
      neverRemember: true,
      execute: async () => ({}),
      ...over,
    });

    const tap = (over: Partial<PermissionRequest> = {}): PermissionRequest =>
      request({ tool: "screen_tap", risk: "system", definition: definition(), ...over });

    it("prompts on every call, even after the user approved the same tool", async () => {
      // The whole point: an action that changes the screen is the user's decision each
      // time, so approving it once must not authorise the next press.
      const approve = vi.fn().mockResolvedValue({ approved: true });
      const gate = new PermissionGate({ defaultMode: "ask" }, approve);

      expect((await gate.authorize(tap())).allowed).toBe(true);
      expect(approve).toHaveBeenCalledTimes(1);

      expect((await gate.authorize(tap())).allowed).toBe(true);
      expect(approve).toHaveBeenCalledTimes(2);
    });

    it("throws away a remember request instead of trusting the UI to hide the button", async () => {
      const approve = vi.fn().mockResolvedValue({ approved: true, remember: true });
      const gate = new PermissionGate({ defaultMode: "ask" }, approve);

      const first = await gate.authorize(tap({ conversationId: "c1" }));
      expect(first.allowed).toBe(true);
      expect(first.remember).toBeUndefined();
      // Nothing was recorded anywhere, so no later run can inherit the grant.
      expect(gate.sessionAllows("c1")).not.toContain("screen_tap");
      expect(gate.sessionAllows()).not.toContain("screen_tap");

      await gate.authorize(tap({ conversationId: "c1" }));
      expect(approve).toHaveBeenCalledTimes(2);
    });

    it("ignores a grant restored from a conversation saved by an older version", async () => {
      const approve = vi.fn().mockResolvedValue({ approved: true });
      const gate = new PermissionGate({ defaultMode: "ask" }, approve);
      gate.seedConversation("c1", ["screen_tap"]);

      const decision = await gate.authorize(tap({ conversationId: "c1" }));
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toMatch(/user approved/);
      expect(approve).toHaveBeenCalledOnce();
    });

    it("ignores a global config allowlist entry", async () => {
      const approve = vi.fn().mockResolvedValue({ approved: true });
      const gate = new PermissionGate({ defaultMode: "ask", allowlist: ["screen_tap"] }, approve);

      await gate.authorize(tap());
      expect(approve).toHaveBeenCalledOnce();
    });

    it("ignores an allow rule that would otherwise match", () => {
      const gate = new PermissionGate({
        defaultMode: "deny",
        rules: [{ tool: "screen_*", decision: "allow" }],
      });
      const decision = gate.evaluate(tap());
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/every action/);
    });

    it("still yields to a deny rule, which is final", () => {
      const gate = new PermissionGate({
        defaultMode: "ask",
        rules: [{ tool: "screen_tap", decision: "deny" }],
      });
      const decision = gate.evaluate(tap());
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/denied by rule/);
    });

    it("leaves alwaysAsk alone, so only neverRemember is the strict promise", async () => {
      // `alwaysAsk` means "ask the first time"; `neverRemember` means "ask every time".
      // They are separate promises and the rememberable one must keep working.
      const approve = vi.fn().mockResolvedValue({ approved: true, remember: true });
      const gate = new PermissionGate({ defaultMode: "ask" }, approve);
      const organize = request({
        tool: "fs_organize",
        risk: "write",
        definition: definition({ name: "fs_organize", risk: "write", alwaysAsk: true, neverRemember: false }),
      });

      expect((await gate.authorize(organize)).remember).toBe(true);
      await gate.authorize(organize);
      expect(approve).toHaveBeenCalledOnce();
    });
  });
});
