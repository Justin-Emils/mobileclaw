import { describe, expect, it, vi } from "vitest";
import { startRunService, type AppStateLike, type RunServiceNative } from "@/runtime/run-service";
import { strings } from "@/ui/strings";

/**
 * The foreground service is what stops Android freezing this process while the agent operates
 * another app — the bug where a run stops silently between two tool calls.
 *
 * The rule that makes it easy to get wrong, and therefore what these tests are mostly about:
 * **Android 12+ refuses to start a foreground service from the background.** So the service must be
 * started while the app is visible and then left running; starting it when a run begins is exactly
 * the call the platform rejects.
 */

/** An `AppState` stand-in whose state can be driven and whose listener can be inspected. */
function fakeAppState(initial: string | null) {
  const handlers: ((state: string) => void)[] = [];
  let removed = 0;
  const appState: AppStateLike = {
    currentState: initial,
    addEventListener(_type, handler) {
      handlers.push(handler);
      return {
        remove() {
          removed += 1;
        },
      };
    },
  };
  return {
    appState,
    push(state: string) {
      appState.currentState = state;
      for (const handler of handlers) handler(state);
    },
    get listenerCount() {
      return handlers.length;
    },
    get removed() {
      return removed;
    },
  };
}

function fakeNative(): RunServiceNative & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async startRunService(text: string) {
      calls.push(`start:${text}`);
      return true;
    },
    async stopRunService() {
      calls.push("stop");
      return true;
    },
  };
}

describe("startRunService", () => {
  it("starts while the app is already visible, which is the only moment it may be started", () => {
    // The common case at launch: the app is on screen, so this is the one opportunity to start a
    // foreground service. Waiting for a state *change* would miss it entirely.
    const state = fakeAppState("active");
    const native = fakeNative();

    const handle = startRunService({ native, appState: state.appState });

    expect(handle.started()).toBe(true);
    expect(native.calls).toEqual([`start:${strings.run.serviceText}`]);
  });

  it("does not try to start while the app is in the background", () => {
    // This is the platform restriction, not an optimisation: a start from the background throws.
    const state = fakeAppState("background");
    const native = fakeNative();

    const handle = startRunService({ native, appState: state.appState });

    expect(handle.started()).toBe(false);
    expect(native.calls).toEqual([]);
  });

  it("starts on the next transition to active, after having been backgrounded at launch", () => {
    const state = fakeAppState("background");
    const native = fakeNative();
    startRunService({ native, appState: state.appState });

    state.push("active");

    expect(native.calls).toEqual([`start:${strings.run.serviceText}`]);
  });

  it("keeps the service up once it is running, including while backgrounded", () => {
    // The whole point: going to the background is the normal working state, because the agent is
    // operating another app. Stopping there would recreate the bug this fixes.
    const state = fakeAppState("active");
    const native = fakeNative();
    const handle = startRunService({ native, appState: state.appState });

    state.push("background");
    state.push("inactive");
    state.push("active");

    expect(handle.started()).toBe(true);
    // Started exactly once — no churn on every state change.
    expect(native.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
    expect(native.calls).not.toContain("stop");
  });

  it("degrades quietly when the native module predates this JavaScript", () => {
    // A module without `startRunService` is an older build, not a broken one. It must not throw:
    // screen automation and everything else have to keep working.
    const state = fakeAppState("active");
    const errors: unknown[] = [];

    const handle = startRunService({
      native: {} as RunServiceNative,
      appState: state.appState,
      onError: (error) => errors.push(error),
    });

    expect(handle.started()).toBe(false);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/no startRunService/);
  });

  it("does not retry after a failed start, and does not throw", async () => {
    // Retrying on every state change would spam the log for a condition that will not improve
    // within a session. A failed start leaves the app exactly as it was before this change.
    const state = fakeAppState("active");
    const errors: unknown[] = [];
    const native: RunServiceNative = {
      startRunService: vi.fn().mockRejectedValue(new Error("ForegroundServiceStartNotAllowedException")),
    };

    startRunService({ native, appState: state.appState, onError: (error) => errors.push(error) });
    // The rejection travels through two microtasks: the native promise, then the `.catch`. Draining
    // the macrotask queue is the least brittle way to be sure it has arrived.
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.push("background");
    state.push("active");

    expect(native.startRunService).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it("stops only on dispose, never on backgrounding", () => {
    const state = fakeAppState("active");
    const native = fakeNative();
    const handle = startRunService({ native, appState: state.appState });

    state.push("background");
    expect(native.calls).not.toContain("stop");

    handle.dispose();

    expect(native.calls).toContain("stop");
    expect(state.removed).toBe(1);
  });

  it("is safe to dispose without ever having started", () => {
    const state = fakeAppState("background");
    const native = fakeNative();
    const handle = startRunService({ native, appState: state.appState });

    expect(() => handle.dispose()).not.toThrow();
    expect(native.calls).toEqual([]);
  });

  it("ignores a repeated dispose", () => {
    const state = fakeAppState("active");
    const native = fakeNative();
    const handle = startRunService({ native, appState: state.appState });

    handle.dispose();
    handle.dispose();

    expect(native.calls.filter((call) => call === "stop")).toHaveLength(1);
  });
});
