"use strict";

/**
 * Tests for the toolchain resolver, run with Node's built-in runner:
 *
 *   node --test eng/
 *
 * The resolver takes injectable `exists` and `listDirs`, so a machine is described by
 * a list of paths rather than created on disk. That keeps these tests fast and means
 * they cannot pass by accident on a machine that happens to have a real SDK.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const V = require("./toolchain-versions.cjs");
const { candidatesFor, jdkMajor, parseOverrides, resolveToolchain } = require("./toolchain.cjs");

const REPO = abs("repo");
const HOME = abs("home");
const EXE = process.platform === "win32" ? ".exe" : "";

/**
 * An absolute path in the same form `clean()` produces.
 *
 * `clean()` runs every candidate through `path.resolve`, which on Windows attaches the
 * current drive to a rooted-but-driveless path (`\repo` becomes `C:\repo`). Building
 * fixtures the same way keeps the expectations comparable on both platforms.
 */
function abs(...segments) {
  return path.resolve(path.sep, ...segments);
}

/** The marker files the resolver insists on, so tests do not repeat the layout. */
const jdkMarker = (root) => path.join(root, "bin", `java${EXE}`);
const sdkMarker = (root) => path.join(root, "platform-tools", `adb${EXE}`);

const localJdk = path.join(REPO, V.LOCAL_DIR, V.LOCAL_SUBDIRS.jdk);
const localSdk = path.join(REPO, V.LOCAL_DIR, V.LOCAL_SUBDIRS.sdk);
const localGradle = path.join(REPO, V.LOCAL_DIR, V.LOCAL_SUBDIRS.gradleHome);

/** A machine described by which paths exist. */
const machine = (...existing) => {
  const set = new Set(existing.map((entry) => path.resolve(entry)));
  return { exists: (candidate) => set.has(path.resolve(candidate)), listDirs: () => [] };
};

/**
 * A machine that also knows what each JDK's `release` file says, so the version check
 * can be exercised without installing a JDK.
 */
const withJdkVersions = (versions, ...existing) => ({
  ...machine(...existing),
  readFile: (file) => {
    const dir = path.resolve(path.dirname(file));
    const version = versions[dir];
    if (version === undefined) throw new Error(`ENOENT: ${file}`);
    return `JAVA_VERSION="${version}"\n`;
  },
});

const failing = (run) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the resolver to fail, but it returned");
};

test("an explicit argument beats every other source", () => {
  const explicit = abs("opt", "explicit-jdk");
  const fromEnv = abs("opt", "env-jdk");

  const list = candidatesFor("jdk", {
    repoRoot: REPO,
    home: HOME,
    overrides: { jdk: explicit },
    env: { JAVA_HOME: fromEnv },
  });

  assert.equal(list[0], explicit);
  assert.ok(list.indexOf(fromEnv) < list.indexOf(localJdk));
  assert.ok(list.indexOf(localJdk) < list.length, "the repo-adjacent directory is still offered");
});

test("the repo-adjacent directory is offered ahead of the platform's usual locations", () => {
  const list = candidatesFor("sdk", { repoRoot: REPO, home: HOME, env: {} });

  assert.ok(list.includes(localSdk));
  assert.ok(list.indexOf(localSdk) < list.indexOf(path.join(HOME, "AppData", "Local", "Android", "Sdk")));
  assert.ok(list.indexOf(localSdk) < list.indexOf(path.join(HOME, "Library", "Android", "sdk")));
});

test("ANDROID_HOME wins over ANDROID_SDK_ROOT", () => {
  const first = abs("opt", "sdk-from-home");
  const second = abs("opt", "sdk-from-root");

  const list = candidatesFor("sdk", {
    repoRoot: REPO,
    home: HOME,
    env: { ANDROID_HOME: first, ANDROID_SDK_ROOT: second },
  });

  assert.ok(list.indexOf(first) < list.indexOf(second));
});

