import type { DirEntry, FileSystemService } from "@mobileclaw/core";

/**
 * Android "all files access" (MANAGE_EXTERNAL_STORAGE) detection.
 *
 * There is no runtime dialog for this permission: `requestPermissions` cannot grant
 * it, and without it a scoped-storage app can still **see directory names** in shared
 * storage while every file inside reads as non-existent. That mismatch is what made
 * the agent report "these folders are empty" for folders that were full -- the
 * symptom looks like a scanning bug and is actually a permissions bug.
 *
 * The reliable way to tell the two apart is to test a directory that is never empty
 * on a real device. `Directory.list()` and `File.exists` simply report nothing when
 * access is denied, so an empty result is ambiguous; a directory that always has
 * entries is not.
 *
 * Deliberately free of Expo/React Native imports so it stays unit-testable on Node
 * (see vitest.config.ts). The part that must run on a device -- opening the system
 * settings screen -- lives in `settings-launcher.ts`.
 */

/** Directories that virtually always contain something on a real phone. */
const PROBE_PATHS = [
  "/storage/emulated/0/Android/data",
  "/storage/emulated/0/Android/media",
  "/storage/emulated/0",
  "/sdcard",
] as const;

/** The legacy permissions that gate shared storage up to Android 12L (API 32). */
export const LEGACY_STORAGE_PERMISSIONS = [
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
] as const;

/**
 * Which legacy permissions are worth asking for on a given API level.
 *
 * Pure so the version gating is testable without a device. Android 13+ (API 33)
 * replaced these with the granular READ_MEDIA_* permissions and no longer grants
 * them, so prompting there would show nothing and look broken. Kept next to the
 * detection logic because the two are read together: one says whether access is
 * missing, the other what to do about it.
 */
export function legacyStoragePermissionsFor(apiLevel: number): string[] {
  return apiLevel <= 32 ? [...LEGACY_STORAGE_PERMISSIONS] : [];
}

export type AllFilesAccess = "granted" | "denied" | "unknown";

export interface AllFilesAccessReport {
  status: AllFilesAccess;
  /** Human-readable detail, safe to show in the diagnostics panel. */
  detail: string;
  /** The probe that produced the verdict, for debugging. */
  probe?: string;
  /** How many entries the probe directory returned. */
  entries?: number;
}

/**
 * Decide whether all-files access is in effect by probing real directories.
 *
 * READ_EXTERNAL_STORAGE alone is enough for `/storage/emulated/0` to list its own
 * top level on some Android versions, so the verdict requires at least one probe
 * directory to come back non-empty. "Everything is empty" on a phone that certainly
 * has files is the denial signature.
 */
export async function probeAllFilesAccess(fs: FileSystemService): Promise<AllFilesAccessReport> {
  let anyReachable = false;
  const failures: string[] = [];

  for (const path of PROBE_PATHS) {
    let entries: DirEntry[];
    try {
      entries = await fs.list(path);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    anyReachable = true;
    if (entries.length > 0) {
      return {
        status: "granted",
        detail: `${path} 可读（${entries.length} 项）`,
        probe: path,
        entries: entries.length,
      };
    }
  }

  if (anyReachable) {
    return {
      status: "denied",
      detail:
        "共享存储目录可列名但内容全部读不到，这正是「无所有文件访问权限」的表现。请在系统设置里为本应用开启「所有文件访问」。",
      probe: PROBE_PATHS[0],
      entries: 0,
    };
  }
  return {
    status: "unknown",
    detail: `无法探测共享存储：${failures.slice(0, 2).join("; ") || "全部探针都失败"}`,
  };
}

/**
 * The environment note handed to the model.
 *
 * The agent's judgement depends on this: without it, "no files found" leads it to
 * conclude the folders are empty and to stop, rather than telling the user to grant
 * access.
 */
export function describeStorageAccess(report: AllFilesAccessReport): string {
  switch (report.status) {
    case "granted":
      return "Shared storage: readable (all-files access granted).";
    case "denied":
      return [
        "Shared storage: NOT readable. The app lacks Android's all-files access, so",
        "directories appear to exist but list as empty and files read as non-existent.",
        "Do not report such folders as empty. Tell the user to enable",
        '"All files access" for this app in system settings, and that you can open the page for them.',
      ].join(" ");
    default:
      return "Shared storage: access could not be determined.";
  }
}
