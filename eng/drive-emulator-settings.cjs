/**
 * Drive the emulator's settings screen to point the app at the mock OpenAI server.
 *
 * Automating this is fiddly in a shell: the layout shifts as fields gain focus, and
 * `input text` corrupts a value if the previous one was not fully cleared. So each
 * field is located from a *fresh* UI dump, cleared with enough DEL presses, typed one
 * character at a time, and then verified by reading the field back.
 *
 * Usage: node eng/drive-emulator-settings.cjs <baseUrl> <model> <apiKey>
 */
const { execFileSync } = require("node:child_process");

const ADB = "E:\\code\\Eng\\.android-sdk\\platform-tools\\adb.exe";
const [baseUrl, model, apiKey] = process.argv.slice(2);
if (!baseUrl || !model || !apiKey) {
  console.error("usage: node drive-emulator-settings.cjs <baseUrl> <model> <apiKey>");
  process.exit(2);
}

const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pull the current view hierarchy. */
async function dump() {
  adb("shell", "uiautomator", "dump", "/sdcard/drive.xml");
  adb("pull", "/sdcard/drive.xml", ".logs/drive.xml");
  const fs = require("node:fs");
  return fs.readFileSync(".logs/drive.xml", "utf8");
}

/** Every editable field, in visual order. */
function fields(xml) {
  return [...xml.matchAll(/<node[^>]*class="android\.widget\.EditText"[^>]*>/g)].map((match) => {
    const text = /text="([^"]*)"/.exec(match[0])?.[1] ?? "";
    const hint = /hint="([^"]*)"/.exec(match[0])?.[1] ?? "";
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(match[0]);
    return {
      text,
      hint,
      /**
       * A field showing only its placeholder is empty.
       *
       * react-native's `placeholder` lands in the accessibility `text` attribute, which
       * made a read-back check fail forever: the field kept "reading" `sk-…` no matter
       * what was typed, so the driver retried and typed the key into the wrong field
       * once the layout shifted.
       */
      isEmpty: text === "" || text === hint,
      x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
      y: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2),
      order: Number(bounds[2]),
    };
  }).sort((a, b) => a.order - b.order);
}

function tapText(xml, label) {
  const match = new RegExp(`text="${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(xml);
  if (!match) return false;
  adb("shell", "input", "tap", String(Math.round((Number(match[1]) + Number(match[3])) / 2)), String(Math.round((Number(match[2]) + Number(match[4])) / 2)));
  return true;
}

/** Clear a field and type `value`, then confirm the field reads back as typed. */
async function setField(index, value) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = fields(await dump());
    const field = current[index];
    if (!field) throw new Error(`no field at index ${index}`);
    adb("shell", "input", "tap", String(field.x), String(field.y));
    await sleep(600);
    // Move to the end, then delete generously: the field may hold a longer value.
    adb("shell", "input", "keyevent", "KEYCODE_MOVE_END");
    adb("shell", "input", "keyevent", "--longpress", "KEYCODE_DEL");
    await sleep(400);
    // One `input text` is far quicker than per-character and proved reliable once the
    // placeholder confusion was removed; keep it as a single call.
    adb("shell", "input", "text", value);
    await sleep(700);
    const after = fields(await dump())[index];
    if (after && !after.isEmpty && after.text === value) return true;
    console.log(`    attempt ${attempt}: field ${index} reads "${after?.text ?? "?"}" (hint "${after?.hint ?? ""}"), retrying`);
  }
  return false;
}

/** Indices by meaning, not by position: the layout shifts as fields fill in. */
async function findIndices() {
  const current = fields(await dump());
  const empty = current.map((field, index) => ({ index, ...field })).filter((field) => field.isEmpty);
  return {
    baseUrl: 0,
    // The model field starts empty on the Custom preset, so it is the first empty one
    // that is not the base URL.
    model: empty.find((field) => field.index !== 0)?.index ?? 1,
    // The key field is distinguished by its placeholder.
    apiKey: current.findIndex((field) => field.hint && field.hint.includes("sk-")),
  };
}

(async () => {
  console.log("selecting Custom endpoint");
  let xml = await dump();
  if (!tapText(xml, "Custom endpoint")) throw new Error('could not find "Custom endpoint"');
  await sleep(2500);

  const indices = await findIndices();
  console.log(`  field indices: ${JSON.stringify(indices)}`);

  const plan = [
    { index: indices.baseUrl, value: baseUrl, label: "baseUrl" },
    { index: indices.model, value: model, label: "model" },
    { index: indices.apiKey, value: apiKey, label: "apiKey" },
  ];
  for (const step of plan) {
    if (step.index < 0) {
      console.log(`  ${step.label}: field not found`);
      process.exitCode = 1;
      continue;
    }
    const ok = await setField(step.index, step.value);
    console.log(`  ${step.label}: ${ok ? "ok" : "FAILED"}`);
    if (!ok) process.exitCode = 1;
  }

  // Persist the key: typing alone does not save it.
  xml = await dump();
  if (tapText(xml, "保存密钥")) {
    await sleep(2000);
    console.log("  tapped 保存密钥");
  } else {
    console.log("  could not find 保存密钥");
    process.exitCode = 1;
  }

  const final = fields(await dump());
  console.log("final field values:");
  final.forEach((field, index) => console.log(`  [${index}] "${field.text}" (hint "${field.hint}")`));
})();