test("unset and blank environment variables are ignored rather than treated as paths", () => {
  const list = candidatesFor("jdk", {
    repoRoot: REPO,
    home: HOME,
    env: { MOBILECLAW_JDK: "", JAVA_HOME: "   " },
  });

  assert.deepEqual(list, [localJdk]);
});

test("JDKs discovered under ~/.jdks are offered as candidates", () => {
  const discovered = path.join(HOME, ".jdks", "temurin-21");

  const list = candidatesFor("jdk", {
    repoRoot: REPO,
    home: HOME,
    env: {},
    listDirs: (dir) => (dir === path.join(HOME, ".jdks") ? [discovered] : []),
  });

  assert.ok(list.includes(discovered));
});

test("resolves to the first candidate that actually contains the required binary", () => {
  const fromEnv = abs("opt", "env-jdk");
  // Only the local copy is complete; the environment variable points at nothing.
  const resolved = resolveToolchain({
    repoRoot: REPO,
    home: HOME,
    env: { JAVA_HOME: fromEnv },
    ...machine(jdkMarker(localJdk), sdkMarker(localSdk)),
  });

  assert.equal(resolved.jdk, localJdk);
  assert.equal(resolved.sdk, localSdk);
});

test("a directory that exists without the required binary does not count as installed", () => {
  // The half-installed case: the root is there, the contents are not. Accepting the
  // root would move the failure much later, to a missing `adb` mid-build.
  const empty = abs("opt", "half-jdk");
  const message = failing(() =>
    resolveToolchain({ repoRoot: REPO, home: HOME, env: { JAVA_HOME: empty }, ...machine(empty) }),
  );

  assert.match(message, /no usable JDK found/);
});

test("a miss names every location that was tried, and how to fix it", () => {
  const fromEnv = abs("opt", "env-jdk");
  const message = failing(() =>
    resolveToolchain({ repoRoot: REPO, home: HOME, env: { JAVA_HOME: fromEnv }, ...machine() }),
  );

  assert.match(message, /no usable JDK found/);
  assert.ok(message.includes(fromEnv), "should name the JAVA_HOME candidate");
  assert.ok(message.includes(localJdk), "should name the repo-adjacent directory");
  assert.match(message, /setup-toolchain\.ps1/, "should say how to install one");
});

test("derives the executables and ninja probes from the resolved roots", () => {
  const jdk = abs("opt", "jdk");
  const sdk = abs("opt", "android-sdk");

  const resolved = resolveToolchain({
    repoRoot: REPO,
    home: HOME,
    env: {},
    overrides: { jdk, sdk },
    ...machine(jdkMarker(jdk), sdkMarker(sdk)),
  });

  assert.equal(resolved.java, path.join(jdk, "bin", `java${EXE}`));
  assert.equal(resolved.keytool, path.join(jdk, "bin", `keytool${EXE}`));
  assert.equal(resolved.adb, path.join(sdk, "platform-tools", `adb${EXE}`));
  // Both CMake copies ship a ninja that has to be replaced, so both are probed.
  assert.deepEqual(
    resolved.ninjaCandidates,
    [V.CMAKE_VERSION, V.CMAKE_TEMPLATE_VERSION].map((version) =>
      path.join(sdk, "cmake", version, "bin", `ninja${EXE}`),
    ),
  );
});

test("Gradle home resolves even when nothing exists, because Gradle creates it", () => {
  const jdk = abs("opt", "jdk");
  const sdk = abs("opt", "android-sdk");
  const base = { repoRoot: REPO, home: HOME, env: {}, overrides: { jdk, sdk } };

  const cold = resolveToolchain({ ...base, ...machine(jdkMarker(jdk), sdkMarker(sdk)) });
  assert.equal(cold.gradleHome, localGradle);
  assert.equal(cold.gradleHomeExists, false);

  const warmHome = path.join(HOME, ".gradle");
  const warm = resolveToolchain({ ...base, ...machine(jdkMarker(jdk), sdkMarker(sdk), warmHome) });
  assert.equal(warm.gradleHome, warmHome, "an existing cache is reused in preference to an empty one");
  assert.equal(warm.gradleHomeExists, true);
});

