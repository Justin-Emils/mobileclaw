import { describe, expect, it } from "vitest";
import { describeStorageAccess, type AllFilesAccessReport } from "@/runtime/services/permissions";

/**
 * This text goes into the system prompt, and it is the difference between the agent
 * reporting a finding and inventing one.
 *
 * The original bug was not only that shared storage was unreadable -- it is that the
 * model, seeing empty listings, concluded "these folders are empty" and said so. Nothing
 * in the prompt contradicted that. The wording is therefore load-bearing: it has to state
 * the situation, forbid the wrong conclusion, and say what to do instead.
 *
 * These assertions pin the properties that matter, not the exact prose, so the wording
 * can still be improved without rewriting the tests.
 */

const granted: AllFilesAccessReport = { status: "granted", detail: "ok" };
const denied: AllFilesAccessReport = { status: "denied", detail: "写入被拒" };
const unknown: AllFilesAccessReport = { status: "unknown", detail: "无法判断" };

describe("describeStorageAccess", () => {
  it("forbids calling such folders empty when access is missing", () => {
    const text = describeStorageAccess(denied);
    // The exact wrong conclusion the agent reached before, now explicitly ruled out.
    expect(text).toMatch(/[Dd]o not report such folders as empty/);
  });

  it("explains what the missing access looks like, so the model can recognise it", () => {
    // Without this the model has no way to connect "empty listing" to "no permission".
    const text = describeStorageAccess(denied);
    expect(text).toMatch(/list as empty/);
    expect(text).toMatch(/non-existent/);
  });

  it("tells the model what to ask the user for", () => {
    const text = describeStorageAccess(denied);
    expect(text).toMatch(/[Aa]ll files access/);
    expect(text).toMatch(/system settings/);
  });

  it("does not claim a problem when access is granted", () => {
    // A false alarm here would make the model refuse to work on readable storage.
    const text = describeStorageAccess(granted);
    expect(text).toMatch(/readable/);
    expect(text).not.toMatch(/NOT readable/);
    expect(text).not.toMatch(/[Dd]o not report/);
  });

  it("says it cannot tell rather than guessing, when the probe is inconclusive", () => {
    // "unknown" must not be presented as either answer; claiming denial would send the
    // user to settings for nothing.
    const text = describeStorageAccess(unknown);
    expect(text).toMatch(/could not be determined/);
    expect(text).not.toMatch(/[Dd]o not report/);
  });

  it("is a single line so it does not break the Environment block layout", () => {
    // The prompt appends this to a `## Environment` section; embedded newlines made the
    // following lines render as part of the same bullet.
    for (const report of [granted, denied, unknown]) {
      expect(describeStorageAccess(report)).not.toContain("\n");
    }
  });

  it("ignores the detail field, which is for the UI rather than the model", () => {
    // `detail` carries Chinese diagnostics aimed at the user; the prompt text is English
    // and stable, so a change to the UI wording cannot leak into the prompt.
    const withFancyDetail: AllFilesAccessReport = { status: "denied", detail: "任意中文说明" };
    expect(describeStorageAccess(withFancyDetail)).toBe(describeStorageAccess(denied));
  });
});
