/**
 * Send one message on the emulator's chat screen.
 *
 * The lesson this encodes: `uiautomator` reports a node that is **outside the viewport**
 * with `bounds=[0,0]`, so tapping "the field's centre" taps the top-left corner instead.
 * Every earlier attempt failed this way. So: scroll the composer into view, re-locate it,
 * and verify the text actually landed before pressing send.
 *
 * Usage: node eng/emulator-send-message.cjs "<message>"
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const ADB = "E:\\code\\Eng\\.android-sdk\\platform-tools\\adb.exe";
const message = process.argv[2] ?? "list the folder";

const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dump(name = "drive") {
  adb("shell", "uiautomator", "dump", `/sdcard/${name}.xml`);
  adb("pull", `/sdcard/${name}.xml`, `.logs/${name}.xml`);
  return fs.readFileSync(`.logs/${name}.xml`, "utf8");
}

const texts = (xml) => [...xml.matchAll(/text="([^"]*)"/g)].map((m) => m[1]).filter((t) => t.trim() !== "");

/** Every editable node with usable (on-screen) bounds. */
function editables(xml) {
  return [...xml.matchAll(/<node[^>]*class="android\.widget\.EditText"[^>]*>/g)]
    .map((match) => {
      const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(match[0]);
      const x1 = Number(bounds[1]);
      const y1 = Number(bounds[2]);
      const x2 = Number(bounds[3]);
      const y2 = Number(bounds[4]);
      return {
        text: /text="([^"]*)"/.exec(match[0])?.[1] ?? "",
        x: Math.round((x1 + x2) / 2),
        y: Math.round((y1 + y2) / 2),
        // [0,0][0,0] means off-screen: tapping it would hit the wrong place entirely.
        offscreen: x2 === 0 && y2 === 0,
      };
    })
    .filter((field) => !field.offscreen);
}

function tapText(xml, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`text="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(xml);
  if (!match) return false;
  adb("shell", "input", "tap", String(Math.round((Number(match[1]) + Number(match[3])) / 2)), String(Math.round((Number(match[2]) + Number(match[4])) / 2)));
  return true;
}

/** Scroll a little and report whether the composer became reachable. */
async function revealComposer() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const xml = dump();
    const field = editables(xml)[0];
    if (field && texts(xml).includes("发送")) return { xml, field };
    // Upward swipe brings lower content into view (send is below the list).
    adb("shell", "input", "swipe", "540", "1600", "540", "1100", "300");
    await sleep(1200);
  }
  return null;
}

(async () => {
  // Reach the chat screen first.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const xml = dump();
    if (texts(xml).includes("发送") && editables(xml).length > 0) break;
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    await sleep(2500);
  }

  const revealed = await revealComposer();
  if (!revealed) throw new Error("composer never became visible");
  const { field } = revealed;
  console.log(`composer at (${field.x}, ${field.y}), existing text "${field.text}"`);

  adb("shell", "input", "tap", String(field.x), String(field.y));
  await sleep(900);
  // Spaces are unreliable through `input text`; underscores are close enough for a mock.
  adb("shell", "input", "text", message.replace(/ /g, "_"));
  await sleep(900);

  const afterTyping = editables(dump())[0];
  console.log(`after typing, field reads "${afterTyping?.text ?? "(gone)"}"`);
  if (!afterTyping || afterTyping.text === "") {
    throw new Error("typing did not reach the field");
  }

  if (!tapText(dump(), "发送")) throw new Error('could not find "发送"');
  console.log("tapped 发送");
})();
