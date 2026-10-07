import { describe, expect, it, vi } from "vitest";
import { PermissionGate, type PermissionRequest } from "@mobileclaw/core";

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  tool: "fs_read",
  risk: "read",
  input: { path: "/sdcard/Download/a.txt" },
  paths: ["/sdcard/Download/a.txt"],
  ...over,
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
});
