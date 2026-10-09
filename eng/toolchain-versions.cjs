"use strict";

/**
 * The single place the Android build's component versions are written down.
 *
 * They previously lived only in comments in `eng/build-local.ps1`, so nothing ever
 * checked them: a machine could install whatever it liked and the script would not
 * notice. `eng/toolchain.cjs` validates against this table and
 * `eng/setup-toolchain.ps1` installs from it, so the two cannot drift apart.
 */

/** Temurin. The build only reaches for `bin/java` and `bin/keytool`; the vendor is a recommendation. */
const JDK_MAJOR = 21;

/** Passed verbatim to `sdkmanager` by `eng/setup-toolchain.ps1`. */
const SDK_PACKAGES = [
  "platform-tools",
  "platforms;android-36",
  "build-tools;36.0.0",
  "ndk;27.1.12297006",
  "cmake;3.30.5",
];

/**
 * CMake the build pins every native module to, by way of
 * `eng/pin-cmake-version.init.gradle`.
 */
const CMAKE_VERSION = "3.30.5";

/**
 * The CMake version the React Native template still defaults `:app` to. Both copies
 * ship a ninja that has to be replaced, so the build probes both.
 */
const CMAKE_TEMPLATE_VERSION = "3.22.1";

/**
 * The SDK's bundled ninja (1.10.x) hardcodes a 260-character path guard, and this
 * monorepo's prefab paths exceed it. The upstream fix — probe the OS for long-path
 * support instead of assuming it is off — landed in **1.11**; **1.12.1** is the version
 * verified on this project, so that is what `-FixNinja` installs. The evidence, the two
 * sha256s and the manual fallback are in `docs/dev-environment.md`.
 */
const NINJA_MIN_VERSION = "1.12.1";

/** What the SDK's CMake ships. Also the name of the backup `-FixNinja` leaves behind. */
const NINJA_BUNDLED_VERSION = "1.10.2";

/** What the React Native / Expo templates expect. The build script does not enforce it. */
const GRADLE_VERSION = "9.3.1";

/**
 * Directory beside the repository that holds the toolchain when it is not installed
 * system-wide. Git-ignored, so copying it between machines never touches the repo.
 */
const LOCAL_DIR = ".toolchain";

/** Subdirectory of `LOCAL_DIR` for each component. */
const LOCAL_SUBDIRS = {
  jdk: "jdk",
  sdk: "android-sdk",
  gradleHome: "gradle-home",
};

/**
 * Where `eng/setup-toolchain.ps1` downloads from.
 *
 * The cmdline-tools build number is deliberately *not* pinned: Google replaces the
 * file every few weeks and a pinned one is a guaranteed 404 eventually. The setup
 * script reads the repository index and picks the newest build it advertises.
 */
const DOWNLOADS = {
  /** Adoptium's "latest stable GA release of the given major" redirect. */
  jdk: "https://api.adoptium.net/v3/binary/latest/{major}/ga/{os}/{arch}/jdk/hotspot/normal/eclipse",
  /** Google's SDK index; scanned for the current `commandlinetools-<os>-<build>_latest.zip`. */
  sdkIndex: "https://dl.google.com/android/repository/repository2-3.xml",
  sdkBase: "https://dl.google.com/android/repository/",
  /**
   * A long-path-aware ninja, for `-FixNinja`. The SDK's bundled 1.10.2 hardcodes a
   * 260-character guard; see docs/dev-environment.md for the whole diagnosis.
   * On a network that cannot reach GitHub, fetch this by hand.
   */
  ninja: "https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-win.zip",
};

module.exports = {
  JDK_MAJOR,
  SDK_PACKAGES,
  CMAKE_VERSION,
  CMAKE_TEMPLATE_VERSION,
  NINJA_MIN_VERSION,
  NINJA_BUNDLED_VERSION,
  GRADLE_VERSION,
  LOCAL_DIR,
  LOCAL_SUBDIRS,
  DOWNLOADS,
};
