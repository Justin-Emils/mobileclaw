import type { ToolCallContext } from "@mobileclaw/core";

/**
 * Guards for screen actions, decided from what the screen itself says.
 *
 * ## What was here before, and why it was wrong
 *
 * An earlier version of this file asked whether **our own app** was in the foreground, and refused
 * to act (and aborted the run) when it was not. That is backwards. Our app is *supposed* to be
 * behind the conversation being written into — a phone shows one app at a time, and for this
 * project it has to be the target app. The check refused to work in the only situation the project
 * exists for, and its most visible effect was cancelling a run the moment the user switched to the
 * app they had just asked the agent to operate.
 *
 * It also rested on a claim that was too strong. Android does not freeze a backgrounded process
 * immediately; it enters the cached list and may be killed or frozen later, under memory pressure,
 * at a moment nobody can predict. So "the loop stops when you leave" is not a fact to build a
 * safety rule on — it is a risk, and one that cannot be observed from inside the app anyway.
 *
 * ## What the real question is
 *
 * A reading means nothing on its own. It means something only relative to **the app that published
 * it**: a screen full of the right name, read from the wrong app, is not evidence. So the guard that
 * matters compares the package a reading came from against the package the plan was made for.
 *
 * That comparison is stronger than the one it replaced, and it needs no knowledge of app state:
 * it is decided from the screen, at the moment of acting, by the same reading the action is about
 * to be taken on.
 */

/** What a caller knows about the screen it is acting on. */
export interface ScreenExpectation {
  /** The package the reading must have come from, when the caller knows it. */
  expectedPackage?: string;
}

/**
 * Does this reading come from the app the caller expected?
 *
 * **Silence is not disagreement.** A backend that cannot report a package returns `undefined`, and
 * that refuses nothing: "could not tell" is not "wrong", and treating it as wrong would take screen
 * automation away from every device whose reading cannot name its app. Only a *different* package
 * is a refusal, because only that is evidence of a mistake.
 */
export function packageMatches(
  actualPackage: string | undefined,
  expectedPackage: string | undefined,
): boolean {
  if (!expectedPackage || !actualPackage) return true;
  return actualPackage === expectedPackage;
}

/** What happened, in a form the tool layer can report without re-deriving it. */
export interface ForegroundVerdict {
  ok: boolean;
  /** Why it is not ok, phrased for the model. Only set when `ok` is false. */
  reason?: string;
}

/**
 * Should a screen action run right now?
 *
 * Cancellation only. It deliberately says nothing about which app is in front: that belongs to
 * `packageMatches`, which is decided from the screen rather than from our process's own state.
 *
 * `reason` matters more than it looks. It is the entire evidence the model has, and a model that
 * reads "failed" will retry the same call. It has to say *what to do instead*.
 */
export function screenActionAllowed(ctx: { signal?: AbortSignal }): ForegroundVerdict {
  if (ctx.signal?.aborted) {
    return { ok: false, reason: "the run was cancelled before this step could act" };
  }
  return { ok: true };
}

/** True when the host has reported that the run was cancelled. */
export function isCancelled(ctx: ToolCallContext): boolean {
  return ctx.signal?.aborted === true;
}

