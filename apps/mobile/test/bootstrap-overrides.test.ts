import { describe, expect, it } from "vitest";
import { readTestOverrides } from "@/runtime/bootstrap";

/**
 * These overrides exist so a real agent turn can be driven on an emulator without a
 * cloud key: `adb shell input text` proved too lossy for the settings screen, so the
 * endpoint is baked in at bundle time instead.
 *
 * The risk being guarded is the other direction -- a throwaway endpoint (or a key)
 * quietly surviving into a build. Hence the tests below: a production bundle must get
 * nothing back, and blank values must not count as "set".
 */

const ALL = {
  MOBILECLAW_TEST_BASE_URL: "http://10.0.2.2:8787/v1",
  MOBILECLAW_TEST_MODEL: "mock-model",
  MOBILECLAW_TEST_API_KEY: "sk-mock",
};

describe("readTestOverrides", () => {
  it("returns nothing in a production build, even when the variables are set", () => {
    // This is what keeps a baked-in endpoint out of anything shipped.
    expect(readTestOverrides(ALL, false)).toEqual({});
  });

  it("returns nothing when there is no environment", () => {
    expect(readTestOverrides(undefined, true)).toEqual({});
  });

  it("passes through all three values in a dev build", () => {
    expect(readTestOverrides(ALL, true)).toEqual({
      baseUrl: "http://10.0.2.2:8787/v1",
      model: "mock-model",
      apiKey: "sk-mock",
    });
  });

  it("treats blank and whitespace-only values as unset", () => {
    // An env var set to "" is common in scripts and must not override a real preset.
    expect(readTestOverrides({ ...ALL, MOBILECLAW_TEST_MODEL: "" }, true)).not.toHaveProperty("model");
    expect(readTestOverrides({ ...ALL, MOBILECLAW_TEST_MODEL: "   " }, true)).not.toHaveProperty("model");
    expect(readTestOverrides({ MOBILECLAW_TEST_MODEL: "" }, true)).toEqual({});
  });

  it("trims surrounding whitespace", () => {
    expect(readTestOverrides({ MOBILECLAW_TEST_BASE_URL: "  http://x/v1  " }, true)).toEqual({
      baseUrl: "http://x/v1",
    });
  });

  it("allows setting only one of the three", () => {
    expect(readTestOverrides({ MOBILECLAW_TEST_MODEL: "m" }, true)).toEqual({ model: "m" });
    expect(readTestOverrides({ MOBILECLAW_TEST_API_KEY: "k" }, true)).toEqual({ apiKey: "k" });
  });

  it("ignores unrelated variables", () => {
    expect(readTestOverrides({ PATH: "/usr/bin", HOME: "/root" }, true)).toEqual({});
  });
});
