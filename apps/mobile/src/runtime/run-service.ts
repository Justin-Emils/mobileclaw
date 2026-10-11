import { strings } from "@/ui/strings";

/**
 * Keeping the process alive while the agent works in another app.
 *
 * ## The problem this solves
 *
 * A run is driven by a JavaScript loop **in this process**. Operating another app necessarily puts
 * this one in the background — a phone shows one app at a time — and Android freezes background
 * processes. A freeze does not slow the loop down or fail a step: it stops it **silently, between
 * two tool calls**, which is what the user described as "after opening the app it just hangs".
 *
 * `FLAG_KEEP_SCREEN_ON` (see `foreground.ts`) does not help. It keeps the *display* awake, which is
 * a different mechanism from keeping the *process* alive.
 *
 * ## The one rule that shapes this file
 *
 * **Android 12+ refuses to start a foreground service from the background.** Starting one when a
 * run begins is exactly that call — the agent has already switched away by then — so it throws
 * `ForegroundServiceStartNotAllowedException` and the naive implementation fails at precisely the
 * moment it is needed.
 *
 * So the service is started **once, while this app is visible**, and then left running. Its
 * notification is not a leak or a workaround; it is the contract of a foreground service, which the
 * system requires the user to be able to see.
 *
 * ## What is injected, and why
 *
 * Both the native module and the app-state subscription are injected so the decision logic — the
 * part that is easy to get wrong, and the part that cannot be exercised on a device in a unit test
 * — is testable on Node. This mirrors `native-files.ts` and `native-shizuku.ts`.
 */

/** The slice of `react-native`'s `AppState` this needs. */
export interface AppStateLike {
  currentState: string | null;
  addEventListener(type: "change", handler: (state: string) => void): { remove(): void };
}

/** The slice of the native module this needs. Both are optional for older native modules. */
export interface RunServiceNative {
  startRunService?(text: string): Promise<boolean>;
  stopRunService?(): Promise<boolean>;
}

export interface RunServiceHandle {
  /** Whether the service is meant to be up. Useful for the self-check and for tests. */
  started(): boolean;
  /** Stop it, if it was started. Call on teardown only. */
  dispose(): void;
}

/**
 * Start the service if the app is currently on screen, and keep it up.
 *
 * Returns a handle rather than a promise: the start is fire-and-forget, because a foreground
 * service that will not start degrades the run and must not prevent it. A failure is logged and
 * otherwise ignored — the previous behaviour (no service at all) is exactly the fallback.
 */
export function startRunService(options: {
  native: RunServiceNative | undefined;
  appState: AppStateLike;
  /** Called when the service could not be started, for the log. */
  onError?: (error: unknown) => void;
}): RunServiceHandle {
  const { native, appState, onError } = options;
  let up = false;

  const attemptStart = (reason: string) => {
    if (up) return;
    // A native module older than this JavaScript has no such method. That is a degraded build, not
    // a broken one, so it is reported and skipped rather than thrown.
    if (typeof native?.startRunService !== "function") {
      onError?.(new Error(`no startRunService in the native module (${reason})`));
      return;
    }
    up = true;
    void native
      .startRunService(strings.run.serviceText)
      .then(() => undefined)
      .catch((error: unknown) => {
        // Left as `up = true`: retrying on every state change would spam the log, and the next
        // cold start is a better place to try again than a loop.
        onError?.(error);
      });
  };

  // Start now if the app is on screen. This is the path that matters: it is the only moment a
  // foreground service may be started, so waiting for a state *change* would miss the common case
  // of the app already being visible at launch.
  if (appState.currentState === "active") {
    attemptStart("already active");
  }

  const subscription = appState.addEventListener("change", (state) => {
    // Any transition back to `active` means this app is visible and the service may be started.
    // Once up it stays up — including across `background`, which is the entire point.
    if (state === "active") attemptStart("became active");
  });

  return {
    started: () => up,
    dispose() {
      subscription.remove();
      if (!up) return;
      up = false;
      void native?.stopRunService?.()?.catch((error: unknown) => onError?.(error));
    },
  };
}
