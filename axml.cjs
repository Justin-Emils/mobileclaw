const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// --- extract AndroidManifest.xml from the APK without external deps -------
function readManifest(apkPath) {
  const buf = fs.readFileSync(apkPath);
  // Walk the central directory to find the entry.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD not found");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central dir");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === "AndroidManifest.xml") {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("AndroidManifest.xml not found");
}

// --- minimal AXML decoder -------------------------------------------------
function decodeAxml(b) {
  const strings = [];
  let pos = 8;
  let out = [];
  while (pos < b.length) {
    const type = b.readUInt16LE(pos);
    const size = b.readUInt32LE(pos + 4);
    if (size <= 0) break;
    if (type === 0x0001) { // string pool
      const count = b.readUInt32LE(pos + 8);
      const isUtf8 = (b.readUInt32LE(pos + 16) & (1 << 8)) !== 0;
      let sp = pos + 28;
      const offsets = [];
      for (let i = 0; i < count; i++) { offsets.push(b.readUInt32LE(sp)); sp += 4; }
      for (const o of offsets) {
        const at = pos + 28 + count * 4 + o;
        if (isUtf8) {
          let len = b[at]; let p = at + 1;
          if (len & 0x80) { len = ((len & 0x7f) << 8) | b[p]; p++; }
          p++; // utf16 length
          strings.push(b.toString("utf8", p, p + len));
        } else {
          let len = b.readUInt16LE(at); let p = at + 2;
          if (len & 0x8000) { len = ((len & 0x7fff) << 16) | b.readUInt16LE(p); p += 2; }
          strings.push(b.toString("utf16le", p, p + len * 2).replace(/\0+$/, ""));
        }
      }
    } else if (type === 0x0102) { // START_ELEMENT
      const nameIdx = b.readUInt32LE(pos + 20);
      const attrStart = b.readUInt16LE(pos + 24);
      const attrCount = b.readUInt16LE(pos + 28);
      const attrs = [];
      for (let i = 0; i < attrCount; i++) {
        const a = pos + 16 + attrStart + i * 20;
        const aName = strings[b.readUInt32LE(a + 4)];
        const aRaw = b.readInt32LE(a + 8);
        const aType = b[a + 15];
        let val;
        if (aRaw >= 0 && aRaw < strings.length) val = strings[aRaw];
        else val = "0x" + b.readUInt32LE(a + 16).toString(16);
        attrs.push(`${aName}=${val}`);
      }
      out.push(`<${strings[nameIdx]} ${attrs.join(" ")}>`);
    }
    pos += size;
  }
  return out;
}

const apk = process.argv[2];
const manifest = readManifest(apk);
const lines = decodeAxml(manifest);
const joined = lines.join("\n");
const wanted = process.argv.slice(3);
if (wanted.length) {
  for (const w of wanted) {
    const hit = lines.filter((l) => l.includes(w));
    console.log(`\n### ${w}  (${hit.length} match)`);
    for (const h of hit.slice(0, 6)) console.log("   " + h.trim());
  }
} else {
  console.log(lines.join("\n"));
}
