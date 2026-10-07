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

  it("surfaces a decline without throwing from authorize", async () => {
    const gate = new PermissionGate({ defaultMode: "ask" }, async () => ({ approved: false }));
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
