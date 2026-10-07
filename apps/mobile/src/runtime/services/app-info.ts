/**
 * Where the Android package name comes from.
 *
 * Needed for the all-files-access intent, which takes `package:<id>` as its data so
 * the system opens the toggle for *this* app rather than the general list.
 *
 * `expo-application` is the authoritative source (it reads the built applicationId),
 * but it is registered lazily so the module still loads — and the app still builds
 * and type-checks — in an environment where the dependency has not been installed.
 * The fallback matches `android.package` in app.config.ts; keep the two in step.
 */

const FALLBACK_PACKAGE = "dev.mobileclaw.app";

let cached: string | undefined;

/** Synchronous best-effort value. Prefers expo-application when it is present. */
export function appPackageName(): string {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("expo-application") as { applicationId?: string | null };
    cached = mod.applicationId ?? FALLBACK_PACKAGE;
  } catch {
    cached = FALLBACK_PACKAGE;
  }
  return cached;
}

/** Test seam so specs can pin the value. */
export function setAppPackageNameForTesting(value: string | undefined): void {
  cached = value;
}

export const APP_PACKAGE = appPackageName();
