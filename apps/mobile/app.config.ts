import type { ExpoConfig, ConfigContext } from "expo/config";
// `expo/config-plugins` (the sub-export) rather than the `@expo/config-plugins`
// package: Expo requires the former, and installing the latter directly makes
// expo-doctor fail and risks two copies of the plugin runtime.
import { withAndroidManifest, withAppBuildGradle, withDangerousMod, withMainApplication, type ConfigPlugin } from "expo/config-plugins";
import * as fs from "node:fs";
import * as path from "node:path";

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
  /** Needed for a launcher-style query: MAIN alone matches too little. */
  category?: ManifestName[];
}
interface ManifestQueries {
  package?: ManifestName[];
  intent?: ManifestIntent[];
}

const PACKAGE_QUERIES: QueryEntry[] = [
  { package: "com.termux" },
  { package: "com.android.calendar" },
  { package: "com.android.documentsui" },
  // Needed to tell "Shizuku is not installed" apart from "installed but not running",
  // which need different instructions. A <queries> entry is visible on play-safe builds
  // too, unlike QUERY_ALL_PACKAGES.
  { package: "moe.shizuku.privileged.api" },
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

    // Android 11+ hides other apps unless they are named here. `system_apps` exists to list
    // installed apps so the agent can pick a package id for `system_open`, and with only the
    // fixed `<package>` entries above it could see four apps and nothing else.
    //
    // A MAIN/LAUNCHER query is the way to fix that: it is the officially recommended
    // mechanism, and it needs no permission. QUERY_ALL_PACKAGES would also work but is a
    // Play-restricted permission requiring a declared use case, and it exposes the full
    // package list including apps with no icon. This returns exactly the launchable apps,
    // which is what a user means by "the apps on my phone".
    const launcherIntent = {
      action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
      category: [{ $: { "android:name": "android.intent.category.LAUNCHER" } }],
    };
    if (!intents.some((i) => i.action?.[0]?.$?.["android:name"] === "android.intent.action.MAIN")) {
      intents.push(launcherIntent);
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
 * Install MobileClaw's native file module, which is the only way to write shared storage.
 *
 * ## Why a native module at all
 *
 * `expo-file-system` decides whether an operation is allowed by asking the *filesystem*
 * about the file (expo-modules-core, `FilePermissionService.kt`):
 *
 *     protected open fun getExternalPathPermissions(path: String): EnumSet<Permission> =
 *       EnumSet.noneOf(Permission::class.java).apply {
 *         if (file.canRead())  { add(Permission.READ) }
 *         if (file.canWrite()) { add(Permission.WRITE) }
 *       }
 *
 * `File.canRead()` / `canWrite()` compare the file's owner, group and mode bits against the
 * calling process. A file in `/storage/emulated/0/Download` belongs to another uid
 * (`u0_a270 media_rw`, mode `rw-rw----` on the device this was diagnosed on), so the app is
 * neither owner nor group member and both calls return false -- and a file that does not
 * exist yet can never pass either check. All-files access does not change those bits, so the
 * gate refuses no matter what the user grants, and reports it as
 * `Missing 'READ' permission`, which sends them to a switch that is already on.
 *
 * `java.io.File` performs no such pre-check: it attempts the operation and the kernel
 * decides. That is the correct behaviour, because all-files access is precisely the grant
 * that lets the kernel say yes.
 *
 * ## Why `ReactPackage` rather than an Expo module
 *
 * A local Expo module was built first and never registered: its Kotlin compiled into the APK
 * and Gradle included the project, but `requireNativeModule` could not resolve it, so the app
 * silently fell back to expo-file-system. `expo-modules-autolinking search` found the module
 * while `resolve` -- which feeds the generated package list -- did not, and that gap was not
 * tractable to read from the outside.
 *
 * A `ReactPackage` named in `MainApplication`'s `PackageList` has no discovery step: either
 * the class compiles and is registered, or the build fails loudly. Given how much of this
 * defect hid behind silent fallbacks, a mechanism that cannot fail quietly beats a tidier one.
 */
const MOBILECLAW_FILES_SOURCE_DIR = "app/src/main/java/dev/mobileclaw/app/files";

/** A thin wrapper over `java.io.File`. Paths are already validated by PathGuard. */
const MOBILECLAW_FILES_MODULE_KT = `package dev.mobileclaw.app.files

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import java.io.File

/**
 * File access that bypasses expo-file-system's permission pre-check.
 *
 * That check gates on File.canRead()/canWrite(), which are false for any file the app does
 * not own -- so it refuses shared-storage writes even with all-files access granted, and
 * reports it as a missing READ permission. java.io.File runs no pre-check: it attempts the
 * operation and the kernel decides.
 *
 * Paths arrive already validated by PathGuard, which is the authoritative containment check,
 * so this class deliberately does not repeat it. Failures are rejected with the kernel's own
 * message rather than a generic one, so "no permission" can be told from "no such directory"
 * instead of guessed at.
 *
 * @ReactModule is what makes a legacy module visible under the New Architecture; without it
 * the package is listed but NativeModules never resolves the name.
 */
@ReactModule(name = MobileClawFilesModule.NAME)
class MobileClawFilesModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  companion object {
    const val NAME = "MobileClawFiles"
  }

  @ReactMethod
  fun writeText(path: String, contents: String, promise: Promise) {
    run(promise) {
      val file = File(path)
      file.parentFile?.mkdirs()
      file.writeText(contents)
      file.length().toDouble()
    }
  }

  @ReactMethod
  fun writeBase64(path: String, base64: String, promise: Promise) {
    run(promise) {
      val file = File(path)
      file.parentFile?.mkdirs()
      file.writeBytes(Base64.decode(base64, Base64.DEFAULT))
      file.length().toDouble()
    }
  }

  @ReactMethod
  fun readText(path: String, promise: Promise) {
    run(promise) {
      val file = File(path)
      if (file.isFile) file.readText() else null
    }
  }

  @ReactMethod
  fun readBase64(path: String, promise: Promise) {
    run(promise) {
      val file = File(path)
      if (file.isFile) Base64.encodeToString(file.readBytes(), Base64.NO_WRAP) else null
    }
  }

  @ReactMethod
  fun exists(path: String, promise: Promise) {
    run(promise) { File(path).exists() }
  }

  @ReactMethod
  fun isDirectory(path: String, promise: Promise) {
    run(promise) { File(path).isDirectory }
  }

  @ReactMethod
  fun size(path: String, promise: Promise) {
    run(promise) { File(path).length().toDouble() }
  }

  @ReactMethod
  fun mtime(path: String, promise: Promise) {
    run(promise) { File(path).lastModified().toDouble() }
  }

  @ReactMethod
  fun mkdirs(path: String, promise: Promise) {
    run(promise) { File(path).mkdirs() }
  }

  @ReactMethod
  fun delete(path: String, promise: Promise) {
    run(promise) {
      val file = File(path)
      if (file.isDirectory) file.deleteRecursively() else file.delete()
    }
  }

  /** Move, falling back to copy-then-delete when a rename across mounts is refused. */
  @ReactMethod
  fun move(from: String, to: String, promise: Promise) {
    run(promise) {
      val source = File(from)
      val target = File(to)
      target.parentFile?.mkdirs()
      if (source.renameTo(target)) return@run true
      if (source.isDirectory) return@run false
      source.copyTo(target, overwrite = true)
      source.delete()
    }
  }

  @ReactMethod
  fun list(path: String, promise: Promise) {
    run(promise) {
      val dir = File(path)
      val names = if (dir.isDirectory) dir.list()?.sorted() ?: emptyList() else emptyList()
      Arguments.createArray().apply { names.forEach { pushString(it) } }
    }
  }

  /**
   * What the filesystem says about a path, for diagnosing a refusal without guessing.
   */
  @ReactMethod
  fun describe(path: String, promise: Promise) {
    run(promise) {
      val file = File(path)
      val parent = file.parentFile
      Arguments.createMap().apply {
        putString("path", path)
        putBoolean("exists", file.exists())
        putBoolean("isDirectory", file.isDirectory)
        putBoolean("canRead", file.canRead())
        putBoolean("canWrite", file.canWrite())
        putString("parent", parent?.absolutePath ?: "")
        putBoolean("parentExists", parent?.exists() ?: false)
        putBoolean("parentCanWrite", parent?.canWrite() ?: false)
      }
    }
  }

  /**
   * Installed apps that have a launcher entry, so the agent can pick a package id for
   * system_open.
   *
   * Only packages with a launcher activity are returned: an unfiltered
   * getInstalledPackages() is enormous and mostly unopenable, and this is exactly the set a
   * user means by "the apps on my phone".
   *
   * Visibility is the catch on Android 11+. The manifest holds QUERY_ALL_PACKAGES (non-Play
   * builds) plus a MAIN/LAUNCHER query, so this returns the real launcher set. On a
   * play-safe build without the permission the query still resolves launcher apps that
   * declare themselves visible, and if it comes back empty the tool reports that rather
   * than looking successful.
   */
  @ReactMethod
  fun listApps(promise: Promise) {
    run(promise) {
      val intent = android.content.Intent(android.content.Intent.ACTION_MAIN).apply {
        addCategory(android.content.Intent.CATEGORY_LAUNCHER)
      }
      val manager = reactContext.packageManager
      @Suppress("DEPRECATION")
      val resolved = manager.queryIntentActivities(intent, 0)
      val seen = HashSet<String>()
      Arguments.createArray().apply {
        for (info in resolved) {
          val packageId = info.activityInfo?.packageName ?: continue
          if (!seen.add(packageId)) continue
          val label = try {
            info.loadLabel(manager).toString()
          } catch (error: Throwable) {
            packageId
          }
          pushMap(Arguments.createMap().apply {
            putString("packageId", packageId)
            putString("label", label)
          })
        }
      }
    }
  }

  /** Runs [block] off the JS thread and settles [promise] with its result or failure. */
  private fun run(promise: Promise, block: () -> Any?) {
    Thread {
      try {
        promise.resolve(block())
      } catch (error: Throwable) {
        promise.reject("E_MOBILECLAW_FILES", error.message ?: error.toString(), error)
      }
    }.start()
  }
}
`;

/** Registers the module above. */
const MOBILECLAW_FILES_PACKAGE_KT = `package dev.mobileclaw.app.files

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers MobileClawFilesModule. See withMobileClawFiles in app.config.ts. */
class MobileClawFilesPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(MobileClawFilesModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`;

const withMobileClawFiles: ConfigPlugin = (config) => {
  // `android/` is git-ignored and regenerated by prebuild, so the Kotlin has to be written by
  // the plugin rather than committed into the generated project.
  config = withDangerousMod(config, [
    "android",
    async (cfg) => {
      const target = path.join(cfg.modRequest.platformProjectRoot, MOBILECLAW_FILES_SOURCE_DIR);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "MobileClawFilesModule.kt"), MOBILECLAW_FILES_MODULE_KT, "utf8");
      fs.writeFileSync(path.join(target, "MobileClawFilesPackage.kt"), MOBILECLAW_FILES_PACKAGE_KT, "utf8");
      return cfg;
    },
  ]);

  return withMainApplication(config, (cfg) => {
    const hook = "          // add(MyReactNativePackage())";
    if (!cfg.modResults.contents.includes(hook)) {
      // Throwing beats writing an unregistered module: the app would otherwise fall back to
      // expo-file-system and look like the fix had simply not worked.
      throw new Error(
        "withMobileClawFiles: the PackageList hook is missing from MainApplication.kt, so the " +
          "native file module would compile but never register. The Expo template shape changed.",
      );
    }
    cfg.modResults.contents = cfg.modResults.contents.replace(
      hook,
      `${hook}\n          add(dev.mobileclaw.app.files.MobileClawFilesPackage())`,
    );
    return cfg;
  });
};

