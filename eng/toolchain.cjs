#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const V = require("./toolchain-versions.cjs");

const EXE = process.platform === "win32" ? ".exe" : "";

const LABELS = { jdk: "JDK", sdk: "Android SDK", gradleHome: "Gradle home" };

/**
 * What makes a directory a usable instance of each component.
 *
 * Checking that the root exists is not enough: a half-installed SDK still has a
 * directory, and the miss would otherwise surface much later as a missing `adb` or a
 * Gradle stack trace. `marker` is both what is tested and what the failure message
 * names, so the two cannot disagree. Gradle is absent because it creates its own home
 * on first use — requiring one would fail on a machine that has never run Gradle.
 */
const COMPONENTS = {
  jdk: {
    marker: path.join("bin", `java${EXE}`),
    /** Beyond the marker: an Android build cannot run on Java 8. */
    requirement: `JDK ${V.JDK_MAJOR} or newer`,
    extra: (dir, ctx) => {
      const major = jdkMajor(dir, ctx.readFile);
      // An unreadable `release` file means the version is unknown. Let it through and
      // let the build report the real problem, rather than refusing a working JDK.
      return major === undefined || major >= V.JDK_MAJOR;
    },
  },
  sdk: {
    marker: path.join("platform-tools", `adb${EXE}`),
    extra: () => true,
  },
  gradleHome: {
    /**
     * A directory that can actually *reuse* a Gradle install.
     *
     * The marker is the wrapper distribution cache, because that is the difference between a
     * warm home and a useless one. Without this entry `gradleHome` fell through to a bare
     * existence check, and on this machine that selected `C:\Users\<user>\.gradle` -- which
     * exists but holds only `daemon/ native/ notifications/`, no `wrapper/dists` and no
     * `caches`. The warmed home beside the repo was never consulted, so the build fell back to
     * `gradlew.bat` and hung downloading Gradle and every dependency: the exact trap that made
     * the previously hardcoded path worth having.
     */
    marker: path.join("wrapper", "dists"),
    /**
     * Absence is not fatal -- Gradle creates its home on first run -- so this one is optional
     * and its state is reported through `gradleHomeExists`.
     */
    optional: true,
    extra: () => true,
  },
};

/**
 * The JDK's major version, from the `release` file every modern JDK ships.
 *
 * Read rather than executed: spawning `java -version` once per candidate would be slow
 * and would run whatever binary happens to be in that directory.
 */
