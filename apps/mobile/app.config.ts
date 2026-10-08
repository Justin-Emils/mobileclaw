import type { ExpoConfig, ConfigContext } from "expo/config";
// `expo/config-plugins` (the sub-export) rather than the `@expo/config-plugins`
// package: Expo requires the former, and installing the latter directly makes
// expo-doctor fail and risks two copies of the plugin runtime.
import { withAndroidManifest, withAppBuildGradle, type ConfigPlugin } from "expo/config-plugins";

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
 * Removes MANAGE_EXTERNAL_STORAGE for Play-safe builds.
 *
 * `android.blockedPermissions` alone does not work: Expo only uses that list to
 * filter permissions contributed by *library modules*, so the entry declared
 * directly in `android.permissions` still lands in the manifest (verified by
 * generating the manifest with MOBILECLAW_PLAY_SAFE=1 and finding it present).
 * Deleting the node is the only reliable way.
 */
const withPlaySafeStorage: ConfigPlugin = (config) =>
  withAndroidManifest(config, (manifestConfig) => {
    const manifest = manifestConfig.modResults.manifest as {
      "uses-permission"?: { $?: Record<string, string> }[];
    };
    const list = manifest["uses-permission"];
    if (!Array.isArray(list)) return manifestConfig;
    manifest["uses-permission"] = list.filter(
      (entry) => entry?.$?.["android:name"] !== "android.permission.MANAGE_EXTERNAL_STORAGE",
    );
    return manifestConfig;
  });

/**
 * Declare the legacy storage permissions alongside all-files access.
 *
 * They are `maxSdkVersion=32`, so on Android 13+ the platform grants nothing for them and
 * the user is never prompted -- but `expo-file-system`'s native layer still *checks* them
 * before `File.create()`, and a permission that is not declared at all can only check as
 * denied. The symptom is specific and was observed on a Xiaomi running Android 16 / API 36
 * with `MANAGE_EXTERNAL_STORAGE` already allowed via appops:
 *
 *   Call to function 'FileSystemFile.create' has been rejected.
 *     → Caused by: Missing 'READ' permission for accessing the file.
 *
 * Reading a shared-storage directory worked (names are visible without any grant) while
 * every write failed, and the probe -- which writes to decide -- reported the app as
 * unauthorised. That sent the user to a setting that was already on, with no way out.
 *
 * Declaring them is the narrow change: it cannot widen what the app may access on a modern
 * OS, because the platform ignores these on 33+.
 */
const withLegacyStoragePermissions: ConfigPlugin = (config) =>
  withAndroidManifest(config, (manifestConfig) => {
    const manifest = manifestConfig.modResults.manifest as {
      "uses-permission"?: { $?: Record<string, string> }[];
    };
    const list = manifest["uses-permission"];
    if (!Array.isArray(list)) return manifestConfig;
    const legacy = [
      { name: "android.permission.READ_EXTERNAL_STORAGE", max: "32" },
      { name: "android.permission.WRITE_EXTERNAL_STORAGE", max: "32" },
    ];
    for (const entry of legacy) {
      const exists = list.some((item) => item?.$?.["android:name"] === entry.name);
      if (!exists) {
        list.push({
          $: { "android:name": entry.name, "android:maxSdkVersion": entry.max },
        });
      }
    }
    manifest["uses-permission"] = list;
    return manifestConfig;
  });

/**
 * Wire the local release keystore into `app/build.gradle`.
 *
 * `expo prebuild` generates a release buildType signed with the **debug** key. That
 * is why a locally built "release" APK could not be installed over the EAS-signed
 * one: Android refuses a signature change, so for upgrade purposes it was still a
 * debug build. The keystore and its gradle.properties entries were already being
 * created by `eng/build-local.ps1 -GenerateKeystore`; nothing consumed them.
 *
 * android/ is git-ignored and regenerated by prebuild, so a manual edit to
 * app/build.gradle does not survive. As a config plugin, this does.
 *
 * When the keystore is absent the `if (project.hasProperty(...))` guards leave the
 * template's original debug signing in place, so a fresh clone still builds.
 */
const withLocalReleaseSigning: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (gradleConfig) => {
    const marker = "MOBILECLAW_LOCAL_RELEASE_SIGNING";
    if (gradleConfig.modResults.contents.includes(marker)) return gradleConfig;

    const original = gradleConfig.modResults.contents;
    const anchor = "signingConfigs {";
    if (!original.includes(anchor)) {
      throw new Error(
        "withLocalReleaseSigning: could not find `signingConfigs {` in the generated app/build.gradle",
      );
    }

    const releaseSigning = `
    // ${marker}
    release {
        if (project.hasProperty('MOBILECLAW_UPLOAD_STORE_FILE')) {
            storeFile file(MOBILECLAW_UPLOAD_STORE_FILE)
            storePassword MOBILECLAW_UPLOAD_STORE_PASSWORD
            keyAlias MOBILECLAW_UPLOAD_KEY_ALIAS
            keyPassword MOBILECLAW_UPLOAD_KEY_PASSWORD
        }
    }
`;

    let contents = original.replace(anchor, `${anchor}${releaseSigning}`);
    contents = contents.replace(
      /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/,
      "$1signingConfig project.hasProperty('MOBILECLAW_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug",
    );

    if (!contents.includes("signingConfigs.release")) {
      throw new Error(
        "withLocalReleaseSigning: could not repoint the release signingConfig; the Expo template shape changed",
      );
    }

    gradleConfig.modResults.contents = contents;
    return gradleConfig;
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
    // The EAS account that owns the project; required so builds resolve the
    // correct project when an account belongs to several organizations.
    owner: "justin_emils",
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
      // the string/serializable forms, hence the casts.
      withPackageQueries as unknown as string,
      withLegacyStoragePermissions as unknown as string,
      withLocalReleaseSigning as unknown as string,
      ...(playSafe ? [withPlaySafeStorage as unknown as string] : []),
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
        // Written by hand because `eas init` cannot patch a dynamic config
        // (app.config.ts) automatically. Overridable for forks via EAS_PROJECT_ID.
        projectId: process.env["EAS_PROJECT_ID"] ?? "2f118dc0-9900-4be8-8a68-6babf1c5be75",
      },
    },
  };
};
