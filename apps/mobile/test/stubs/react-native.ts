/**
 * Node stand-in for `react-native`.
 *
 * `runtime.ts` reaches React Native's `PermissionsAndroid` transitively (through
 * storage-permissions), and `runtime.test.ts` covers the agent loop, which has nothing
 * to do with asking for permissions. The real `react-native` entry point is Flow-typed
 * and cannot be parsed by the test transform at all.
 *
 * Aliased in vitest.config.ts. Anything asserting on permission behaviour drives
 * `legacyStoragePermissionsFor` (pure, in services/permissions.ts) instead; the actual
 * dialog is verified on a device, as vitest.config.ts's contract requires.
 */

export const Platform = {
  OS: "android" as string,
  Version: 34 as number | string,
  select<T>(spec: { android?: T; ios?: T; default?: T }): T | undefined {
    return spec.android ?? spec.default;
  },
};

export const PermissionsAndroid = {
  RESULTS: { GRANTED: "granted", DENIED: "denied", NEVER_ASK_AGAIN: "never_ask_again" },
  async check(): Promise<boolean> {
    return true;
  },
  async request(): Promise<string> {
    return "granted";
  },
  async requestMultiple(permissions: string[]): Promise<Record<string, string>> {
    return Object.fromEntries(permissions.map((permission) => [permission, "granted"]));
  },
};

export type Permission = string;

export default { Platform, PermissionsAndroid };
