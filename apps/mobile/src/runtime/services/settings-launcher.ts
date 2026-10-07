import { ActivityAction, startActivityAsync } from "expo-intent-launcher";
import { appPackageName } from "./app-info";

/**
 * Opening the system screen that toggles all-files access.
 *
 * Separate from `permissions.ts` (which does the detection) because this imports a
 * native Expo module: mixing the two in one file would drag the Expo dependency into
 * the Node unit tests, and vitest.config.ts explicitly keeps device-only code out of
 * them.
 *
 * `MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` with `package:` data is the documented
 * per-app entry point. Some OEM builds only honour the generic
 * `MANAGE_ALL_FILES_ACCESS_PERMISSION`, so fall back to that, then to the app's own
 * details page -- the user can always reach the toggle from there.
 */
export async function openAllFilesSettings(
  packageName: string = appPackageName(),
): Promise<{ opened: boolean; detail: string }> {
  const attempts: { action: string; data?: string }[] = [
    { action: ActivityAction.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, data: `package:${packageName}` },
    { action: ActivityAction.MANAGE_ALL_FILES_ACCESS_PERMISSION },
    { action: ActivityAction.APPLICATION_DETAILS_SETTINGS, data: `package:${packageName}` },
  ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      await startActivityAsync(attempt.action, {
        ...(attempt.data ? { data: attempt.data } : {}),
      });
      return { opened: true, detail: attempt.action };
    } catch (error) {
      errors.push(`${attempt.action}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { opened: false, detail: errors.join("; ") };
}
