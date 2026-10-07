import type { ExpoConfig, ConfigContext } from "expo/config";
// `expo/config-plugins` (the sub-export) rather than the `@expo/config-plugins`
// package: Expo requires the former, and installing the latter directly makes
// expo-doctor fail and risks two copies of the plugin runtime.
import { withAndroidManifest, type ConfigPlugin } from "expo/config-plugins";

interface QueryEntry {
  package?: string;
  intent?: { action: string; data?: { scheme?: string; mimeType?: string } };
}

/** `android:name` node shape used inside the manifest's `queries` block. */
interface ManifestName {
  $: { "android:name": string };
}
interface ManifestData {
  $: Record<string, string>;
}
interface ManifestIntent {
  action?: ManifestName[];
  data?: ManifestData[];
}
interface ManifestQueries {
  package?: ManifestName[];
  intent?: ManifestIntent[];
}

const PACKAGE_QUERIES: QueryEntry[] = [
  { package: "com.termux" },
  { package: "com.android.calendar" },
  { package: "com.android.documentsui" },
  { intent: { action: "android.intent.action.SEND", data: { mimeType: "text/plain" } } },
  { intent: { action: "android.intent.action.VIEW", data: { scheme: "https" } } },
];

/**
 * Injects `<queries>` into the Android manifest.
 *
 * A local plugin is needed because `android.queries` is not part of Expo's config
 * schema. This is not cosmetic: from Android 11 (API 30) an app cannot see other
 * packages unless they are declared here, so `system_open` on Termux or a calendar
 * app fails silently — and the alternative, QUERY_ALL_PACKAGES, is a
 * Play-restricted permission.
 */
const withPackageQueries: ConfigPlugin = (config) =>
  withAndroidManifest(config, (manifestConfig) => {
    const manifest = manifestConfig.modResults.manifest as { queries?: ManifestQueries[] };
    const existing = manifest.queries?.[0] ?? {};
    const packages = existing.package ?? [];
    const intents = existing.intent ?? [];

    for (const entry of PACKAGE_QUERIES) {
      if (entry.package && !packages.some((node) => node.$["android:name"] === entry.package)) {
        packages.push({ $: { "android:name": entry.package } });
      }
      if (entry.intent) {
        const data: ManifestData[] = entry.intent.data
          ? [
              {
                $: {
                  ...(entry.intent.data.scheme ? { "android:scheme": entry.intent.data.scheme } : {}),
                  ...(entry.intent.data.mimeType
                    ? { "android:mimeType": entry.intent.data.mimeType }
                    : {}),
                },
              },
            ]
          : [];
        intents.push({ action: [{ $: { "android:name": entry.intent.action } }], data });
      }
    }

    manifest.queries = [{ package: packages, intent: intents }];
    return manifestConfig;
  });

/**
 * MobileClaw app configuration.
 *
 * Notable choices, each backed by the Android capability research:
 *  - `MANAGE_EXTERNAL_STORAGE` (all-files access) is declared because a file
 *    manager-class agent needs real paths. Google Play does not accept an AI
 *    agent for this permission, so the intended channels are sideload, F-Droid
 *    and GitHub releases. Set MOBILECLAW_PLAY_SAFE=1 to build without it (the
 *    agent then only sees app-private storage and SAF-granted trees).
 *  - `<queries>` entries for Termux and common intent targets: without them
 *    Android 11+ refuses to resolve third-party packages, which silently breaks
 *    the cross-app automation tools.
 *  - The Shizuku provider is declared only when the native module is present, so
 *    a build without it does not advertise a capability it lacks.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const playSafe = process.env["MOBILECLAW_PLAY_SAFE"] === "1";
  return {
    ...config,
    name: "MobileClaw",
    slug: "mobileclaw",
    version: "0.1.0",
    orientation: "portrait",
    scheme: "mobileclaw",
    userInterfaceStyle: "dark",
    assetBundlePatterns: ["**/*"],
    android: {
      package: "dev.mobileclaw.app",
      // targetSdk 36 is what SDK 57 builds; edge-to-edge is always on there, and
      // `exec` of app-private binaries is forbidden at API 29+, which is why
      // bundled tools must ship as jniLibs instead.
      permissions: [
        "INTERNET",
        "READ_MEDIA_IMAGES",
        "READ_MEDIA_VIDEO",
        "READ_MEDIA_AUDIO",
        "POST_NOTIFICATIONS",
        "READ_CALENDAR",
        "WRITE_CALENDAR",
        "com.termux.permission.RUN_COMMAND",
        ...(playSafe ? [] : ["MANAGE_EXTERNAL_STORAGE"]),
      ],
      blockedPermissions: playSafe ? ["MANAGE_EXTERNAL_STORAGE"] : [],
    },
    ios: {
      bundleIdentifier: "dev.mobileclaw.app",
      supportsTablet: true,
      // iOS has no equivalent of all-files access; the agent works inside the
      // sandbox plus whatever the share sheet hands it.
      infoPlist: {
        NSCalendarsUsageDescription:
          "MobileClaw creates events you ask for, e.g. \"schedule a standup tomorrow at 9\".",
      },
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-sqlite",
      [
        "expo-notifications",
        {
          // Foreground service work is limited on Android 14+, so notifications
          // are used for finished long jobs rather than for a persistent daemon.
          color: "#4c8dff",
        },
      ],
      // Expo runs function plugins at runtime, but its config *type* only models
      // the string/serializable forms, hence the cast.
      withPackageQueries as unknown as string,
    ],
    experiments: {
      typedRoutes: true,
      // Metro does not read tsconfig `paths` on its own (tsc and vitest do, which
      // is why the `@/*` aliases type-checked but failed to bundle). This makes
      // the alias resolve during bundling.
      tsconfigPaths: true,
    },
    extra: {
      eas: {
        // Replaced by `eas init`; kept explicit so the config is self-documenting.
        projectId: process.env["EAS_PROJECT_ID"] ?? undefined,
      },
    },
  };
};
