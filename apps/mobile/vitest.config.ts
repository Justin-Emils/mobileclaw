import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Mobile-side unit tests.
 *
 * Only `src/runtime` and `src/ui` modules that do not import React Native are
 * covered here — that is why the streaming bridge, the config merge, the shell
 * backends and the platform adapters live in their own files. Anything that
 * touches Expo or RN must be verified on a device build.
 *
 * The aliases below exist so that contract can hold even when a *pure* module is
 * imported transitively alongside a native one. `runtime.ts` needs
 * `expo-intent-launcher` to open the all-files-access settings screen, but the agent
 * loop it implements is exactly what these tests cover, so the native module is
 * swapped for a stub in `test/stubs/`. The real intent is verified on a device.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "expo-intent-launcher": fileURLToPath(new URL("./test/stubs/expo-intent-launcher.ts", import.meta.url)),
      // `runtime.ts` reaches PermissionsAndroid through storage-permissions. The real
      // react-native entry point is Flow-typed and unparseable here, and the dialog it
      // drives is a device concern anyway.
      "react-native": fileURLToPath(new URL("./test/stubs/react-native.ts", import.meta.url)),
      // `bootstrap.ts` imports several Expo native modules. Importing one pure helper
      // from it (readTestOverrides) should not require a device, so they are stubbed.
      "expo-file-system": fileURLToPath(new URL("./test/stubs/expo-modules.ts", import.meta.url)),
      "expo-secure-store": fileURLToPath(new URL("./test/stubs/expo-modules.ts", import.meta.url)),
      "expo-sqlite": fileURLToPath(new URL("./test/stubs/expo-modules.ts", import.meta.url)),
      "expo-linking": fileURLToPath(new URL("./test/stubs/expo-modules.ts", import.meta.url)),
      "expo-clipboard": fileURLToPath(new URL("./test/stubs/expo-modules.ts", import.meta.url)),
      "expo-calendar": fileURLToPath(new URL("./test/stubs/expo-modules.ts", import.meta.url)),
      "expo-notifications": fileURLToPath(new URL("./test/stubs/expo-modules.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