test("a missing Gradle home never fails the resolution", () => {
  const jdk = abs("opt", "jdk");
  const sdk = abs("opt", "android-sdk");

  const resolved = resolveToolchain({
    repoRoot: REPO,
    home: HOME,
    env: {},
    overrides: { jdk, sdk },
    ...machine(jdkMarker(jdk), sdkMarker(sdk)),
  });

  assert.equal(typeof resolved.gradleHome, "string");
});

test("a Java 8 release file reads as major 8, not 1", () => {
  // `JAVA_VERSION="1.8.0_504"` is how Java 8 spells itself. Parsing the leading 1 would
  // report the oldest JDK on the machine as acceptable.
  assert.equal(jdkMajor(abs("opt", "jdk8"), () => 'JAVA_VERSION="1.8.0_504"\n'), 8);
  assert.equal(jdkMajor(abs("opt", "jdk21"), () => 'JAVA_VERSION="21.0.12"\n'), 21);
  assert.equal(
    jdkMajor(abs("opt", "nothing"), () => {
      throw new Error("ENOENT");
    }),
    undefined,
    "an unreadable release file means the version is unknown",
  );
});

test("a JDK older than the required major is skipped in favour of a newer one", () => {
  const old = abs("opt", "jdk8");
  const current = abs("opt", "jdk21");

  const resolved = resolveToolchain({
    repoRoot: REPO,
    home: HOME,
    // The old one is offered first, so only the version check can reject it.
    env: { MOBILECLAW_JDK: old, JAVA_HOME: current },
    ...withJdkVersions(
      { [old]: "1.8.0_504", [current]: "21.0.12" },
      jdkMarker(old),
      jdkMarker(current),
      sdkMarker(localSdk),
    ),
  });

  assert.equal(resolved.jdk, current);
});

test("when every JDK is too old, the failure names the requirement", () => {
  const old = abs("opt", "jdk8");
  const message = failing(() =>
    resolveToolchain({
      repoRoot: REPO,
      home: HOME,
      env: { MOBILECLAW_JDK: old },
      ...withJdkVersions({ [old]: "1.8.0_504" }, jdkMarker(old), sdkMarker(localSdk)),
    }),
  );

  assert.match(message, /no usable JDK found/);
  assert.match(message, new RegExp(`JDK ${V.JDK_MAJOR} or newer is required`));
  assert.ok(message.includes(old), "should name the JDK it rejected, not just say none was found");
});

test("an unknown JDK version is accepted rather than refused", () => {
  // Without a `release` file there is nothing to compare; failing here would reject a
  // working JDK, and the build reports a bad Java version far more clearly anyway.
  const mystery = abs("opt", "jdk-mystery");
  const resolved = resolveToolchain({
    repoRoot: REPO,
    home: HOME,
    env: { MOBILECLAW_JDK: mystery },
    ...machine(jdkMarker(mystery), sdkMarker(localSdk)),
  });

  assert.equal(resolved.jdk, mystery);
});

test("an unknown component is a programming error, not a silent empty list", () => {
  assert.throws(() => candidatesFor("kotlin", { repoRoot: REPO, home: HOME }), /unknown toolchain component/);
});

test("the CLI's flags become overrides, and anything malformed is ignored", () => {
  assert.deepEqual(parseOverrides(["--jdk", abs("a"), "--sdk", abs("b"), "--gradle-home", abs("c")]), {
    jdk: abs("a"),
    sdk: abs("b"),
    gradleHome: abs("c"),
  });

  assert.deepEqual(parseOverrides([]), {});
  assert.deepEqual(parseOverrides(["something-else"]), {});
  assert.deepEqual(parseOverrides(["--jdk"]), {}, "a flag with no value is not an override");
  // Rejecting a flag-as-value matters: otherwise `--jdk --sdk X` would resolve the JDK
  // to a path literally called "--sdk".
  assert.deepEqual(parseOverrides(["--jdk", "--sdk", abs("b")]), { sdk: abs("b") });
});