/* ----------------------------------------------------------------- Shizuku --- */

/**
 * The Shizuku native surface: a `ReactPackage` plus the AIDL user service it binds.
 *
 * Unlike the file module above, the Kotlin and AIDL live as **real files** under
 * `apps/mobile/android-native/shizuku/` and are copied in. Inlining is a trap here:
 * `${...}` is a Kotlin string template, and inside a TS template literal it would be
 * interpolated away. Real files also get read by people and by tooling, which a
 * five-hundred-line escaped string never does. (The file module predates this and
 * should move too.)
 */
const SHIZUKU_NATIVE_DIR = path.join(__dirname, "android-native", "shizuku");
const SHIZUKU_JAVA_DIR = "app/src/main/java/dev/mobileclaw/app/shizuku";
const SHIZUKU_AIDL_DIR = "app/src/main/aidl/dev/mobileclaw/app/shizuku";

const SHIZUKU_PROVIDER = "rikka.shizuku.ShizukuProvider";

/** Idempotency marker for the gradle patch, which has two separate insertions. */
const SHIZUKU_GRADLE_MARKER = "MOBILECLAW_SHIZUKU";

/**
 * The newest stable Shizuku API on Maven Central — read from the repository index, not
 * guessed. `:provider` is only needed when Shizuku (rather than Sui) has to be
 * supported, which is exactly the case here.
 */
