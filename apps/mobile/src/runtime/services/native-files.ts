import type { FsDriver } from "@mobileclaw/capabilities";

/**
 * JS side of the `mobileclaw-files` native module.
 *
 * The module exists because `expo-file-system` refuses shared-storage writes regardless of
 * permission -- it authorises an operation by calling `File.canRead()`/`canWrite()`, which on
 * Android compare the file's owner and mode bits against the calling process, and a file in
 * `/storage/emulated/0/Download` belongs to another uid. See the Kotlin source at
 * `apps/mobile/modules/mobileclaw-files/android/.../MobileClawFilesModule.kt` for the full
 * evidence trail. `java.io.File` performs no such pre-check.
 *
 * Loaded lazily and tolerantly: if the native module is missing (a stale build, the test
 * environment), `loadNativeFiles()` returns undefined and the caller falls back to the
 * expo-file-system driver, which still works for app-private paths.
 */

export interface NativeFilesModule {
  writeText(path: string, contents: string): number;
  writeBase64(path: string, base64: string): number;
  readText(path: string): string | null;
  readBase64(path: string): string | null;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  size(path: string): number;
  mtime(path: string): number;
  mkdirs(path: string): boolean;
  delete(path: string): boolean;
  move(from: string, to: string): boolean;
  list(path: string): string[];
  describe(path: string): Record<string, string | number | boolean>;
}

/**
 * Resolve the native module, or undefined.
 *
 * `requireNativeModule` throws when the module is absent, so this cannot be a top-level
 * import in a file that the test suite loads.
 */
export function loadNativeFiles(): NativeFilesModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireNativeModule } = require("expo-modules-core") as {
      requireNativeModule: (name: string) => unknown;
    };
    const module = requireNativeModule("MobileClawFiles") as NativeFilesModule | undefined;
    return module ?? undefined;
  } catch {
    return undefined;
  }
}

/** Base64 without depending on Buffer, which React Native does not provide. */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = B64.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}

/**
 * A driver over the native module, in the shape the capability layer consumes.
 *
 * Synchronous native calls are wrapped in resolved promises: the interface is async because
 * the expo-file-system driver is, and callers should not have to care which is in use.
 */
export function createNativeDriver(native: NativeFilesModule): FsDriver {
  return {
    async readFile(path) {
      const value = native.readText(path);
      if (value === null) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    async readFileBytes(path) {
      const value = native.readBase64(path);
      if (value === null) throw new Error(`ENOENT: ${path}`);
      return base64ToBytes(value);
    },
    async writeFile(path, data) {
      if (typeof data === "string") {
        native.writeText(path, data);
      } else {
        native.writeBase64(path, bytesToBase64(data));
      }
    },
    async stat(path) {
      if (!native.exists(path)) throw new Error(`ENOENT: ${path}`);
      const directory = native.isDirectory(path);
      return {
        size: native.size(path),
        mtimeMs: native.mtime(path),
        isDirectory: () => directory,
        isFile: () => !directory,
      };
    },
    async readdir(path) {
      return native.list(path);
    },
    async mkdir(path) {
      native.mkdirs(path);
    },
    async rm(path) {
      native.delete(path);
    },
    async rename(from, to) {
      if (!native.move(from, to)) throw new Error(`could not move ${from} to ${to}`);
    },
    async copy(from, to) {
      // The module has no copy; read and write keeps it to one traversal and works for
      // the file sizes this app handles.
      const bytes = native.readBase64(from);
      if (bytes === null) throw new Error(`ENOENT: ${from}`);
      native.writeBase64(to, bytes);
    },
  };
}

/**
 * The best driver available on this device.
 *
 * Prefers the native module; falls back to `expo-file-system` so app-private paths keep
 * working even if the native side is missing.
 */
export function pickDriver(expoDriver: FsDriver, native = loadNativeFiles()): FsDriver {
  return native ? createNativeDriver(native) : expoDriver;
}
