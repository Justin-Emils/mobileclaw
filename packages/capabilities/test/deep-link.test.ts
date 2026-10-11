import { describe, expect, it } from "vitest";
import type { ShellResult } from "@mobileclaw/core";
import {
  deepLinkCommand,
  interpretDeepLink,
  isOpenableUrl,
  urlRejection,
} from "../src/deep-link";

/**
 * Opening a deep link through the privileged shell.
 *
 * Two things are being pinned down here, and they fail in different ways.
 *
 * The first is **injection**. The URL is model-supplied, so if it ever reached a shell command line
 * a quote or a `;` would turn "open this link" into "run this other thing". The test that matters
 * asserts the URL is *not* in the command at all — not that it is escaped, because escaping is the
 * thing being avoided.
 *
 * The second is that **`am` reports failure on stdout and still exits 0**. Reading the exit code as
 * the verdict would call "no app can open this" a success, and the run would carry on acting on a
 * screen the link never reached.
 */

function shellResult(partial: Partial<ShellResult>): ShellResult {
  return {
    command: "am start",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    ...partial,
  };
}

describe("isOpenableUrl", () => {
  it("accepts a custom scheme, which is the whole point", () => {
    expect(isOpenableUrl("orpheus://")).toBe(true);
    expect(isOpenableUrl("orpheus://song/12345")).toBe(true);
    expect(isOpenableUrl("weixin://")).toBe(true);
  });

  it("accepts the ordinary schemes", () => {
    expect(isOpenableUrl("https://example.com/a?b=c")).toBe(true);
    expect(isOpenableUrl("mailto://a@b.c")).toBe(true);
  });

  it("rejects a bare package id, which is not a link", () => {
    // `system_open` has `packageId` for this. Passing a package id as a url used to be the mistake
    // that produced a chooser listing unrelated apps.
    expect(isOpenableUrl("com.tencent.mm")).toBe(false);
  });

  it("rejects a scheme with nothing after it and no slashes", () => {
    expect(isOpenableUrl("orpheus:")).toBe(false);
    expect(isOpenableUrl("orpheus:home")).toBe(false);
  });

  it("refuses a URL carrying a newline", () => {
    // A newline would end the line the value is read on, and the remainder would be executed as a
    // further command.
    expect(isOpenableUrl("orpheus://x\nam force-stop com.tencent.mm")).toBe(false);
  });

  it("refuses a URL carrying any control character", () => {
    expect(isOpenableUrl("orpheus://x\u0000rm -rf /")).toBe(false);
    expect(isOpenableUrl("orpheus://x\u0007")).toBe(false);
    expect(isOpenableUrl("orpheus://x\u007f")).toBe(false);
  });

  it("allows spaces inside a URL, since a quoted argument is one argument", () => {
    expect(isOpenableUrl("https://example.com/a b")).toBe(true);
  });
});

describe("urlRejection", () => {
  it("names the control-character problem specifically", () => {
    expect(urlRejection("orpheus://x\nrm -rf /")).toMatch(/control characters/);
  });

  it("points at packageId when the value is a package id", () => {
    // The actionable part: the model's likely intent was to open an app.
    expect(urlRejection("com.tencent.mm")).toMatch(/packageId/);
  });
});

describe("deepLinkCommand", () => {
  it("does not contain the URL — anywhere", () => {
    // The regression this file exists for. The URL is piped on stdin, so what an operator sees in a
    // command log is a constant, and the untrusted value never appears in a command line.
    const command = deepLinkCommand();
    expect(command).toContain("read -r url");
    expect(command).toContain('"$url"');
    // No literal placeholder that a naive implementation might have interpolated into.
    expect(command).not.toMatch(/orpheus|https?:/);
  });

  it("uses a VIEW intent", () => {
    expect(deepLinkCommand()).toContain("android.intent.action.VIEW");
  });
});

describe("interpretDeepLink", () => {
  it("reads a handover as opened", () => {
    const result = interpretDeepLink(
      shellResult({ stdout: "Starting: Intent { act=android.intent.action.VIEW dat=orpheus:// }" }),
      "orpheus://",
    );
    expect(result).toEqual({ opened: true, url: "orpheus://" });
  });

  it("reads 'Activity not found' as no-handler, even though the exit code is 0", () => {
    // This is the trap: `am` prints the error and exits 0. Going by the exit code alone would call
    // this a success.
    const result = interpretDeepLink(
      shellResult({ exitCode: 0, stdout: "Error: Activity not found" }),
      "nosuchscheme://x",
    );
    expect(result).toMatchObject({ opened: false, reason: "no-handler" });
  });

  it("reads 'unable to resolve Intent' as no-handler too", () => {
    // The other spelling, used by different Android releases.
    const result = interpretDeepLink(
      shellResult({ stdout: "Error: unable to resolve Intent { act=... }" }),
      "nosuchscheme://x",
    );
    expect(result).toMatchObject({ opened: false, reason: "no-handler" });
  });

  it("checks stderr as well as stdout", () => {
    const result = interpretDeepLink(
      shellResult({ stderr: "Error: Activity not found" }),
      "nosuchscheme://x",
    );
    expect(result).toMatchObject({ opened: false, reason: "no-handler" });
  });

  it("reports a non-zero exit with no recognisable output as failed", () => {
    const result = interpretDeepLink(shellResult({ exitCode: 1, stderr: "sh: am: not found" }), "orpheus://");
    expect(result).toMatchObject({ opened: false, reason: "failed" });
  });

  it("refuses to call an empty answer a success", () => {
    // Silence is not evidence. Claiming `opened` here is how a run ends up acting on a screen the
    // link never reached.
    const result = interpretDeepLink(shellResult({ stdout: "", stderr: "" }), "orpheus://");
    expect(result.opened).toBe(false);
    if (result.opened === false) expect(result.detail).toMatch(/unknown whether/i);
  });

  it("prefers the no-handler reading over a generic failure when both could match", () => {
    const result = interpretDeepLink(
      shellResult({ exitCode: 1, stdout: "Error: Activity not found" }),
      "nosuchscheme://x",
    );
    expect(result).toMatchObject({ reason: "no-handler" });
  });
});
