import type { ForegroundWindow } from "@mobileclaw/core";
import { packageMatches } from "./foreground";

/**
 * Asking whether a launch actually arrived, and reporting "could not tell" as its own answer.
 *
 * ## The gap this closes
 *
 * `system_open` returns as soon as the open call does. On Android that call resolving means
 * *the intent was handed to the system*, not that the app came to the front — the launch can be
 * blocked (Android 10+ restricts background activity starts), silently dropped, or land somewhere
 * other than expected. Until now the tool answered `{ ok: true }` either way, so the model's only
 * recourse was to read the screen and guess.
 *
 * That matters most for a launch that *resumes*: WeChat and NetEase Cloud Music both restore the
 * screen you last left them on, so "opened the app" and "arrived at the home screen" are different
 * facts. Reporting the activity is what lets a caller tell them apart.
 *
 * ## The rule that keeps it honest
 *
 * **A reading that cannot name a package is `unverified`, never `not-foreground`.** These are
 * different facts and only one of them is evidence:
 *
 *   * `"com.x"` when we expected `"com.y"` → the screen is readable and shows the wrong app.
 *     That is a real disagreement.
 *   * `undefined` → the device did not tell us. Treating that as "it did not open" would report a
 *     detection failure as an app failure, which is the same mistake `packageMatches` exists to
 *     avoid, and it would be wrong on exactly the ROMs where dumpsys does not name the window.
 *
 * So the outcome is a union rather than a boolean, and `unverified` carries whatever the probe did
 * return so the caller can see why.
 */

const ARRIVAL_POLL_MS = 250;
const ARRIVAL_TIMEOUT_MS = 5000;

/** What the arrival check concluded. */
export type ArrivalOutcome =
  | {
      /** The expected app is in the foreground. `activity` is its top screen, when readable. */
      arrived: true;
      package: string;
      activity?: string;
    }
  | {
      /** The screen was read, and it showed some other app. The launch did not land. */
      arrived: false;
      reason: "not-foreground";
      /** The app that was actually in front, when it could be named. */
      sawPackage?: string;
      sawActivity?: string;
    }
  | {
      /**
       * No usable reading. The launch may still have worked — this says the probe could not tell,
       * not that the app failed to open.
       */
      arrived: false;
      reason: "unverified";
      /** The raw probe output from the last attempt, so a miss is diagnosable. */
      raw?: string;
      detail: string;
    };

export interface ArrivalCheckOptions {
  /** The screen within the app that counts as arriving. Substring, like `screen_wait`. */
  activity?: string;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * Wait for `packageId` to reach the foreground, and say what the screen showed either way.
 *
 * Polls rather than reading once: a launch is asynchronous, and the first read usually happens
 * before the target has been drawn. The common case that already works costs one extra read.
 *
 * `readForeground` is injected instead of reached for, because this package must stay free of
 * platform code — the same reason `system_open` takes its opener as a dependency.
 */
export async function awaitArrival(
  packageId: string,
  readForeground: (() => Promise<ForegroundWindow>) | undefined,
  options: ArrivalCheckOptions = {},
  ctx: { signal?: AbortSignal } = {},
): Promise<ArrivalOutcome> {
  if (!readForeground) {
    return {
      arrived: false,
      reason: "unverified",
      detail:
        "this platform cannot report which app is in the foreground, so the launch was not checked",
    };
  }

  const timeoutMs = options.timeoutMs ?? ARRIVAL_TIMEOUT_MS;
  const pollMs = options.pollMs ?? ARRIVAL_POLL_MS;
  const signal = options.signal ?? ctx.signal;
  const deadline = Date.now() + timeoutMs;

  // The most informative reading seen. A result that named a package is worth more than one that
  // did not, and among those the last one is the closest to the truth.
  let lastUnreadable: ForegroundWindow | undefined;
  let sawPackage: string | undefined;
  let sawActivity: string | undefined;

  for (;;) {
    if (signal?.aborted) {
      return { arrived: false, reason: "unverified", detail: "the run was cancelled before the launch could be checked" };
    }

    let window: ForegroundWindow;
    try {
      window = await readForeground();
    } catch (error) {
      // A backend that throws is a backend that could not tell us. Not evidence about the launch.
      return {
        arrived: false,
        reason: "unverified",
        detail: `the foreground probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (window.package === undefined) {
      lastUnreadable = window;
    } else {
      sawPackage = window.package;
      sawActivity = window.activity;
      // `packageMatches` is reused rather than reimplemented: it already encodes "silence is not
      // disagreement", and the two callers must not drift apart on that.
      if (packageMatches(window.package, packageId)) {
        const activityOk =
          !options.activity || (window.activity ?? "").includes(options.activity);
        if (activityOk) {
          return { arrived: true, package: window.package, activity: window.activity };
        }
        // Right app, wrong screen. Keep waiting: a launch legitimately passes through other
        // screens before settling, so this is not yet a failure.
      }
    }

    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
  }

  if (sawPackage !== undefined) {
    return {
      arrived: false,
      reason: "not-foreground",
      sawPackage,
      sawActivity,
    };
  }

  return {
    arrived: false,
    reason: "unverified",
    raw: lastUnreadable?.raw,
    detail: options.activity
      ? `the device never named a foreground app, so it is unknown whether ${packageId} opened or reached ${options.activity}`
      : `the device never named a foreground app, so it is unknown whether ${packageId} opened`,
  };
}

/** Turn an outcome into the fields a tool returns, so the wording lives in one place. */
export function describeArrival(outcome: ArrivalOutcome, packageId: string): Record<string, unknown> {
  if (outcome.arrived) {
    return { verified: true, package: outcome.package, ...(outcome.activity ? { activity: outcome.activity } : {}) };
  }
  if (outcome.reason === "unverified") {
    return {
      verified: false,
      verifyNote:
        `could not confirm that ${packageId} came to the front — ${outcome.detail}. ` +
        "This is a detection failure, not proof the launch failed: do not report it as done, and do not retry blindly.",
      ...(outcome.raw ? { raw: outcome.raw } : {}),
    };
  }
  return {
    verified: false,
    verifyNote:
      `${packageId} was asked to open but the foreground app is ${outcome.sawPackage ?? "something else"}` +
      `${outcome.sawActivity ? ` (${outcome.sawActivity})` : ""}. The launch did not land.`,
    sawPackage: outcome.sawPackage,
    ...(outcome.sawActivity ? { sawActivity: outcome.sawActivity } : {}),
  };
}

/** Cancellable sleep: a parked arrival check must not outlive a cancelled run. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
