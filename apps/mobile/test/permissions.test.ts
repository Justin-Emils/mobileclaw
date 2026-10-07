import { describe, expect, it, vi } from "vitest";
import type { FileSystemService } from "@mobileclaw/core";
import {
  describeStorageAccess,
  legacyStoragePermissionsFor,
  probeAllFilesAccess,
  type AllFilesAccessReport,
} from "@/runtime/services/permissions";

/**
 * The behaviour under test is the distinction the agent depends on:
 * "this directory is empty" versus "I am not allowed to look inside".
 * On Android both surface as an empty listing, and getting it wrong made the agent
 * report full folders as empty.
 *
 * The probe settles it with a write/read round-trip rather than by counting entries,
 * because a fresh phone's Download folder is genuinely empty -- an earlier
 * entry-counting version told correctly-authorised users they had no access. It also
 * has to stay inside the configured roots, since the path guard rejects anything else;
 * probing `/storage/emulated/0` directly made the verdict permanently "unknown" on a
 * device.
 */

interface FakeFs {
  fs: FileSystemService;
  files: Map<string, string>;
  /** Paths the guard refuses, i.e. outside the roots. */
  restricted: (path: string) => boolean;
}

function fakeFs(options: {
  roots: string[];
  restrictAll?: boolean;
  /** Which writes fail: only those under this prefix, or every write. */
  failWrite?: "all" | string;
}): FakeFs {
  const files = new Map<string, string>();
  const restricted = (path: string): boolean => {
    if (options.restrictAll) return true;
    return !options.roots.some((root) => path === root || path.startsWith(`${root.replace(/\/+$/, "")}/`));
  };
  const guard = (path: string): void => {
    if (restricted(path)) {
      throw new Error(`read is restricted to: ${options.roots.join(", ")}`);
    }
  };
  const writeFails = (path: string): boolean => {
    if (options.failWrite === undefined) return false;
    if (options.failWrite === "all") return true;
    return path.startsWith(options.failWrite);
  };
  const fs = {
    async read(path: string) {
      guard(path);
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    async write(path: string, data: string | Uint8Array) {
      guard(path);
      // A directory that exists but refuses writes is the denial signature.
      if (writeFails(path)) throw new Error("EACCES: permission denied");
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      files.set(path, text);
      return { path, name: path.split("/").pop() ?? path, size: text.length, isDirectory: false, isFile: true };
    },
    async remove(path: string) {
      guard(path);
      files.delete(path);
    },
    async list() {
      return [];
    },
  } as unknown as FileSystemService;
  return { fs, files, restricted };
}

const SHARED_ROOT = "/storage/emulated/0";
const PRIVATE_ROOT = "/data/user/0/dev.mobileclaw.app/files";
const ROOTS = [PRIVATE_ROOT, `${SHARED_ROOT}/Download`];
const SHARED_ONLY_ROOTS = [`${SHARED_ROOT}/Download`, `${SHARED_ROOT}/Documents`];

describe("probeAllFilesAccess", () => {
  it("reports granted when a probe file round-trips inside a shared root", async () => {
    const { fs, files } = fakeFs({ roots: ROOTS });
    const report = await probeAllFilesAccess(fs, ROOTS);
    expect(report.status).toBe("granted");
    expect(report.probe?.startsWith(SHARED_ROOT)).toBe(true);
    // The probe must not leave litter behind in the user's storage.
    expect(files.size).toBe(0);
  });

  it("reports denied when shared writes are refused but private writes work", async () => {
    // The denial signature needs a control: if the app can write its own directory, the
    // file API works and the refusal really is about shared-storage permission. Without
    // the control there is nothing to conclude, which the next case covers.
    const { fs } = fakeFs({ roots: ROOTS, failWrite: SHARED_ROOT });
    const report = await probeAllFilesAccess(fs, ROOTS);
    expect(report.status).toBe("denied");
    expect(report.detail).toContain("所有文件访问");
  });

  it("concludes nothing when both shared and private writes fail", async () => {
    // Telling a user to grant a storage permission would be wrong here: something else
    // is broken. Found on an emulator, where shared writes failed even with the
    // permission granted.
    const { fs } = fakeFs({ roots: ROOTS, failWrite: "all" });
    const report = await probeAllFilesAccess(fs, ROOTS);
    expect(report.status).toBe("unknown");
    expect(report.detail).toContain("不像是权限问题");
  });

  it("reports unknown when every candidate is outside the roots", async () => {
    // The bug caught on a device: the guard refuses the probe, which says nothing about
    // the permission. Reporting "denied" here told an authorised user to go and grant.
    const { fs } = fakeFs({ roots: SHARED_ONLY_ROOTS, restrictAll: true });
    const report = await probeAllFilesAccess(fs, SHARED_ONLY_ROOTS);
    expect(report.status).toBe("unknown");
    expect(report.detail).toContain("共享存储目录都不在可访问范围内");
  });

  it("never concludes 'granted' from an app-private root", async () => {
    // The second device-caught bug: private directories are always writable with no
    // permission, so probing one reported success with all-files access revoked and the
    // warning banner stayed hidden.
    const { fs } = fakeFs({ roots: [PRIVATE_ROOT] });
    const report = await probeAllFilesAccess(fs, [PRIVATE_ROOT]);
    expect(report.status).toBe("unknown");
    expect(report.detail).toContain("没有配置共享存储目录");
  });

  it("reports unknown rather than denied when no shared root is configured at all", async () => {
    // Nothing to conclude is the honest answer; "denied" would send the user to settings
    // for a permission that is not the problem.
    const { fs } = fakeFs({ roots: [PRIVATE_ROOT] });
    expect((await probeAllFilesAccess(fs, [])).status).toBe("unknown");
    expect((await probeAllFilesAccess(fs, [PRIVATE_ROOT])).status).toBe("unknown");
  });

  it("stays inside the roots it was given", async () => {
    // Guards the regression directly: no candidate may be a path the guard would reject.
    const { fs } = fakeFs({ roots: SHARED_ONLY_ROOTS });
    const tried: string[] = [];
    const spy = {
      ...fs,
      write: async (path: string, data: string | Uint8Array) => {
        tried.push(path);
        return fs.write(path, data);
      },
    } as unknown as FileSystemService;
    await probeAllFilesAccess(spy, SHARED_ONLY_ROOTS);
    expect(tried.length).toBeGreaterThan(0);
    for (const path of tried) {
      expect(SHARED_ONLY_ROOTS.some((root) => path.startsWith(root))).toBe(true);
    }
  });

  it("accepts a bare shared root, where subdirectories may not exist", async () => {
    const roots = ["/sdcard"];
    const { fs, files } = fakeFs({ roots });
    const report = await probeAllFilesAccess(fs, roots);
    expect(report.status).toBe("granted");
    expect(files.size).toBe(0);
  });

  it("does not treat an empty but writable shared directory as a permission problem", async () => {
    // A brand new phone has an empty Download folder; that is not a denial.
    const { fs } = fakeFs({ roots: ["/storage/emulated/0/Download"] });
    const report = await probeAllFilesAccess(fs, ["/storage/emulated/0/Download"]);
    expect(report.status).toBe("granted");
  });
});

describe("legacyStoragePermissionsFor", () => {
  // Declaring a permission in the manifest does not grant it; on Android 12 and below
  // these two are what actually gate reading a file in shared storage, and nothing
  // requested them until now.
  it("asks for both legacy permissions up to Android 12L", () => {
    expect(legacyStoragePermissionsFor(29)).toEqual([
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
    ]);
    expect(legacyStoragePermissionsFor(30)).toHaveLength(2);
    expect(legacyStoragePermissionsFor(32)).toHaveLength(2);
  });

  it("asks for nothing on Android 13 and later", () => {
    // API 33 replaced them with READ_MEDIA_*; prompting would show no dialog at all
    // and the attempt would look like a silent failure.
    expect(legacyStoragePermissionsFor(33)).toEqual([]);
    expect(legacyStoragePermissionsFor(34)).toEqual([]);
    expect(legacyStoragePermissionsFor(36)).toEqual([]);
  });

  it("still asks on ancient releases, where the permissions existed", () => {
    expect(legacyStoragePermissionsFor(23)).toHaveLength(2);
    expect(legacyStoragePermissionsFor(0)).toHaveLength(2);
  });
});

describe("describeStorageAccess", () => {
  it("tells the model not to call such folders empty", () => {
    const text = describeStorageAccess({ status: "denied", detail: "" });
    expect(text).toMatch(/NOT readable/);
    expect(text).toMatch(/Do not report such folders as empty/);
  });

  it("keeps the granted case short", () => {
    const text = describeStorageAccess({ status: "granted", detail: "" });
    expect(text).toContain("all-files access granted");
    expect(text).not.toMatch(/NOT readable/);
  });

  it("says so when it cannot tell", () => {
    const report: AllFilesAccessReport = { status: "unknown", detail: "" };
    expect(describeStorageAccess(report)).toContain("could not be determined");
  });
});
