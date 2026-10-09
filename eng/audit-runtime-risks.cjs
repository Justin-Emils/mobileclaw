/**
 * Static runtime-risk audit.
 *
 * Finds things that would crash or misbehave on a device but that unit tests cannot
 * see, because unit tests never mount a component or run an effect: a string key that
 * does not exist, a runtime method that was never defined, an icon or hook that was
 * used without being imported.
 *
 * Run: node eng/audit-runtime-risks.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const problems = [];
const note = (ok, message) => {
  if (!ok) problems.push(message);
};

// ---------------------------------------------------------------- strings keys
const stringsSource = read("apps/mobile/src/ui/strings.ts");
const lines = stringsSource.split("\n");

/** Column-0-indented top-level blocks: `  chat: {`. */
function blockSpan(name) {
  const start = lines.findIndex((l) => l.startsWith(`  ${name}: {`));
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    depth += (lines[i].match(/\{/g) || []).length;
    depth -= (lines[i].match(/\}/g) || []).length;
    if (i > start && depth <= 0) return [start, i];
  }
  return null;
}

const screenFiles = [
  "apps/mobile/app/index.tsx",
  "apps/mobile/app/settings.tsx",
  "apps/mobile/app/conversations.tsx",
  "apps/mobile/app/permissions.tsx",
  // Every new screen has to be listed here or its `strings.*` references go unchecked —
  // which is how a typo reaches a device as literal `undefined` on screen.
  "apps/mobile/app/screen-probe.tsx",
];
const usage = new Set();
for (const file of screenFiles) {
  const text = read(file);
  for (const match of text.matchAll(/strings\.([A-Za-z]+)\.([A-Za-z]+)/g)) {
    usage.add(`${match[1]}.${match[2]}`);
  }
}

for (const used of [...usage].sort()) {
  const [block, key] = used.split(".");
  const span = blockSpan(block);
  if (!span) {
    problems.push(`strings.${used}: block "${block}" does not exist`);
    continue;
  }
  const body = lines.slice(span[0], span[1] + 1).join("\n");
  if (!new RegExp(`\\b${key}:`).test(body)) {
    problems.push(`strings.${used}: key "${key}" missing from block "${block}"`);
  }
}

// ------------------------------------------------------- runtime surface used
const runtimeSource = read("apps/mobile/src/runtime/runtime.ts");
const runtimeMethods = [
  "checkStorageAccess",
  "openStorageSettings",
  "checkStoragePermissions",
  "requestStoragePermissions",
  "getFlag",
  "setFlag",
  "listConversations",
  "loadConversation",
  "deleteConversation",
  "diagnostics",
];
for (const method of runtimeMethods) {
  const declared = new RegExp(`(async\\s+)?${method}\\s*\\(`).test(runtimeSource);
  note(declared, `MobileClawRuntime.${method} is called but not defined`);
}

// -------------------------------------------------- imports for used identifiers
const identifierImports = {
  "apps/mobile/app/index.tsx": [
    "useLocalSearchParams",
    "useRouter",
    "useFocusEffect",
    "useCallback",
    "useEffect",
    "useRef",
    "useState",
    "Pressable",
    "Clipboard",
  ],
  "apps/mobile/app/settings.tsx": ["useFocusEffect", "useCallback", "useState", "Pressable", "useRuntime"],
  "apps/mobile/app/conversations.tsx": ["useFocusEffect", "useRouter", "Pressable", "useState", "FlatList"],
};
for (const [file, identifiers] of Object.entries(identifierImports)) {
  const text = read(file);
  for (const identifier of identifiers) {
    if (!new RegExp(`\\b${identifier}\\b`).test(text)) continue; // not used, nothing to check
    const imported = /import[\s\S]*?from\s+["'][^"']+["']/.test(text) && new RegExp(`\\b${identifier}\\b`).test(text.slice(0, text.indexOf("\n\ninterface") === -1 ? 2000 : text.indexOf("\n\ninterface")));
    note(imported, `${file}: uses ${identifier} but it does not appear in the import block`);
  }
}

// ------------------------------------------------- routes referenced by Link
const appDir = path.join(root, "apps/mobile/app");
const routeFiles = fs.readdirSync(appDir).filter((f) => f.endsWith(".tsx"));
const routeNames = new Set([
  ...routeFiles.map((f) => `/${f.replace(/\.tsx$/, "")}`),
  "/",
  "/index",
]);
for (const file of screenFiles) {
  if (!fs.existsSync(path.join(root, file))) continue;
  for (const match of read(file).matchAll(/href="(\/[^"]*)"/g)) {
    note(routeNames.has(match[1]), `${file}: Link href="${match[1]}" has no matching route file`);
  }
}

// --------------------------------------------------------------------- report
if (problems.length === 0) {
  console.log("no runtime risks found");
  console.log(`checked ${usage.size} string references, ${runtimeMethods.length} runtime methods, ${routeNames.size} routes`);
} else {
  console.log(`${problems.length} potential runtime problem(s):`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
}
