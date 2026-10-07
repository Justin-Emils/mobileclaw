/**
 * Node stand-in for `expo-intent-launcher`.
 *
 * `runtime.ts` imports this transitively (via settings-launcher) to open the
 * all-files-access settings screen. The real module is a native Expo module, so it
 * cannot load under vitest's Node environment -- and `runtime.test.ts` covers the
 * agent loop, which has nothing to do with launching intents.
 *
 * Aliased in vitest.config.ts. Tests that care about the launch behaviour assert on
 * the call log instead of the real intent; the actual jump to system settings is
 * verified on a device, as vitest.config.ts's contract requires.
 */

export const ActivityAction = {
  MANAGE_APP_ALL_FILES_ACCESS_PERMISSION: "android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION",
  MANAGE_ALL_FILES_ACCESS_PERMISSION: "android.settings.MANAGE_ALL_FILES_ACCESS_PERMISSION",
  APPLICATION_DETAILS_SETTINGS: "android.settings.APPLICATION_DETAILS_SETTINGS",
} as const;

export interface StartActivityCall {
  action: string;
  params?: Record<string, unknown>;
}

/** Calls recorded so a test can assert which action was attempted. */
export const startActivityCalls: StartActivityCall[] = [];

let behaviour: "resolve" | "reject" = "resolve";

/** Control the stub from a test. */
export function setStartActivityBehaviour(next: "resolve" | "reject"): void {
  behaviour = next;
}

export function resetStartActivityStub(): void {
  startActivityCalls.length = 0;
  behaviour = "resolve";
}

export async function startActivityAsync(
  action: string,
  params?: Record<string, unknown>,
): Promise<{ resultCode: number }> {
  startActivityCalls.push({ action, ...(params ? { params } : {}) });
  if (behaviour === "reject") throw new Error("stub: no activity found");
  return { resultCode: 0 };
}

export default { ActivityAction, startActivityAsync };
