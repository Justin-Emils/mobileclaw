import type { FileSystemService } from "@mobileclaw/core";

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

/**
 * Directories that virtually always contain something on a real phone.
 *
 * Every one of these must sit **inside the configured roots**, because the path guard
 * rejects anything else before the driver ever runs. An earlier version probed
 * `/storage/emulated/0` and `/sdcard` directly; the guard refused all four, the verdict
 * came out `unknown`, and the UI told a correctly-authorised user that access was
 * missing. Caught on a device, not by the unit tests, which used a filesystem with no
 * guard in front of it.
 */
const PROBE_DIRS = ["Download", "Documents", "DCIM", "Pictures", "Movies", "Music"] as const;

/** Name of the throwaway file used to settle the question. See `probeAllFilesAccess`. */
// Plain and dot-free on purpose: expo-file-system validates filenames and rejected
// ".mobileclaw-access-probe" and "mobileclaw-access-probe.tmp" with a create() error,
// which the probe then misread as a permission denial on an authorised device.
const PROBE_FILE_NAME = "mobileclaw_probe";

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
 * Shared-storage roots, as opposed to the app's own directories.
 *
 * The distinction is the whole point of the probe: an app-private directory
 * (`/data/user/0/<pkg>/files`) is always writable with no permission at all, so
 * probing one and calling the result "granted" reported success for an app that had
 * no shared-storage access whatsoever. Verified on a device by revoking access and
 * watching the banner stay hidden.
 */
function isSharedStorageRoot(path: string): boolean {
  // Anywhere under a shared volume counts, including a configured subdirectory such as
  // /storage/emulated/0/Download -- that is the common case. What must NOT count is an
  // app-private directory (/data/user/0/<pkg>/...), because those are always writable
  // and probing one reported success with all-files access revoked.
  return (
    path === "/sdcard" ||
    path.startsWith("/sdcard/") ||
    /^\/storage\/emulated\/\d+(\/|$)/.test(path) ||
    /^\/storage\/self(\/|$)/.test(path) ||
    // Removable volumes mount as /storage/XXXX-XXXX.
    /^\/storage\/[A-Za-z0-9_-]{4,}(\/|$)/.test(path)
  );
}

/** True for a shared-storage mount point that has the standard public subdirectories. */
function isTopLevelSharedRoot(path: string): boolean {
  const segments = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return segments.length <= 3;
}

/**
 * Decide whether all-files access is in effect, by writing then reading a file.
 *
 * Three earlier attempts were wrong, and each looked fine in unit tests:
 *
 *  1. Probing `/storage/emulated/0` and `/sdcard` directly. Those are outside the
 *     configured roots, so the path guard refused every probe, the verdict was always
 *     "cannot tell", and a correctly-authorised user was told access was missing.
 *  2. Inferring from "is this directory empty". A fresh phone's Download folder really
 *     is empty, so empty proves nothing and every new install was told it lacked
 *     permission.
 *  3. Probing *any* configured root, including the app-private ones. Those are always
 *     writable, so the probe answered "granted" even with all-files access revoked.
 *
 * Hence: a write/read round-trip, attempted only inside shared-storage roots. If none
 * are configured there is nothing to conclude, and saying so is better than guessing.
 */
export async function probeAllFilesAccess(
  fs: FileSystemService,
  roots: string[] = [],
): Promise<AllFilesAccessReport> {
  const sharedRoots = roots.filter((root) => isSharedStorageRoot(root));
  if (sharedRoots.length === 0) {
    return {
      status: "unknown",
      detail:
        "没有配置共享存储目录（如 /storage/emulated/0/Download），无法判断「所有文件访问」是否生效。",
    };
  }

  const candidates: string[] = [];
  for (const root of sharedRoots) {
    const base = root.replace(/\/+$/, "");
    // A top-level mount gets the standard public directories tried under it; a root that
    // already names a directory (`/storage/emulated/0/Download`) is probed as-is.
    //
    // Appending unconditionally produced `/storage/emulated/0/Download/Download`, which
    // does not exist, so every probe failed and an authorised device was reported as
    // denied. Caught by running it, not by the unit tests.
    if (isTopLevelSharedRoot(base)) {
      for (const dir of PROBE_DIRS) candidates.push(`${base}/${dir}`);
      // Some devices mount storage without the public folders; the mount point itself is
      // then the only thing left to try.
      candidates.push(base);
    } else {
      candidates.push(base);
    }
  }

  const evidence: string[] = [];
  let sawRefusal = false;

  // Diagnostic first pass: can the app create a file ANYWHERE its own roots allow?
  // If private storage also refuses, the problem is the file API, not the permission --
  // and reporting "denied" would send the user to Settings for nothing.
  for (const root of roots.filter((candidate) => !isSharedStorageRoot(candidate))) {
    const privatePath = `${root.replace(/\/+$/, "")}/${PROBE_FILE_NAME}`;
    try {
      await fs.write(privatePath, "ok");
      const readBack = await fs.read(privatePath);
      await fs.remove(privatePath).catch(() => undefined);
      evidence.push(`私有根可写(读回=${readBack === "ok" ? "ok" : "不符"})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      evidence.push(`私有根写入失败=${message.slice(0, 100)}`);
    }
    break;
  }

  for (const dir of candidates) {
    const probePath = `${dir}/${PROBE_FILE_NAME}`;
    try {
      await fs.write(probePath, "ok");
      const readBack = await fs.read(probePath);
      await fs.remove(probePath).catch(() => undefined);
      if (readBack === "ok") {
        return {
          status: "granted",
          detail: `${dir} 可写可读（探测文件已清理）`,
          probe: dir,
          entries: 1,
        };
      }
      evidence.push(`${dir}=写入后读回不符`);
      sawRefusal = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A guard refusal ("restricted to") means the path is not ours to probe at all;
      // a write/permission refusal inside a root is the real denial signature.
      if (/restricted to|escapes the allowed/.test(message)) {
        evidence.push(`${dir}=不在允许范围内`);
        continue;
      }
      evidence.push(`${dir}=${message.slice(0, 160)}`);
      sawRefusal = true;
    }
  }

  if (sawRefusal) {
    return {
      status: "denied",
      detail:
        `共享存储存在但写入/读取被拒（探测：${evidence.slice(0, 3).join("; ")}）。` +
        "这通常是「无所有文件访问权限」的表现。请在系统设置里为本应用开启「所有文件访问」。",
      entries: 0,
    };
  }
  return {
    status: "unknown",
    detail:
      `共享存储目录都不在可访问范围内（探测：${evidence.slice(0, 2).join("; ") || "无候选路径"}）。` +
      "这可能表示尚未授权，也可能是这些目录在此设备上不存在。",
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