const SHIZUKU_API_VERSION = "13.1.5";

const withMobileClawShizuku: ConfigPlugin = (config) => {
  config = withDangerousMod(config, [
    "android",
    async (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const javaTarget = path.join(root, SHIZUKU_JAVA_DIR);
      const aidlTarget = path.join(root, SHIZUKU_AIDL_DIR);
      fs.mkdirSync(javaTarget, { recursive: true });
      fs.mkdirSync(aidlTarget, { recursive: true });

      // AIDL goes to its own source set; AGP compiles it into the Stub the Kotlin
      // extends. Copying rather than writing strings keeps every byte verbatim.
      for (const entry of fs.readdirSync(SHIZUKU_NATIVE_DIR)) {
        const target = entry.endsWith(".aidl") ? aidlTarget : javaTarget;
        fs.copyFileSync(path.join(SHIZUKU_NATIVE_DIR, entry), path.join(target, entry));
      }
      return cfg;
    },
  ]);

  return withMainApplication(config, (cfg) => {
    const registration = "add(dev.mobileclaw.app.shizuku.MobileClawShizukuPackage())";
    if (cfg.modResults.contents.includes(registration)) return cfg;

    // Anchored on the template hook, *not* on the file module's registration line. That
    // was the first attempt and it failed loudly: Expo's mod compiler groups mods by
    // type, so two plugins' `withMainApplication` mods are not guaranteed to run in the
    // order the plugins were listed. Depending on another plugin's edit is a race even
    // when it happens to work. The hook is always present in a fresh template, and the
    // order of entries inside the package list does not matter.
    const hook = "          // add(MyReactNativePackage())";
    if (!cfg.modResults.contents.includes(hook)) {
      throw new Error(
        "withMobileClawShizuku: the PackageList hook is missing from MainApplication.kt, so the " +
          "Shizuku package would compile but never register. The Expo template shape changed.",
      );
    }
    cfg.modResults.contents = cfg.modResults.contents.replace(
      hook,
      `${hook}\n          ${registration}`,
    );
    return cfg;
  });
};

