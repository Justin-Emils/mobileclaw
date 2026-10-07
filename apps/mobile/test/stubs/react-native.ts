/**
 * Node stand-in for `react-native`.
 *
 * `runtime.ts` reaches React Native's `PermissionsAndroid` transitively (through
 * storage-permissions), and `markdown-view.tsx` uses `StyleSheet` and `Text`/`View` at
 * module scope. The real `react-native` entry point is Flow-typed and cannot be parsed
 * by the test transform at all.
 *
 * Aliased in vitest.config.ts. The point is to let pure logic *inside* those modules be
 * tested -- table normalisation, permission gating -- without a device. Anything that
 * actually renders or asks for a permission is verified on a device, as vitest.config.ts's
 * contract requires.
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

/**
 * `StyleSheet.create` returns the styles themselves, and `hairlineWidth` is a number, so
 * module-scope style objects are usable outside a renderer.
 */
export const StyleSheet = {
  create<T extends Record<string, unknown>>(styles: T): T {
    return styles;
  },
  hairlineWidth: 0.5,
  flatten<T>(style: T): T {
    return style;
  },
};

/** Inert host components: present so modules that reference them can be imported. */
export const View = "View";
export const Text = "Text";
export const ScrollView = "ScrollView";
export const Pressable = "Pressable";
export const FlatList = "FlatList";
export const TextInput = "TextInput";
export const ActivityIndicator = "ActivityIndicator";
export const KeyboardAvoidingView = "KeyboardAvoidingView";
export const Alert = {
  alert: (): void => undefined,
};
export const Linking = {
  openURL: async (): Promise<void> => undefined,
};
export const Share = {
  share: async (): Promise<{ action: string }> => ({ action: "dismissedAction" }),
};

export type Permission = string;

export default { Platform, PermissionsAndroid, StyleSheet };
