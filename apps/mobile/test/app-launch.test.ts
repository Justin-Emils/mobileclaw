import { describe, expect, it, vi } from "vitest";
import { openAppByPackageId, type AppLauncher } from "@/runtime/services/app-launch";

/**
 * Regression tests for how the agent opens an installed app.
 *
 * The bug these pin down: the first implementation called
 *
 *   IntentLauncher.startActivityAsync("android.intent.action.MAIN", {
 *     packageName: packageId, category: "...LAUNCHER",
 *   })
 *
 * and Expo's native module reads `packageName` only inside `params.className?.let`, so the
 * package was never applied. The intent that actually went out was unbound, Android resolved it
 * against every launcher-capable app, and a remembered disambiguation choice then pinned the
 * wrong app for every later launch.
 *
 * `openApplication` is backed by `getLaunchIntentForPackage` and is a plain native `Function`
 * (void, throws synchronously), which is the second thing worth pinning: an `await` on it
 * catches nothing, so the wrapper must call it inside a try block.
 */

/** A launcher that records what it was asked to open. */
function recorder(behaviour: (id: string) => void = () => {}): { launcher: AppLauncher; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    launcher: {
      openApplication(id: string) {
        calls.push(id);
        behaviour(id);
      },
    },
  };
}

describe("openAppByPackageId", () => {
  it("asks Android to launch the exact package, not a bare launcher intent", async () => {
    const { launcher, calls } = recorder();
    await openAppByPackageId("com.example.chat", launcher);
    // The whole point: the package is the argument. There is no action/category pair to get
    // wrong, because resolution is delegated to the platform.
    expect(calls).toEqual(["com.example.chat"]);
  });

  it("trims surrounding whitespace so a padded id still resolves", async () => {
    const { launcher, calls } = recorder();
    await openAppByPackageId("  com.example.chat  ", launcher);
    expect(calls).toEqual(["com.example.chat"]);
  });

  it("rejects an empty package id without calling the platform", async () => {
    const { launcher, calls } = recorder();
    await expect(openAppByPackageId("   ", launcher)).rejects.toThrow(/没有给出包名/);
    expect(calls).toEqual([]);
  });

  it("catches the synchronous native throw and explains both likely causes", async () => {
    // This is the shape of Expo's own failure: a plain Function that throws before returning.
    const launcher: AppLauncher = {
      openApplication() {
        throw new Error("Package not found: com.example.nope");
      },
    };

    const error = await openAppByPackageId("com.example.nope", launcher).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // The user-facing message must name the package and say what to do, because the previous
    // failure was a bare 失败 with no cause and no next step.
    expect(message).toContain("com.example.nope");
    expect(message).toContain("system_apps");
    expect(message).toContain("深链");
    // The platform's own words are preserved for diagnosis.
    expect(message).toContain("Package not found: com.example.nope");
  });

  it("propagates a non-Error throw as readable text rather than [object Object]", async () => {
    const launcher = {
      openApplication(): void {
        // Native bridges occasionally reject with something that is not an Error.
        throw "native failure";
      },
    };

    const message = await openAppByPackageId("com.example.x", launcher).catch((e: Error) => e.message);
    expect(message).toContain("native failure");
  });

  it("does not swallow a successful launch", async () => {
    const spy = vi.fn();
    await expect(openAppByPackageId("com.example.ok", { openApplication: spy })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
