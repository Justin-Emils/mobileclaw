import { describe, expect, it, vi } from "vitest";
import type { ForegroundWindow } from "@mobileclaw/core";
import { awaitArrival, describeArrival } from "../src/app-state";

/**
 * Whether a launch actually arrived.
 *
 * The distinction this file exists to protect is between **"the screen shows the wrong app"** and
 * **"the screen cannot be read"**. Only the first is evidence that the launch failed. Reporting the
 * second as a failure is the mistake the whole project keeps having to avoid: on a device whose
 * dumpsys does not name the foreground window, it would turn "we cannot see" into "the app did not
 * open" and send the model off to fix a launch that already worked.
 *
 * The other thing pinned here is that a *resumed* launch is not a failed launch. WeChat and NetEase
 * Cloud Music restore the screen you last left them on, so the app arriving at the right package but
 * a different activity is normal — and reporting the activity is the entire point, since it is what
 * lets the caller tell "opened at home" from "resumed an old screen".
 */

/** A readable window naming `pkg` (and optionally `activity`). */
function reading(pkg: string | undefined, activity?: string, raw = "line"): ForegroundWindow {
  return pkg === undefined ? { raw } : { package: pkg, ...(activity ? { activity } : {}), raw };
}

/** A reader that yields the given windows in order, then repeats the last one forever. */
function readerOf(...windows: ForegroundWindow[]) {
  let i = 0;
  return vi.fn(async () => {
    const window = windows[Math.min(i, windows.length - 1)]!;
    i++;
    return window;
  });
}