function jdkMajor(jdkDir, readFile) {
  try {
    // `JAVA_VERSION="1.8.0_504"` is how Java 8 spells itself, hence the optional `1.`.
    const match = /^JAVA_VERSION="(?:1\.)?(\d+)/m.exec(readFile(path.join(jdkDir, "release")));
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Android build toolchain without hardcoding where it lives.
 *
 * These paths used to be absolute (`E:\code\Eng\...`), so the build only ran on the
 * one machine they were written for. Every component is now looked up in a fixed
 * order — explicit argument, environment variable, a git-ignored directory beside the
 * repository, then the platform's usual locations — and a miss reports every place it
 * looked, so what to do next is obvious from the error alone.
 *
 * The lookup is deliberately split: `candidatesFor` is pure and is what the tests
 * assert on, `resolveToolchain` adds the filesystem check.
 */

/** Where each component may live, most specific first. Pure — no filesystem access. */
const CANDIDATE_SOURCES = {
  jdk: ({ overrides, env, local, home, listDirs, engRoot }) => [
    overrides.jdk,
    env.MOBILECLAW_JDK,
    env.JAVA_HOME,
    local,
    // A pre-existing checkout beside the repository (MOBILECLAW_ENG_ROOT). Its JDK is named
    // `.jdkNN`, so the directory is listed rather than guessed.
    ...(engRoot ? listDirs(engRoot).filter((dir) => /\.jdk\d+$/i.test(dir)) : []),
    // JetBrains and the IntelliJ toolchain downloader both land here.
    ...listDirs(path.join(home, ".jdks")),
    ...listDirs("/usr/lib/jvm"),
  ],

  sdk: ({ overrides, env, local, home, engRoot }) => [
    overrides.sdk,
    env.MOBILECLAW_ANDROID_SDK,
    // ANDROID_HOME first: it is the one Google's own tooling sets.
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    local,
    ...(engRoot ? [path.join(engRoot, ".android-sdk")] : []),
    path.join(home, "AppData", "Local", "Android", "Sdk"),
    path.join(home, "Library", "Android", "sdk"),
    path.join(home, "Android", "Sdk"),
  ],

  gradleHome: ({ overrides, env, local, home, engRoot }) => [
    overrides.gradleHome,
    env.MOBILECLAW_GRADLE_HOME,
    env.GRADLE_USER_HOME,
    local,
    // A pre-existing checkout beside the repository (MOBILECLAW_ENG_ROOT). Both spellings are
    // tried: `setup-toolchain.ps1` would use `gradle-home`, while a hand-built machine tends to
    // use the dot-prefixed `.gradle-home`.
    ...(engRoot ? [path.join(engRoot, "gradle-home"), path.join(engRoot, ".gradle-home")] : []),
    path.join(home, ".gradle"),
  ],
};

function candidatesFor(kind, ctx = {}) {
  const build = CANDIDATE_SOURCES[kind];
  // Checked before anything touches LOCAL_SUBDIRS, so a typo produces this message
  // rather than a TypeError about an undefined path segment.
  if (!build) {
    throw new Error(
      `unknown toolchain component: ${kind} (expected one of ${Object.keys(CANDIDATE_SOURCES).join(", ")})`,
    );
  }

  const {
    repoRoot,
    overrides = {},
    env = {},
    home = os.homedir(),
    listDirs = () => [],
    readFile = (file) => fs.readFileSync(file, "utf8"),
  } = ctx;

  const local = repoRoot ? path.join(repoRoot, V.LOCAL_DIR, V.LOCAL_SUBDIRS[kind]) : undefined;

  /**
   * A directory that holds an already-checked-out toolchain beside the repository.
   *
   * `eng/setup-toolchain.ps1` installs into `.toolchain/`, but a machine that was set up
   * before this resolver existed keeps its toolchain elsewhere -- on this one, `E:\code\Eng`.
   * Honouring an explicit `MOBILECLAW_ENG_ROOT` gives those machines a supported way to say
   * where it is, instead of requiring every component to be exported separately.
   */
  const engRoot = env.MOBILECLAW_ENG_ROOT;

  // An explicit answer from the local file wins over everything else, including JAVA_HOME.
  // That ordering matters: this machine has jdk-24 in JAVA_HOME, and jdk-24 breaks the CMake
  // configuration step of `react-native-worklets` ("A restricted method in java.lang.System
  // has been called"), so a generic environment variable silently selected a JDK that cannot
  // build this repo while a working JDK 21 sat one directory away.
  const pinned = readLocalConfig(repoRoot, readFile)[FLAG_TO_ENV[kind]];
  const merged = { ...env };

  return clean(
    [pinned, ...build({ overrides, env: merged, local, home, listDirs, engRoot })],
  );
}

/** Component name to the environment variable that names it outright. */
const FLAG_TO_ENV = { jdk: "MOBILECLAW_JDK", sdk: "MOBILECLAW_ANDROID_SDK", gradleHome: "MOBILECLAW_GRADLE_HOME" };

/**
 * Read `<repo>/.toolchain/.config`.
 *
 * Per-machine settings that must not be committed: where the toolchain actually lives, and
 * which JDK to use. Without this, every build depends on environment variables being exported
 * in the current shell -- which is how this machine ended up building with a JDK that fails.
 *
 * Format is deliberately dull, one `KEY=VALUE` per line, `#` for comments. Anything
 * unrecognised is ignored rather than fatal, so a hand-edited file cannot break the build in a
 * confusing way.
 */
function readLocalConfig(repoRoot, readFile) {
  if (!repoRoot) return {};
  try {
    const text = readFile(path.join(repoRoot, V.LOCAL_DIR, ".config"));
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Tolerate a quoted value, which is how a path with spaces gets written down.
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && value) out[key] = value;
    }
    return out;
  } catch {
    // Absent is the normal case on a fresh clone.
    return {};
  }
}

/** Drop blank values (an unset environment variable arrives as "" or undefined) and normalise. */
function clean(values) {
  return values
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => path.resolve(value));
}

/**
 * Pick one directory per component, or explain what could not be found.
 *
 * `ctx.exists` and `ctx.listDirs` are injectable so the tests can describe a machine
 * without creating one.
 */
