const { getDefaultConfig } = require("expo/metro-config");

/**
 * Metro configuration.
 *
 * Two things matter here:
 *
 *  1. `@/*` path aliases come from tsconfig via `experiments.tsconfigPaths` in
 *     app.config.ts, so they are not duplicated here.
 *  2. This is a pnpm workspace. Metro resolves from real paths, and the app's
 *     `.npmrc` uses a hoisted node-linker so the workspace packages appear in
 *     `apps/mobile/node_modules`. Watch the sibling package sources explicitly so
 *     edits to `packages/*` trigger a rebuild instead of being served from cache.
 */
const path = require("node:path");
const config = getDefaultConfig(__dirname);

config.watchFolders = [
  path.resolve(__dirname, "../../packages/core"),
  path.resolve(__dirname, "../../packages/capabilities"),
];

// Prefer the app's own node_modules before walking up into the workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(__dirname, "../../node_modules"),
];

module.exports = config;
