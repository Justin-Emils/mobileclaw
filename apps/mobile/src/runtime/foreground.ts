/**
 * Holding the display awake for the length of a run.
 *
 * The agent loop is JavaScript in this app, so the run only progresses while the process does. The
 * one part of that this app can influence is the display: **the screen is the thing being
 * automated**, so a display that sleeps ends the run for a reason that has nothing to do with the
 * task — and it does so silently, between a tool returning and the model being asked what to do
 * next.
 *
 * ## What used to be here, and why it is gone
 *
 * This file also watched `AppState` and aborted the run when the app left the foreground. That was
 * wrong, and the reasoning is kept in `isGoneFromScreen` below so it does not get rewritten:
 * **this app is meant to be behind the app it is operating.** A phone shows one app at a time, so
 * the state the guard treated as failure is the normal working state, and its only visible effect
 * was cancelling a run as soon as the user switched to the conversation they had just asked the
 * agent to open.
 *
 * What protects the irreversible step instead is the package check in `screen_send_message`
 * (`packages/capabilities`): the final reading must have come from the app the caller named. That
 * is decided from the screen, at the moment of pressing, rather than from our own process's state.
 *
 * The risk the old guard gestured at is real — a backgrounded process can be frozen or killed under
 * memory pressure, at a moment nobody can predict — but stopping early does not fix it. A
 * foreground service would; it is written up as a fallback in `docs/runtime-prerequisites.md` and
 * deliberately not built yet.
 */

export interface RunKeepAwake {
  /** Hold the display awake until `release`. Refcounted, so overlapping calls are safe. */
  acquire(): void;
  release(): void;
  /** For the self-check: whether a run is currently holding the display. */
  held(): boolean;
}

/**
 * Holds the display awake through the platform module, not a new dependency.
 *
 * The project already ships a native module for the things a privileged app must do in Kotlin, and
 * this is one of them: `FLAG_KEEP_SCREEN_ON` needs no permission, and the system releases it when
 * the app leaves the foreground — which is exactly the lifetime wanted, since a run stops being
 * meaningful then anyway. Reaching for a package instead would add an implicit dependency on a
 * module nothing declares.
 *
 * Every call is guarded. A display that will not stay awake degrades the run; it must not end it.
 */
export function createRunKeepAwake(
  native: { keepScreenOn?(on: boolean): Promise<unknown> } | undefined,
): RunKeepAwake {
  let count = 0;

  const apply = (on: boolean) => {
    try {
      void native?.keepScreenOn?.(on)?.catch(() => {
        // Nothing to do about it, and nothing to tell the user: the run proceeds either way.
      });
    } catch {
      // A synchronous throw from a missing or broken native method is the same non-event.
    }
  };

  return {
    acquire() {
      count += 1;
      if (count === 1) apply(true);
    },
    release() {
      count = Math.max(0, count - 1);
      if (count === 0) apply(false);
    },
    held() {
      return count > 0;
    },
  };
}

/**
 * Whether a given `AppState` value means the app is genuinely gone from the screen.
 *
 * **Only `"background"` counts, and `"inactive"` deliberately does not.** `inactive` is what the
 * platform reports during a transition or while something is overlaid on the app without replacing
 * it — the notification shade pulled down, a system dialog, an incoming call banner, the app
 * switcher mid-gesture. The app is still on screen and still the thing the user is looking at in
 * all of those, and Android has not frozen the process either.
 *
 * Treating it as "gone" would have two costs, and the second is worse than the first: a run would
 * be cancelled for pulling down the notification shade, and — because the run's *own approval
 * prompts* are a system-drawn overlay — a confirmation could cancel the very run it was asked
 * about. A rule that fires on the user's own UI is not a safety rule.
 */
export function isGoneFromScreen(state: string): boolean {
  return state === "background";
}
