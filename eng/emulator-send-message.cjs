/**
 * Drive one real agent turn on the emulator: return to the chat, type a message, send.
 *
 * Used to exercise the end-to-end flow that unit tests cannot reach: the app talks to
 * the mock OpenAI server (eng/mock-openai-server.cjs), calls a tool, streams an answer,
 * and persists the conversation.
 *
 * Usage: node eng/emulator-send-message.cjs "<message>"
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const ADB = "E:\\code\\Eng\\.android-sdk\\platform-tools\\adb.exe";
const message = process.argv[2] ?? "list the download folder";

const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dump(name = "drive") {
  adb("shell", "uiautomator", "dump", `/sdcard/${name}.xml`);
  adb("pull", `/sdcard/${name}.xml`, `.logs/${name}.xml`);
  return fs.readFileSync(`.logs/${name}.xml`, "utf8");
}

function texts(xml) {
  return [...xml.matchAll(/text="([^"]*)"/g)].map((m) => m[1]).filter((t) => t.trim() !== "");
}

function tapText(xml, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`text="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(xml);
  if (!match) return false;
  adb("shell", "input", "tap", String(Math.round((Number(match[1]) + Number(match[3])) / 2)), String(Math.round((Number(match[2]) + Number(match[4])) / 2)));
  return true;
}

/** The composer is the only editable field on the chat screen. */
function composer(xml) {
  const nodes = [...xml.matchAll(/<node[^>]*class="android\.widget\.EditText"[^>]*>/g)];
  if (nodes.length === 0) return null;
  const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(nodes[0][0]);
  return {
    x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
    y: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2),
  };
}

(async () => {
  // Back out of whatever screen is open until the composer is visible.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const xml = dump();
    const field = composer(xml);
    if (field && texts(xml).some((t) => t === "发送")) {
      console.log("chat screen reached");
      break;
    }
    console.log(`  not on the chat screen (attempt ${attempt + 1}), pressing back`);
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    await sleep(2500);
  }

  let xml = dump();
  const field = composer(xml);
  if (!field) throw new Error("no composer field on screen");
  adb("shell", "input", "tap", String(field.x), String(field.y));
  await sleep(800);
  // Spaces would be lost by `input text`; use underscores and let the model cope.
  adb("shell", "input", "text", message.replace(/ /g, "_"));
  await sleep(800);
  const typed = texts(dump());
  console.log(`  typed: ${typed.find((t) => t.includes("_")) ?? "(not visible)"}`);

  xml = dump();
  if (!tapText(xml, "发送")) throw new Error('could not find "发送"');
  console.log("  tapped 发送");
})();