/** The `<provider>` element as the manifest mod carries it, which Expo's types omit. */
interface ManifestProvider {
  $: Record<string, string>;
}

/**
 * Declare the provider Shizuku uses to reach this app.
 *
 * `authorities` must be `${applicationId}.shizuku`, and the provider is protected by
 * `INTERACT_ACROSS_USERS_FULL` so ordinary apps cannot bind to it. Both come from the
 * official Shizuku-API README — which is also why there is no
 * `moe.shizuku.manager.permission.API_V23` here. That string circulates online; the
 * documentation does not contain it.
 */
const withShizukuManifest: ConfigPlugin = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("withShizukuManifest: the manifest has no <application> element");
    }

    // `provider` is missing from Expo's `ManifestApplication` type even though the mod
    // result carries the array through untouched. Narrowing here keeps the rest of the
    // manifest typed, rather than casting the whole object to `any`.
    const host = application as typeof application & { provider?: ManifestProvider[] };
    const providers = (host.provider ??= []);
    if (providers.some((entry) => entry.$["android:name"] === SHIZUKU_PROVIDER)) return cfg;

    providers.push({
      $: {
        "android:name": SHIZUKU_PROVIDER,
        "android:authorities": "${applicationId}.shizuku",
        "android:multiprocess": "false",
        "android:enabled": "true",
        "android:exported": "true",
        "android:permission": "android.permission.INTERACT_ACROSS_USERS_FULL",
      },
    });
    return cfg;
  });

/**
 * Add the Shizuku API and switch AIDL on.
 *
 * `buildFeatures { aidl true }` is not optional: AGP 8 defaults it off, and with it off
 * the `.aidl` file is ignored — the Kotlin would then fail with a "cannot find symbol"
 * for a Stub that was never generated, which reads like a code error rather than a
 * configuration one. The generated template has no `buildFeatures` block at all, so one
 * is inserted after `android {`; that was checked against the real generated file, not
 * assumed.
 */
const withShizukuGradle: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes(SHIZUKU_GRADLE_MARKER)) return cfg;
    let contents = cfg.modResults.contents;

    const dependencies = "dependencies {";
    if (!contents.includes(dependencies)) {
      throw new Error(
        "withShizukuGradle: no `dependencies {` block in the generated app/build.gradle",
      );
    }
    const deps = [
      `    implementation("dev.rikka.shizuku:api:${SHIZUKU_API_VERSION}")`,
      `    implementation("dev.rikka.shizuku:provider:${SHIZUKU_API_VERSION}")`,
    ].join("\n");
    contents = contents.replace(dependencies, `${dependencies}\n    // ${SHIZUKU_GRADLE_MARKER}\n${deps}`);

    const androidBlock = /^android \{\n/m;
    if (!androidBlock.test(contents)) {
      throw new Error("withShizukuGradle: no `android {` block in the generated app/build.gradle");
    }
    contents = contents.replace(androidBlock, "android {\n    buildFeatures {\n        aidl true\n    }\n");

    cfg.modResults.contents = contents;
    return cfg;
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
 *  - The Shizuku provider is **not** declared at all yet. The native module that needs
 *    it has not been written, so the manifest advertises nothing the app cannot do.
 *    When it lands, `withShizukuManifest` adds the `rikka.shizuku.ShizukuProvider`
 *    entry (see docs/worklog/shizuku-screen-automation.md).
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
      withMobileClawFiles as unknown as string,
      // Each Shizuku plugin anchors on the template hook and guards on its own edit, so
      // their relative order does not matter — see the note in withMobileClawShizuku.
      withMobileClawShizuku as unknown as string,
      withShizukuManifest as unknown as string,
      withShizukuGradle as unknown as string,
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
