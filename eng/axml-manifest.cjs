#!/usr/bin/env node
/**
 * Print the compiled AndroidManifest.xml of an APK as readable XML.
 *
 * Why this exists: there is no Android SDK on this machine, so `aapt2 dump xmltree`
 * is unavailable. This is a dependency-free decoder for the parts of the binary
 * AXML format we care about (string pool + start elements), which is exactly what
 * is needed to verify that config plugins actually produced the manifest we
 * intended — after the *same* plugins silently failed to drop a permission once.
 *
 * Usage:
 *   node eng/axml-manifest.cjs app.apk                 # all start elements
 *   node eng/axml-manifest.cjs app.apk MANAGE_EXTERNAL_STORAGE com.termux
 */
const fs = require("node:fs");
const zlib = require("node:zlib");

/** Read one entry out of a zip without a zip library. */
function readEntry(apkPath, entryName) {
  const buf = fs.readFileSync(apkPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("end of central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory header");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === entryName) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${entryName} not found in ${apkPath}`);
}

/** Decode binary AXML into `<tag attr=value>` lines. */
function decodeAxml(bytes) {
  const strings = [];
  const lines = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const type = bytes.readUInt16LE(pos);
    const size = bytes.readUInt32LE(pos + 4);
    if (size <= 0 || pos + size > bytes.length) break;

    if (type === 0x0001) {
      const count = bytes.readUInt32LE(pos + 8);
      const isUtf8 = (bytes.readUInt32LE(pos + 16) & (1 << 8)) !== 0;
      const offsets = [];
      let sp = pos + 28;
      for (let i = 0; i < count; i += 1) {
        offsets.push(bytes.readUInt32LE(sp));
        sp += 4;
      }
      for (const o of offsets) {
        const at = pos + 28 + count * 4 + o;
        if (isUtf8) {
          let len = bytes[at];
          let p = at + 1;
          if (len & 0x80) {
            len = ((len & 0x7f) << 8) | bytes[p];
            p += 1;
          }
          p += 1; // utf-16 length prefix
          strings.push(bytes.toString("utf8", p, p + len));
        } else {
          let len = bytes.readUInt16LE(at);
          let p = at + 2;
          if (len & 0x8000) {
            len = ((len & 0x7fff) << 16) | bytes.readUInt16LE(p);
            p += 2;
          }
          strings.push(bytes.toString("utf16le", p, p + len * 2).replace(/\0+$/, ""));
        }
      }
    } else if (type === 0x0102) {
      const nameIdx = bytes.readUInt32LE(pos + 20);
      const attrStart = bytes.readUInt16LE(pos + 24);
      const attrCount = bytes.readUInt16LE(pos + 28);
      const attrs = [];
      for (let i = 0; i < attrCount; i += 1) {
        const a = pos + 16 + attrStart + i * 20;
        const aName = strings[bytes.readUInt32LE(a + 4)];
        const aRaw = bytes.readInt32LE(a + 8);
        const val =
          aRaw >= 0 && aRaw < strings.length
            ? strings[aRaw]
            : `0x${bytes.readUInt32LE(a + 16).toString(16)}`;
        attrs.push(`${aName}=${val}`);
      }
      lines.push(`<${strings[nameIdx]} ${attrs.join(" ")}>`);
    }
    pos += size;
  }
  return lines;
}

function main() {
  const [, , apk, ...wanted] = process.argv;
  if (!apk) {
    console.error("usage: node eng/axml-manifest.cjs <app.apk> [substring ...]");
    process.exit(2);
  }
  const lines = decodeAxml(readEntry(apk, "AndroidManifest.xml"));
  if (wanted.length === 0) {
    console.log(lines.join("\n"));
    return;
  }
  for (const needle of wanted) {
    const hits = lines.filter((line) => line.includes(needle));
    console.log(`### ${needle} (${hits.length})`);
    for (const hit of hits) console.log(`  ${hit.trim()}`);
  }
}

main();
