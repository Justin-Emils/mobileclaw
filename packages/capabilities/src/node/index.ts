/**
 * Node-only capability backends.
 *
 * Imported as `@mobileclaw/capabilities/node` so a React Native bundle never
 * pulls `node:fs` / `node:child_process` through the main entry point. Used by
 * tests, by the desktop playground and by a future CLI host.
 */
export * from "./fs";
export * from "./shell";
