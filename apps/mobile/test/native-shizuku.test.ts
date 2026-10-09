import { describe, expect, it } from "vitest";
import { SCREEN_DEFAULTS } from "@mobileclaw/core";
import {
  createAutomationService,
  createPrivilegedService,
  loadNativeShizuku,
  type NativeShizukuModule,
} from "@/runtime/services/native-shizuku";

/**
 * The JS half of `MobileClawShizuku`, exercised against a fake native module.
 *
 * These are the seams where `SCREEN_DEFAULTS` is meant to be the only place a fallback
 * is decided: the adapter fills a missing `maxWidth`/`quality`/scroll fraction from the
 * shared constant rather than from a number repeated here. A test against the constant
 * is what keeps a change to it from silently missing the native path.
 */

interface NativeCalls {
  screenshots: Array<{ maxWidth: number; quality: number; destDir?: string }>;
  scrolls: Array<["up" | "down" | "left" | "right", number]>;
  runs: Array<{ command: string; timeoutMs: number }>;
}

/** An in-memory stand-in for the Kotlin module, recording what it was asked to do. */
function fakeNative(over: Partial<NativeShizukuModule> = {}): {
  native: NativeShizukuModule;
  calls: NativeCalls;
} {
  const calls: NativeCalls = { screenshots: [], scrolls: [], runs: [] };
  const native: NativeShizukuModule = {
    async status() {
      return { available: true, backend: "shizuku", uid: 2000 };
    },
    async requestPermission() {
      return true;
    },
    async runPrivileged(command, timeoutMs) {
      calls.runs.push({ command, timeoutMs });
      return { exitCode: 0, stdout: "uid=2000(shell)", stderr: "" };
    },
    async screenshot(options) {
      calls.screenshots.push(options);
      return { path: "file:///w/shot.jpg", width: options.maxWidth, height: 1600 };
    },
    async tap() {},
    async scroll(direction, fraction) {
      calls.scrolls.push([direction, fraction]);
    },
    async typeText() {
      return { method: "input" as const };
    },
    async currentWindow() {
      return { package: "com.tencent.mm", activity: ".ui.LauncherUI", raw: "mCurrentFocus=…" };
    },
    ...over,
  };
  return { native, calls };
}

describe("loadNativeShizuku", () => {
  it("returns undefined instead of throwing when the module is not registered", () => {
    // The test environment has no MobileClawShizuku, which is also the stale-build case:
    // the capability must go dark and the tools explain what is missing, never crash.
    expect(() => loadNativeShizuku()).not.toThrow();
    expect(loadNativeShizuku()).toBeUndefined();
  });
});

describe("createAutomationService", () => {
  it("fills a bare capture from SCREEN_DEFAULTS and forwards no destination", async () => {
    const { native, calls } = fakeNative();
    await createAutomationService(native).captureScreen({});

    expect(calls.screenshots).toEqual([
      { maxWidth: SCREEN_DEFAULTS.maxWidth, quality: SCREEN_DEFAULTS.quality },
    ]);
  });

  it("keeps a caller's maxWidth but still applies the default quality", async () => {
    const { native, calls } = fakeNative();
    await createAutomationService(native).captureScreen({ maxWidth: 1024 });

    expect(calls.screenshots).toEqual([{ maxWidth: 1024, quality: SCREEN_DEFAULTS.quality }]);
  });

  it("forwards destDir only when the caller supplied one", async () => {
    const { native, calls } = fakeNative();
    const automation = createAutomationService(native);
    await automation.captureScreen({});
    await automation.captureScreen({ destDir: "/data/ws/conv_1" });

    expect(calls.screenshots[0]).not.toHaveProperty("destDir");
    expect(calls.screenshots[1]).toEqual({
      maxWidth: SCREEN_DEFAULTS.maxWidth,
      quality: SCREEN_DEFAULTS.quality,
      destDir: "/data/ws/conv_1",
    });
  });

  it("scrolls by the shared fraction unless the caller overrides it", async () => {
    const { native, calls } = fakeNative();
    const automation = createAutomationService(native);
    await automation.scroll("down");
    await automation.scroll("down", 0.3);

    expect(calls.scrolls).toEqual([
      ["down", SCREEN_DEFAULTS.scrollFraction],
      ["down", 0.3],
    ]);
  });

  it("reports whether the backend can act right now", async () => {
    const healthy = fakeNative();
    expect((await createAutomationService(healthy.native).status()).available).toBe(true);

    const off = fakeNative({
      async status() {
        return { available: false, reason: "Shizuku is not running" };
      },
    });
    const status = await createAutomationService(off.native).status();
    expect(status.available).toBe(false);
    expect(status.reason).toBe("Shizuku is not running");
  });

  it("reports which input method typed the text", async () => {
    const { native } = fakeNative({
      async typeText() {
        return { method: "paste" as const };
      },
    });
    expect(await createAutomationService(native).typeText("hello")).toEqual({ method: "paste" });
  });
});

describe("createPrivilegedService", () => {
  it("derives availability from the one status call", async () => {
    expect(await createPrivilegedService(fakeNative().native).isAvailable()).toBe(true);

    const off = fakeNative({
      async status() {
        return { available: false, reason: "not installed" };
      },
    });
    expect(await createPrivilegedService(off.native).isAvailable()).toBe(false);
  });

  it("passes the requested timeout through to the native runner", async () => {
    const { native, calls } = fakeNative();
    await createPrivilegedService(native).run("id", { timeoutMs: 5000 });

    expect(calls.runs).toEqual([{ command: "id", timeoutMs: 5000 }]);
  });

  it("uses a positive default timeout when the caller gives none", async () => {
    const { native, calls } = fakeNative();
    await createPrivilegedService(native).run("id");

    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0]!.timeoutMs).toBeGreaterThan(0);
  });

  it("shapes the native result into a ShellResult with a measured duration", async () => {
    const { native } = fakeNative();
    native.runPrivileged = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { exitCode: 0, stdout: "uid=2000(shell)", stderr: "" };
    };

    const result = await createPrivilegedService(native).run("id");

    expect(result.command).toBe("id");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("uid=2000");
    // Measured from the clock, not a placeholder: it must move with the actual call.
    expect(result.durationMs).toBeGreaterThanOrEqual(1);
  });

  it("forwards the permission request to the native module", async () => {
    const { native } = fakeNative();
    expect(await createPrivilegedService(native).requestPermission?.()).toBe(true);
  });
});
