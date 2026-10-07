import { Platform, PermissionsAndroid, type Permission } from "react-native";
import { legacyStoragePermissionsFor } from "./permissions";

export { legacyStoragePermissionsFor, LEGACY_STORAGE_PERMISSIONS } from "./permissions";

/**
 * Runtime storage permissions.
 *
 * Device-only: every export here touches a React Native native module, so it lives
 * apart from `permissions.ts` (pure, unit-tested). See vitest.config.ts for that
 * contract. Opening the all-files-access settings screen lives next door in
 * `settings-launcher.ts`, which owns the expo-intent-launcher dependency.
 *
 * ## Why this exists
 *
 * The manifest declares `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` with
 * `maxSdkVersion=32`, but nothing ever *requested* them. Declaring a dangerous
 * permission does not grant it: on Android 12 and below the app is denied the moment
 * it touches shared storage, which shows up as paths that list but have no readable
 * contents -- the reported "folders are all empty" symptom.
 *
 * `MANAGE_EXTERNAL_STORAGE` is not requestable at runtime at all; it has no dialog and
 * is granted only in system settings, which is what `openAllFilesSettings` is for.
 */

/** The legacy permissions that gate shared storage up to Android 12L (API 32). */

export interface RuntimePermissionOutcome {
  /** True when the platform granted everything we asked for. */
  granted: boolean;
  /** True when there was nothing to ask on this API level. */
  notNeeded: boolean;
  detail: string;
}

/**
 * Ask for the legacy storage permissions.
 *
 * Safe to call repeatedly: the platform returns immediately once granted. Always
 * reports rather than throwing, because a refusal is an ordinary answer the UI shows,
 * not an error.
 */
export async function requestLegacyStoragePermissions(): Promise<RuntimePermissionOutcome> {
  if (Platform.OS !== "android") {
    return { granted: true, notNeeded: true, detail: "not Android" };
  }
  const apiLevel = typeof Platform.Version === "number" ? Platform.Version : Number.parseInt(String(Platform.Version), 10);
  const wanted = legacyStoragePermissionsFor(Number.isFinite(apiLevel) ? apiLevel : 0);
  if (wanted.length === 0) {
    return {
      granted: true,
      notNeeded: true,
      detail: `API ${String(apiLevel)} 不再使用旧版存储权限（改用 READ_MEDIA_*）`,
    };
  }
  try {
    const results = await PermissionsAndroid.requestMultiple(wanted as unknown as Permission[]);
    const denied = Object.entries(results)
      .filter(([, state]) => state !== PermissionsAndroid.RESULTS.GRANTED)
      .map(([name]) => name.replace("android.permission.", ""));
    return denied.length === 0
      ? { granted: true, notNeeded: false, detail: "已授予读写共享存储权限" }
      : { granted: false, notNeeded: false, detail: `被拒绝：${denied.join(", ")}` };
  } catch (error) {
    return {
      granted: false,
      notNeeded: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Whether the legacy permissions are already granted, without prompting. */
export async function checkLegacyStoragePermissions(): Promise<RuntimePermissionOutcome> {
  if (Platform.OS !== "android") {
    return { granted: true, notNeeded: true, detail: "not Android" };
  }
  const apiLevel = typeof Platform.Version === "number" ? Platform.Version : Number.parseInt(String(Platform.Version), 10);
  const wanted = legacyStoragePermissionsFor(Number.isFinite(apiLevel) ? apiLevel : 0);
  if (wanted.length === 0) {
    return { granted: true, notNeeded: true, detail: `API ${String(apiLevel)} 不需要旧版存储权限` };
  }
  const results = await Promise.all(
    wanted.map((name) => PermissionsAndroid.check(name as unknown as Permission)),
  );
  const all = results.every(Boolean);
  return { granted: all, notNeeded: false, detail: all ? "已授予" : "未授予（会在首次读取时请求）" };
}
