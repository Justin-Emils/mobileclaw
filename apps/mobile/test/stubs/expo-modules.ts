/**
 * Node stand-ins for the Expo native modules `bootstrap.ts` imports.
 *
 * `bootstrap.test.ts` only needs `readTestOverrides`, a pure function, but importing it
 * pulls in the whole module graph. These stubs exist so that stays possible without a
 * device -- the same approach already used for react-native and expo-intent-launcher in
 * vitest.config.ts.
 *
 * Nothing here is meant to behave: any call that reaches a stub is a test that wandered
 * outside what can be verified on Node. Keep them minimal and obviously inert.
 */

/**
 * An inert member: callable, constructable, and any property access returns another
 * inert member. Typed loosely on purpose -- these modules are never exercised on Node.
 */
const anything = new Proxy(function inert(): unknown {
  return anything;
}, {
  get: (_target, prop) => (prop === "then" ? undefined : anything),
  apply: () => anything,
  construct: () => anything,
}) as unknown as {
  [key: string]: unknown;
  (): unknown;
  new (): unknown;
};

export const File = anything();
export const Directory = anything();
export const Paths = anything();

export const getItemAsync = async (): Promise<string | null> => null;
export const setItemAsync = async (): Promise<void> => undefined;
export const deleteItemAsync = async (): Promise<void> => undefined;

export const openDatabaseAsync = async (): Promise<unknown> => anything();

export const createURL = (path: string): string => `mobileclaw://${path}`;
export const openURL = async (): Promise<void> => undefined;
export const addEventListener = (): { remove: () => void } => ({ remove: () => undefined });

export const setStringAsync = async (): Promise<boolean> => true;
export const getStringAsync = async (): Promise<string> => "";

export const ActivityAction = {
  MANAGE_APP_ALL_FILES_ACCESS_PERMISSION: "android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION",
  MANAGE_ALL_FILES_ACCESS_PERMISSION: "android.settings.MANAGE_ALL_FILES_ACCESS_PERMISSION",
  APPLICATION_DETAILS_SETTINGS: "android.settings.APPLICATION_DETAILS_SETTINGS",
};
export const startActivityAsync = async (): Promise<{ resultCode: number }> => ({ resultCode: 0 });

export const createEventAsync = async (): Promise<string> => "event-id";
export const getCalendarsAsync = async (): Promise<unknown[]> => [];
export const requestCalendarPermissionsAsync = async (): Promise<{ granted: boolean }> => ({ granted: false });

export const scheduleNotificationAsync = async (): Promise<string> => "notification-id";
export const requestPermissionsAsync = async (): Promise<{ granted: boolean }> => ({ granted: false });
