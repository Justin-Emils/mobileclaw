/**
 * Babel configuration for the Expo app.
 *
 * This file was missing, which had a non-obvious consequence: `babel-preset-expo` is what
 * inlines `process.env.EXPO_PUBLIC_*` at bundle time. Without it those references survive
 * into the bundle as runtime lookups, and `process` does not exist in React Native, so a
 * read yields nothing -- silently. Confirmed by searching a built bundle for the value:
 * the variable *name* was present as a string, the value was not.
 *
 * `babel-preset-expo` also supplies the JSX transform, Hermes profile handling and the
 * `@/*` handling Expo expects, so its absence was not purely cosmetic even though the
 * build worked (Expo CLI falls back to a default preset when this file is absent).
 *
 * See `readTestOverrides` in src/runtime/bootstrap.ts for the one place that relies on
 * `EXPO_PUBLIC_` inlining.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
  };
};
