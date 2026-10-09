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
} as const;
