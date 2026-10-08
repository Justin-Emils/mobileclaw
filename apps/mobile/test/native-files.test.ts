import { describe, expect, it } from "vitest";
import type { FsDriver } from "@mobileclaw/capabilities";
import {
  base64ToBytes,
  bytesToBase64,
  createNativeDriver,
  pickDriver,
  type NativeFilesModule,
} from "@/runtime/services/native-files";

/**
 * The native module exists because `expo-file-system` refuses shared-storage writes no matter
 * what the user grants: it gates every operation on `File.canRead()`/`canWrite()`, which on
 * Android compare the file's owner and mode bits to the calling process, and a file in
 * `/storage/emulated/0/Download` belongs to another uid. Confirmed on a Xiaomi running
 * Android 16 with all-files access granted three independent ways.
 */

const SEP = "/";

/** Join without regexes: an earlier version of this file was mangled by a `$`-regex. */
function join(base: string, name: string): string {
  return `${base}${SEP}${name}`;
}

function stripTrailingSep(path: string): string {
  let out = path;
  while (out.length > 1 && out.endsWith(SEP)) out = out.slice(0, -1);
  return out;
}

/** An in-memory stand-in for the Kotlin module. */
function fakeNative(): NativeFilesModule & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>([SEP]);
  // The real module stores raw bytes. Here the text and binary views are distinguished by a
  // marker so a test can assert which one an operation used, while still round-tripping
  // through a copy (which reads base64 and writes base64).
  const BINARY = "b64:";
  const asText = (stored: string | undefined): string | null =>
    stored === undefined ? null : stored.startsWith(BINARY) ? stored.slice(BINARY.length) : stored;
  return {
    files,
    dirs,
    async writeText(path, contents) {
      files.set(path, contents);
      return contents.length;
    },
    async writeBase64(path, base64) {
      files.set(path, `${BINARY}${base64}`);
      return base64.length;
    },
    readText: async (path) => asText(files.get(path)),
    readBase64: async (path) => asText(files.get(path)),
    exists: async (path) => files.has(path) || dirs.has(path),
    isDirectory: async (path) => dirs.has(path),
    size: async (path) => files.get(path)?.length ?? 0,
    mtime: async () => 1234,
    async mkdirs(path) {
      dirs.add(path);
      return true;
    },
    delete: async (path) => files.delete(path) || dirs.delete(path),
    async move(from, to) {
      const value = files.get(from);
      if (value === undefined) return false;
      files.set(to, value);
      files.delete(from);
      return true;
    },
    async list(path) {
      const prefix = `${stripTrailingSep(path)}${SEP}`;
      const names: string[] = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const head = key.slice(prefix.length).split(SEP)[0];
        if (head && !names.includes(head)) names.push(head);
      }
      return names.sort();
    },
    describe: async (path) => ({ path, exists: files.has(path) }),
  };
}

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes", () => {
    // Binary content is what this path is for: the JS bridge cannot pass byte arrays.
    for (const bytes of [
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([255, 254, 253]),
      new Uint8Array([1, 2, 3, 4, 5]),
      new Uint8Array(Array.from({ length: 256 }, (_, i) => i)),
    ]) {
      expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    }
  });

  it("produces the expected encoding for known input", () => {
    // "Man" is the canonical example: TWFu.
    expect(bytesToBase64(new TextEncoder().encode("Man"))).toBe("TWFu");
    expect(bytesToBase64(new TextEncoder().encode("Ma"))).toBe("TWE=");
    expect(bytesToBase64(new TextEncoder().encode("M"))).toBe("TQ==");
  });

  it("tolerates whitespace and padding in the encoded input", () => {
    expect([...base64ToBytes("TWFu\n")]).toEqual([...new TextEncoder().encode("Man")]);
    expect([...base64ToBytes(" TWE= ")]).toEqual([...new TextEncoder().encode("Ma")]);
  });
});

describe("createNativeDriver", () => {
  it("writes and reads text through the native module", async () => {
    const driver = createNativeDriver(fakeNative());
    await driver.writeFile("/sdcard/Download/notes.md", "hello");
    expect(await driver.readFile("/sdcard/Download/notes.md")).toBe("hello");
  });

  it("writes bytes as base64 so binary survives the bridge", async () => {
    const native = fakeNative();
    const driver = createNativeDriver(native);
    await driver.writeFile("/x.bin", new Uint8Array([1, 2, 3]));
    // Stored as the module saw it: base64, not a mangled array.
    expect(native.files.get("/x.bin")).toBe(`b64:${bytesToBase64(new Uint8Array([1, 2, 3]))}`);
  });

  it("throws ENOENT rather than returning empty, for a missing file", async () => {
    const driver = createNativeDriver(fakeNative());
    await expect(driver.readFile("/nope")).rejects.toThrow("ENOENT");
    await expect(driver.readFileBytes("/nope")).rejects.toThrow("ENOENT");
    await expect(driver.stat("/nope")).rejects.toThrow("ENOENT");
  });

  it("reports a directory through stat", async () => {
    const native = fakeNative();
    await native.mkdirs("/sdcard/Download");
    const driver = createNativeDriver(native);
    const stat = await driver.stat("/sdcard/Download");
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isFile()).toBe(false);
  });

  it("throws when a move is refused instead of silently doing nothing", async () => {
    // The agent reports success based on this not throwing; a silent no-op would let it
    // claim a file was moved when it was not.
    const driver = createNativeDriver(fakeNative());
    await expect(driver.rename("/missing", "/target")).rejects.toThrow("could not move");
  });

  it("moves a file when the native side succeeds", async () => {
    const native = fakeNative();
    const driver = createNativeDriver(native);
    await driver.writeFile("/a.txt", "content");
    await driver.rename("/a.txt", "/b.txt");
    expect(await driver.readFile("/b.txt")).toBe("content");
    expect(await driver.readFile("/a.txt").catch(() => "gone")).toBe("gone");
  });

  it("copies without consuming the source", async () => {
    const native = fakeNative();
    const driver = createNativeDriver(native);
    await driver.writeFile("/a.txt", "content");
    await driver.copy("/a.txt", "/b.txt");
    expect(await driver.readFile("/a.txt")).toBe("content");
    expect(await driver.readFile("/b.txt")).toBe("content");
  });
});

describe("pickDriver", () => {
  const expoDriver = { marker: "expo" } as unknown as FsDriver;

  it("prefers the native driver when the module is present", () => {
    const chosen = pickDriver(expoDriver, fakeNative());
    expect(chosen).not.toBe(expoDriver);
    expect(typeof chosen.writeFile).toBe("function");
  });

  it("falls back to expo when the native module is absent", () => {
    // A stale build or the test environment must not lose filesystem access entirely.
    expect(pickDriver(expoDriver, undefined)).toBe(expoDriver);
  });
});
