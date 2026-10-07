import { describe, expect, it, vi } from "vitest";
import type { DirEntry, FileSystemService } from "@mobileclaw/core";
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
 */

function entry(path: string, isDirectory: boolean): DirEntry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    relative: path,
    size: 0,
    isDirectory,
    isFile: !isDirectory,
    mtimeMs: 0,
  };
}

/**
 * Only `list` is exercised; the probe never touches the rest of the interface.
 * A plain wrapper keeps the cast in one place instead of a double assertion per
 * factory, which the bundler's parser rejects.
 */
function asFs(list: (path: string) => Promise<DirEntry[]>): FileSystemService {
  return { list } as FileSystemService;
}

/** A filesystem whose shared-storage listings are empty, as when access is denied. */
function emptyListings(): FileSystemService {
  return asFs(vi.fn(async () => [] as DirEntry[]));
}

function readableListings(): FileSystemService {
  return asFs(
    vi.fn(async (path: string) => {
      if (path === "/storage/emulated/0/Android/data") {
        return [entry("/storage/emulated/0/Android/data/com.example", true)];
      }
      return [] as DirEntry[];
    }),
  );
}

function unreachable(): FileSystemService {
  return asFs(
    vi.fn(async () => {
      throw new Error("E_ACCES");
    }),
  );
}

describe("probeAllFilesAccess", () => {
  it("reports granted when a probe directory is non-empty", async () => {
    const report = await probeAllFilesAccess(readableListings());
    expect(report.status).toBe("granted");
    expect(report.probe).toBe("/storage/emulated/0/Android/data");
    expect(report.entries).toBe(1);
  });

  it("reports denied when directories are listable but always empty", async () => {
    // This is the scoped-storage signature: names resolve, contents do not.
    const report = await probeAllFilesAccess(emptyListings());
    expect(report.status).toBe("denied");
    expect(report.detail).toContain("所有文件访问");
  });

  it("reports unknown when every probe throws", async () => {
    const report = await probeAllFilesAccess(unreachable());
    expect(report.status).toBe("unknown");
    expect(report.detail).toContain("无法探测");
  });

  it("accepts a later probe directory when earlier ones are empty", async () => {
    const fs = asFs(
      vi.fn(async (path: string) => {
        if (path === "/storage/emulated/0") return [entry("/storage/emulated/0/Download", true)];
        return [] as DirEntry[];
      }),
    );
    const report = await probeAllFilesAccess(fs);
    expect(report.status).toBe("granted");
    expect(report.probe).toBe("/storage/emulated/0");
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
