import { describe, expect, it } from "vitest";
import { packageMatches, screenActionAllowed } from "@mobileclaw/capabilities";
import { createRunKeepAwake, isGoneFromScreen } from "../src/runtime/foreground";

/**
 * Staying alive during a run, and stopping when the screen stops being trustworthy.
 *
 * These two jobs look unrelated and are not. The agent loop is JavaScript in this app, so anything
 * that freezes the process stops the run mid-step with nothing thrown — and whatever step it
 * stopped in the middle of was planned against a screen that no longer exists. Holding the display
 * awake prevents the freeze nobody asked for; the foreground flag and the cancellation handle the
 * one the user did ask for by leaving.
 */

describe("screenActionAllowed", () => {
  it("allows an action while the run is live", () => {
    // Deliberately says nothing about which app is in front. This app is *meant* to be behind the
    // app it is operating — a phone shows one app at a time — so an app-state check would refuse
    // in the only situation the project exists for. That question belongs to `packageMatches`.
    expect(screenActionAllowed({ signal: new AbortController().signal })).toEqual({ ok: true });
  });

  it("allows an action when there is no signal at all", () => {
    expect(screenActionAllowed({}).ok).toBe(true);
  });

  it("refuses once the run has been cancelled", () => {
    const controller = new AbortController();
    controller.abort();
    const verdict = screenActionAllowed({ signal: controller.signal });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/cancelled/);
  });
});

describe("packageMatches", () => {
  it("accepts a reading from the expected app", () => {
    expect(packageMatches("com.tencent.mm", "com.tencent.mm")).toBe(true);
  });

  it("rejects a reading from a different app", () => {
    // The guard that actually protects the irreversible step: a screen full of the right name, read
    // from the wrong app, is not evidence.
    expect(packageMatches("com.tencent.mobileqq", "com.tencent.mm")).toBe(false);
  });

  it("does not reject on silence, in either direction", () => {
    // "Could not tell" is not "wrong". Refusing here would take screen automation away from every
    // device whose reading cannot name its app — a real cost for no safety.
    expect(packageMatches(undefined, "com.tencent.mm")).toBe(true);
    expect(packageMatches("com.tencent.mm", undefined)).toBe(true);
    expect(packageMatches(undefined, undefined)).toBe(true);
  });
});

describe("createRunKeepAwake", () => {
  it("holds the display only for the span of a run", () => {
    const calls: boolean[] = [];
    const awake = createRunKeepAwake({
      async keepScreenOn(on) {
        calls.push(on);
        return on;
      },
    });

    expect(awake.held()).toBe(false);
    awake.acquire();
    expect(awake.held()).toBe(true);
    awake.release();
    expect(awake.held()).toBe(false);
    // One on, one off — not one pair per caller.
    expect(calls).toEqual([true, false]);
  });

  it("refcounts overlapping runs, so the first release does not let the display sleep", () => {
    // Two runs can overlap (a cancel racing a new instruction). Releasing on the first one would
    // let the screen sleep in the middle of the second.
    const calls: boolean[] = [];
    const awake = createRunKeepAwake({
      async keepScreenOn(on) {
        calls.push(on);
        return on;
      },
    });
    awake.acquire();
    awake.acquire();
    awake.release();
    expect(awake.held()).toBe(true);
    expect(calls).toEqual([true]);
    awake.release();
    expect(calls).toEqual([true, false]);
  });

  it("survives a missing or broken native method", () => {
    // A display that will not stay awake degrades a run; it must not end it. This is also the
    // path a native module older than this JavaScript takes.
    expect(() => createRunKeepAwake(undefined).acquire()).not.toThrow();

    const throwing = createRunKeepAwake({
      keepScreenOn() {
        throw new Error("no activity");
      },
    });
    expect(() => throwing.acquire()).not.toThrow();
    expect(() => throwing.release()).not.toThrow();
  });

  it("absorbs a rejected promise instead of leaving it unhandled", () => {
    const awake = createRunKeepAwake({
      async keepScreenOn() {
        throw new Error("no current activity to hold the display with");
      },
    });
    expect(() => awake.acquire()).not.toThrow();
  });

  it("never counts below zero", () => {
    const awake = createRunKeepAwake(undefined);
    awake.release();
    awake.release();
    expect(awake.held()).toBe(false);
  });
});