function resolveToolchain(ctx = {}) {
  const exists = ctx.exists ?? ((candidate) => fs.existsSync(candidate));
  const readFile = ctx.readFile ?? ((file) => fs.readFileSync(file, "utf8"));
  const listDirs = ctx.listDirs ?? realListDirs;
  const repoRoot = ctx.repoRoot;

  const found = {};
  const searched = {};

  for (const kind of ["jdk", "sdk", "gradleHome"]) {
    const candidates = candidatesFor(kind, { ...ctx, listDirs });
    searched[kind] = candidates;

    if (kind === "gradleHome") {
      // Prefer a home that can actually reuse a Gradle install, then any existing directory,
      // then the conventional location. `marker` is `wrapper/dists`; a bare existing directory
      // is not enough, because `~/.gradle` with only daemon state in it forces a full
      // re-download while looking like a perfectly good choice.
      const usable = candidates.find((dir) => exists(path.join(dir, COMPONENTS.gradleHome.marker)));
      found[kind] = usable ?? candidates.find(exists) ?? candidates[0];
      continue;
    }

    const spec = COMPONENTS[kind];
    const hit = candidates.find(
      (dir) =>
        exists(path.join(dir, spec.marker)) && spec.extra(dir, { readFile, exists }),
    );
    if (hit) {
      found[kind] = hit;
      continue;
    }

    throw new Error(
      [
        `no usable ${LABELS[kind]} found.`,
        `Looked for ${spec.marker} in:`,
        ...(candidates.length > 0
          ? candidates.map((candidate) => `  ${candidate}`)
          : ["  (nothing to try — no explicit path, environment variable or local directory)"]),
        ...(spec.requirement ? ["", `Note: ${spec.requirement} is required; older JDKs were skipped.`] : []),
        "",
        "Fix by either:",
        `  installing one:  powershell -NoProfile -File eng/setup-toolchain.ps1`,
        `  pointing at one: set JAVA_HOME / ANDROID_HOME (or MOBILECLAW_JDK / MOBILECLAW_ANDROID_SDK)`,
        `  putting it in:   ${path.join(repoRoot ?? "<repo>", V.LOCAL_DIR, V.LOCAL_SUBDIRS[kind])}`,
      ].join("\n"),
    );
  }

  return {
    ...found,
    /** False when Gradle will have to create its home; the build still works, just colder. */
    gradleHomeExists: exists(found.gradleHome),
    // Derived for callers, so nothing else has to remember the SDK/JDK layout.
    java: path.join(found.jdk, "bin", `java${EXE}`),
    keytool: path.join(found.jdk, "bin", `keytool${EXE}`),
    adb: path.join(found.sdk, "platform-tools", `adb${EXE}`),
    ninjaCandidates: [V.CMAKE_VERSION, V.CMAKE_TEMPLATE_VERSION].map((version) =>
      path.join(found.sdk, "cmake", version, "bin", `ninja${EXE}`),
    ),
    searched,
  };
}

function realListDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** `--jdk <path>` and friends, so a caller can override the lookup without setting env vars. */
const FLAG_TO_KIND = { "--jdk": "jdk", "--sdk": "sdk", "--gradle-home": "gradleHome" };

function parseOverrides(argv) {
  const overrides = {};
  for (let index = 0; index < argv.length; index += 1) {
    const kind = FLAG_TO_KIND[argv[index]];
    const value = argv[index + 1];
    // A flag with no value, or followed by another flag, is a mistake; ignoring it
    // beats resolving the toolchain to a path literally called "--sdk".
    if (!kind || value === undefined || value.startsWith("--")) continue;
    overrides[kind] = value;
    index += 1;
  }
  return overrides;
}

function main(argv) {
  const command = argv[2] ?? "print";
  if (command !== "print") {
    process.stderr.write("usage: node eng/toolchain.cjs print [--jdk <path>] [--sdk <path>] [--gradle-home <path>]\n");
    return 2;
  }

  try {
    const resolved = resolveToolchain({
      repoRoot: path.resolve(__dirname, ".."),
      env: process.env,
      overrides: parseOverrides(argv.slice(3)),
    });
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { candidatesFor, jdkMajor, parseOverrides, resolveToolchain, realListDirs };
