/**
 * Defaults for screen capture and input, shared by the tool schemas and the platform
 * adapters.
 *
 * Declared once on purpose: both sides need the same numbers, and a silent drift
 * between "what a tool tells the model it will capture" and "what the adapter falls
 * back to" would surface only as an unexpected image size on a real device.
 */
export const SCREEN_DEFAULTS = {
  /**
   * Wide enough to read a phone screen, small enough that the JPEG stays far inside
   * the binder transaction limit when the shell process hands it back.
   */
  maxWidth: 720,
  /** Quality for a picture the model or the user is meant to look at. */
  quality: 70,
  /** Evidence shots are glanced at, not read: spend bytes on coverage, not fidelity. */
  evidenceQuality: 60,
  /** Fraction of the display a single scroll travels. */
  scrollFraction: 0.6,
  /**
   * Budget for what a screen reading may hand back to the model.
   *
   * A raw `uiautomator` dump of a busy screen runs to hundreds of kilobytes — it
   * carries every container, every layout flag and every node's drawing order, and
   * almost none of that is information. Measured against the ~4 characters per token
   * that English and CJK text average on the providers this app talks to, the numbers
   * below cap one reading at roughly 1.5k tokens. Whatever the budget cuts is
   * reported rather than dropped, because a silently truncated screen looks exactly
   * like a screen that really has fewer controls.
   */
  readMaxNodes: 6_000,
  readMaxChars: 6_000,
  readMaxTextLength: 200,
  /**
   * How long a dump may take before it is killed.
   *
   * Not a pessimistic guess: `uiautomator dump` blocks until the window is idle, and
   * on an animating screen it never becomes idle. This timeout is the difference
   * between "the screen could not be read" and a tool call that hangs until the agent
   * run is cancelled.
   */
  readTimeoutMs: 15_000,
} as const;