describe("awaitArrival", () => {
  it("reports arrival with the activity, so a resumed screen is visible as such", async () => {
    // The point of returning `activity`: the package alone cannot distinguish "opened at home"
    // from "resumed an old screen", and those need different next steps.
    const result = await awaitArrival("com.tencent.mm", readerOf(reading("com.tencent.mm", ".ui.LauncherUI")));
    expect(result).toEqual({ arrived: true, package: "com.tencent.mm", activity: ".ui.LauncherUI" });
  });

  it("keeps polling until the app comes forward", async () => {
    // A launch is asynchronous and the first read routinely happens before the target is drawn.
    // Our own app is in front at that moment, which is exactly what makes a single read useless.
    const read = readerOf(reading("dev.mobileclaw.app"), reading("dev.mobileclaw.app"), reading("com.tencent.mm", ".ui.LauncherUI"));
    const result = await awaitArrival("com.tencent.mm", read, { pollMs: 1 });
    expect(result.arrived).toBe(true);
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("reports not-foreground only when the screen was readable and named another app", async () => {
    const result = await awaitArrival("com.tencent.mm", readerOf(reading("com.android.launcher3", ".Launcher")), {
      timeoutMs: 5,
      pollMs: 1,
    });
    expect(result).toEqual({
      arrived: false,
      reason: "not-foreground",
      sawPackage: "com.android.launcher3",
      sawActivity: ".Launcher",
    });
  });

  it("reports unverified — not a failure — when no reading ever named a package", async () => {
    // The regression this guards. An unreadable probe is a *detection* failure; calling it
    // "did not open" sends the model to fix a launch that may well have succeeded.
    const result = await awaitArrival("com.tencent.mm", readerOf(reading(undefined, undefined, "dumpsys said nothing")), {
      timeoutMs: 5,
      pollMs: 1,
    });
    expect(result.arrived).toBe(false);
    expect(result).toMatchObject({ reason: "unverified", raw: "dumpsys said nothing" });
    if (result.arrived === false && result.reason === "unverified") {
      expect(result.detail).toContain("never named a foreground app");
    }
  });

  it("prefers a readable wrong app over an unreadable reading, whichever came last", async () => {
    // Interleaved, with the *unreadable* one last. The readable one is still the better evidence:
    // it is the only reading that says anything about where the launch went.
    const result = await awaitArrival(
      "com.tencent.mm",
      readerOf(reading("com.netease.cloudmusic", ".ui.MainActivity"), reading(undefined, undefined, "noise")),
      { timeoutMs: 5, pollMs: 1 },
    );
    expect(result).toMatchObject({ reason: "not-foreground", sawPackage: "com.netease.cloudmusic" });
  });

  it("reports unverified when there is no way to read the foreground at all", async () => {
    // iOS, or an Android build without the privileged backend. It must not claim the launch failed.
    const result = await awaitArrival("com.tencent.mm", undefined);
    expect(result.arrived).toBe(false);
    if (result.arrived === false && result.reason === "unverified") {
      expect(result.detail).toContain("cannot report which app is in the foreground");
    } else {
      throw new Error("expected an unverified outcome");
    }
  });

  it("treats a throwing probe as unverified rather than as a failed launch", async () => {
    const read = vi.fn(async () => {
      throw new Error("shizuku binder died");
    });
    const result = await awaitArrival("com.tencent.mm", read, { timeoutMs: 5, pollMs: 1 });
    expect(result.arrived).toBe(false);
    if (result.arrived === false && result.reason === "unverified") {
      expect(result.detail).toContain("shizuku binder died");
    } else {
      throw new Error("expected an unverified outcome");
    }
  });

  describe("when a target activity is required", () => {
    it("accepts a substring match, matching how screen_wait compares", async () => {
      const result = await awaitArrival(
        "com.netease.cloudmusic",
        readerOf(reading("com.netease.cloudmusic", "com.netease.cloudmusic.ui.MainActivity")),
        { activity: "MainActivity" },
      );
      expect(result.arrived).toBe(true);
    });

    it("keeps waiting while the right app shows a different screen", async () => {
      // A launch passes through other screens before settling, so the wrong activity is not yet a
      // failure. Failing here would report a normal launch as broken.
      const read = readerOf(
        reading("com.netease.cloudmusic", ".ui.SplashActivity"),
        reading("com.netease.cloudmusic", ".ui.MainActivity"),
      );
      const result = await awaitArrival("com.netease.cloudmusic", read, { activity: "MainActivity", pollMs: 1 });
      expect(result.arrived).toBe(true);
      expect(read.mock.calls.length).toBe(2);
    });

    it("reports not-foreground when the right app never reaches the wanted screen", async () => {
      const result = await awaitArrival(
        "com.netease.cloudmusic",
        readerOf(reading("com.netease.cloudmusic", ".ui.NowPlayingActivity")),
        { activity: "MainActivity", timeoutMs: 5, pollMs: 1 },
      );
      expect(result).toMatchObject({ reason: "not-foreground", sawPackage: "com.netease.cloudmusic", sawActivity: ".ui.NowPlayingActivity" });
    });

    it("says the activity was part of the question when the probe could not tell", async () => {
      const result = await awaitArrival("com.netease.cloudmusic", readerOf(reading(undefined)), {
        activity: "MainActivity",
        timeoutMs: 5,
        pollMs: 1,
      });
      if (result.arrived === false && result.reason === "unverified") {
        expect(result.detail).toContain("MainActivity");
      } else {
        throw new Error("expected an unverified outcome");
      }
    });
  });

  it("stops immediately for an already-aborted run", async () => {
    // A cancelled run must not spend its timeout polling.
    const read = readerOf(reading("dev.mobileclaw.app"));
    const controller = new AbortController();
    controller.abort();
    const result = await awaitArrival("com.tencent.mm", read, { timeoutMs: 10_000, pollMs: 1, signal: controller.signal });
    expect(result).toMatchObject({ reason: "unverified" });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("describeArrival", () => {
  it("tells the model not to report an unverified launch as done", async () => {
    // The wording is load-bearing: it is the only thing standing between "we could not check" and
    // the run narrating a success it never observed.
    const text = describeArrival(
      { arrived: false, reason: "unverified", detail: "the probe failed" },
      "com.tencent.mm",
    );
    expect(text.verified).toBe(false);
    expect(String(text.verifyNote)).toMatch(/do not report it as done/i);
    expect(String(text.verifyNote)).toMatch(/detection failure, not proof the launch failed/i);
  });

  it("names the app that was actually in front when the launch did not land", () => {
    const text = describeArrival(
      { arrived: false, reason: "not-foreground", sawPackage: "com.android.launcher3", sawActivity: ".Launcher" },
      "com.tencent.mm",
    );
    expect(String(text.verifyNote)).toContain("com.android.launcher3");
    expect(String(text.verifyNote)).toContain(".Launcher");
  });

  it("omits the activity when arrival did not produce one", () => {
    const text = describeArrival({ arrived: true, package: "com.tencent.mm" }, "com.tencent.mm");
    expect(text).toEqual({ verified: true, package: "com.tencent.mm" });
  });
});
