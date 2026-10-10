#!/usr/bin/env node
"use strict";

/**
 * `expo export`, with a temp directory the Hermes compiler is allowed to write to.
 *
 * ## The problem this works around
 *
 * `hermesc.exe` (shipped by `hermes-compiler`) is **unsigned**, and this machine enforces a
 * code-integrity policy that lets unsigned executables create files only inside the project.
 * The evidence, all of it reproducible:
 *
 *   - `hermesc -emit-binary -out <repo>\a.hbc a.js`            -> exit 0, file written
 *   - `hermesc -emit-binary -out C:\Temp\b.hbc a.js`           -> exit 6, "permission denied"
 *   - same source, same process, only the output path differs
 *   - `C:\Temp` has no Deny ACE (`icacls`), and PowerShell writes there happily
 *   - a *copy of node.exe* in `C:\Temp` writes a file there happily (signed: OpenJS Foundation)
 *   - `hermesc.exe` reports `NotSigned`
 *
 * `expo export` bundles through `%TEMP%\expo-bundler-*`, so the bytecode step fails there with
 *
 *     Failed to open file ...\index.hbc.<hex>: permission denied
 *     hermesc.exe ... exited with non-zero code: 6
 *
 * plus ~35 harmless "the variable X was not declared" warnings, which are Hermes' normal output
 * for React Native's injected globals and are not the error.
 *
 * ## The fix
 *
 * Point `TMPDIR`/`TEMP`/`TMP` at a directory inside the checkout before spawning the export, so
 * every temporary file — the bundle, and the bytecode Hermes derives from it — lands somewhere
 * the policy permits. Nothing else changes, and the exported output is identical.
 *
 * This is done here rather than in the npm script because a cross-platform env prefix in
 * `package.json` is not expressible, and a wrapper can also *say* why it exists. The
 * alternative — telling every developer to set `TEMP` by hand — is the kind of instruction that
 * gets lost and then reads as a mysterious build failure.
 *
 * Removing this is correct on a machine without that policy: the export would simply use the
 * system temp directory as usual. It is harmless either way.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..", "apps", "mobile");
/**
 * Inside the checkout, and inside `node_modules/` specifically.
 *
 * Both halves are load-bearing. It has to be inside the checkout because that is what the policy
 * permits; and it has to be somewhere already git-ignored so running the bundle does not dirty
 * the working tree. `node_modules/.cache` is the conventional place for exactly this and is
 * covered by the existing `node_modules/` rule, so no `.gitignore` entry is needed.
 */
const tempRoot = path.join(appRoot, "node_modules", ".cache", "mobileclaw-bundler");
fs.mkdirSync(tempRoot, { recursive: true });

const env = { ...process.env, TMPDIR: tempRoot, TEMP: tempRoot, TMP: tempRoot };

/**
 * The CLI entry point, resolved rather than looked up as a `node_modules/.bin` shim.
 *
 * pnpm hoists `expo` to the repository root, so `apps/mobile/node_modules/.bin/expo` does not
 * exist — and running the `.cmd` shim on Windows means quoting a path that may contain spaces.
 * Resolving the JavaScript entry and running it with the Node that is already executing this
 * file avoids both, and works the same on every platform.
 */
function resolveExpoCli() {
  try {
    return require.resolve("expo/bin/cli");
  } catch {
    return undefined;
  }
}

const expoCli = resolveExpoCli();
if (!expoCli) {
  console.error(
    "Could not resolve `expo/bin/cli`. Run `pnpm install` at the repository root first.",
  );
  process.exit(1);
}

console.log(`[bundle] temp dir = ${tempRoot}  (unsigned hermesc may only write inside the checkout)`);

const result = spawnSync(
  process.execPath,
  [
    expoCli,
    "export",
    "--platform",
    "android",
    "--output-dir",
    ".expo-export-check",
    ...process.argv.slice(2),
  ],
  { cwd: appRoot, env, stdio: "inherit" },
);

// `spawnSync` reports a signal as a null status; surfacing that as 1 keeps a killed build from
// looking like a successful one.
process.exit(result.status ?? 1);
