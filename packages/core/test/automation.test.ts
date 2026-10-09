import { describe, expect, it } from "vitest";
import { SCREEN_DEFAULTS } from "@mobileclaw/core";

/**
 * `SCREEN_DEFAULTS` is the single source for the numbers the tool schemas and the
 * platform adapter both read. A drift here would surface only as an unexpected image
 * size (or a scroll that goes nowhere) on a device, so the invariants are pinned.
 */
describe("SCREEN_DEFAULTS", () => {
  it("describes a usable capture size", () => {
    expect(Number.isInteger(SCREEN_DEFAULTS.maxWidth)).toBe(true);
    expect(SCREEN_DEFAULTS.maxWidth).toBeGreaterThan(0);
  });

  it("keeps quality as a whole percentage in range", () => {
    expect(Number.isInteger(SCREEN_DEFAULTS.quality)).toBe(true);
    expect(SCREEN_DEFAULTS.quality).toBeGreaterThan(0);
    expect(SCREEN_DEFAULTS.quality).toBeLessThanOrEqual(100);
  });

  it("spends fewer bytes on evidence than on a picture someone will read", () => {
    // The comment on the field is a promise: evidence shots are glanced at, so they
    // must not be more expensive than the quality the model or user is shown.
    expect(SCREEN_DEFAULTS.evidenceQuality).toBeGreaterThan(0);
    expect(SCREEN_DEFAULTS.evidenceQuality).toBeLessThanOrEqual(SCREEN_DEFAULTS.quality);
  });

  it("expresses a scroll as a fraction of the display", () => {
    expect(SCREEN_DEFAULTS.scrollFraction).toBeGreaterThan(0);
    expect(SCREEN_DEFAULTS.scrollFraction).toBeLessThanOrEqual(1);
  });
});
