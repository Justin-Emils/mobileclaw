import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Mobile-side unit tests.
 *
 * Only `src/runtime` and `src/ui` modules that do not import React Native are
 * covered here — that is why the streaming bridge, the config merge, the shell
 * backends and the platform adapters live in their own files. Anything that
 * touches Expo or RN must be verified on a device build.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
