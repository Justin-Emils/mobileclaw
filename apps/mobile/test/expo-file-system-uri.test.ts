import { describe, expect, it } from "vitest";
import { pathToUri, uriToPath } from "@/runtime/services/expo-file-system";

/**
 * Small functions, but the shape of a `file://` URI for a local absolute path is easy
 * to get wrong and the failure mode is misleading: Android's `Uri.parse` reads the
 * first segment as the *host*, so a malformed URI leaves `getPath()` null and the
 * native layer throws, which can look like a permission problem.
 *
 * A correct URI has **three** slashes: scheme, empty authority, then the path.
 *
 * Note: these functions were briefly suspected of causing the shared-storage write
 * failure observed on the emulator. They were not — `encodeURIComponent("")` is `""`,
 * so the leading slash was always handled correctly. The tests stay because the
 * behaviour matters, not because it was ever broken.
 */

describe("pathToUri", () => {
  it("produces an empty authority, which Android requires", () => {
    const uri = pathToUri("/storage/emulated/0/Download/a.txt");
    expect(uri).toBe("file:///storage/emulated/0/Download/a.txt");
    // Everything between "file://" and the first "/" is the host and must be empty.
    expect(uri.slice("file://".length).split("/")[0]).toBe("");
  });

  it("keeps app-private paths intact", () => {
    expect(pathToUri("/data/user/0/dev.mobileclaw.app/files/x")).toBe(
      "file:///data/user/0/dev.mobileclaw.app/files/x",
    );
  });

  it("encodes characters that would otherwise break the URI", () => {
    const uri = pathToUri("/storage/emulated/0/我的 文件/报告 (1).pdf");
    expect(uri.startsWith("file:///storage/emulated/0/")).toBe(true);
    expect(uri).toContain("%20");
    expect(uri).not.toContain(" ");
    // Still no accidental host.
    expect(uri.slice("file://".length).split("/")[0]).toBe("");
  });

  it("leaves an already-schemed URI alone", () => {
    expect(pathToUri("file:///a/b")).toBe("file:///a/b");
  });
});

describe("uriToPath", () => {
  it("round-trips every path shape the app uses", () => {
    const paths = [
      "/storage/emulated/0/Download/a.txt",
      "/data/user/0/dev.mobileclaw.app/files/Download/x",
      "/storage/emulated/0/我的 文件/报告 (1).pdf",
      "/sdcard",
      "/storage/emulated/0/Download/workspaces/conv-1/out.csv",
    ];
    for (const path of paths) {
      expect(uriToPath(pathToUri(path))).toBe(path);
    }
  });

  it("recovers a usable absolute path from the malformed host form", () => {
    // Defensive: an encoded leading separator (or a host mistaken for a path segment)
    // must still yield an absolute path rather than a host-relative one.
    expect(uriToPath("file://%2Fstorage/emulated/0/a.txt")).toBe("/storage/emulated/0/a.txt");
  });

  it("tolerates a host that was mistaken for a path segment", () => {
    expect(uriToPath("file://storage/emulated/0/a.txt")).toBe("/storage/emulated/0/a.txt");
  });

  it("passes through anything without the scheme", () => {
    expect(uriToPath("/already/a/path")).toBe("/already/a/path");
  });
});
