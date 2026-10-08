import type { FileStat, FileSystemService, DirEntry, GrepMatch } from "@mobileclaw/core";
import { CoreError, PathGuard } from "@mobileclaw/core";
import { GuardedFileSystem, type FsDriver } from "@mobileclaw/capabilities";

/**
 * Minimal shape of `expo-file-system`'s object API (SDK 54+). Injected rather
 * than imported so this file type-checks and unit-tests without the native module.
 *
 * IMPORTANT: the File/Directory surface is verified against the SDK 57 typings on
 * a device build; treat this adapter as the one place to fix if Expo renames a
 * member. Everything above it (guards, tools, agent) is independent of the shift.
 */
export interface ExpoFsLike {
  File: new (path: string) => ExpoFileLike;
  Directory: new (path: string) => ExpoDirectoryLike;
  /** SDK 54+ exposes `Paths` as object instances (not strings). */
  Paths: {
    document: ExpoDirectoryLike;
    cache: ExpoDirectoryLike;
    [key: string]: unknown;
  };
}

export interface ExpoFileLike {
  uri: string;
  exists: boolean;
  size?: number | null;
  modificationTime?: number | null;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
  write(content: string | Uint8Array): void;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  delete(): void;
  copy(target: ExpoFileLike | ExpoDirectoryLike): void;
  move(target: ExpoFileLike | ExpoDirectoryLike): void;
}

export interface ExpoDirectoryLike {
  uri: string;
  exists: boolean;
  create(options?: { intermediates?: boolean }): void;
  delete(): void;
  list(): (ExpoFileLike | ExpoDirectoryLike)[];
  copy(target: ExpoFileLike | ExpoDirectoryLike): void;
  move(target: ExpoFileLike | ExpoDirectoryLike): void;
}

/**
 * Convert a `file://` URI (Expo) to a plain path (the guard's vocabulary).
 *
 * Handles both `file:///abs/path` (empty authority, Android's usual form) and a
 * malformed `file://abs/path`, where the first segment was taken as the host.
 */
export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const rest = uri.slice("file://".length);
  // `file:///a/b` -> rest = "/a/b"; `file://a/b` -> rest = "a/b" (host was "a").
  const withoutAuthority = rest.startsWith("/") ? rest : `/${rest}`;
  try {
    // Collapse any accidental double slash left by an encoded leading separator.
    return decodeURIComponent(withoutAuthority).replace(/^\/{2,}/, "/");
  } catch {
    return withoutAuthority.replace(/^\/{2,}/, "/");
  }
}

/**
 * Convert a plain absolute path to the `file://` URI expo-file-system expects.
 *
 * Android needs `file:///path` — three slashes, i.e. an **empty authority**. Splitting
 * on "/" already yields a leading empty segment, so joining the encoded parts and
 * prefixing `file://` produces exactly that; the empty segment becomes the empty
 * authority rather than an encoded `%2F`.
 *
 * (An earlier commit claimed this function was mis-encoding the leading slash and
 * produced `file://%2Fstorage/...`. That was wrong — `encodeURIComponent("")` is `""`,
 * not `%2F` — and the claim sent one round of investigation in the wrong direction. The
 * shared-storage write failure is NOT caused by this function. Left documented so the
 * incorrect diagnosis is not repeated.)
 */
export function pathToUri(path: string): string {
  if (path.startsWith("file://")) return path;
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `file://${encoded}`;
}

/** `GuardedFileSystem` driver backed by expo-file-system. */
export class ExpoFsDriver implements FsDriver {
  constructor(private readonly fs: ExpoFsLike) {}

  async readFile(path: string): Promise<string> {
    return new this.fs.File(pathToUri(path)).text();
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return new this.fs.File(pathToUri(path)).bytes();
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const file = new this.fs.File(pathToUri(path));
    // Write directly; do not call `File.create()` first.
    //
    // `create()` was there to make the file exist, and on Android 16 it is the call that
    // fails inside shared storage:
    //
    //   Call to function 'FileSystemFile.create' has been rejected.
    //     → Caused by: Missing 'READ' permission for accessing the file.
    //
    // observed on a Xiaomi 2509FPN0BC with all-files access granted three ways at once
    // (the Settings toggle reading `checked=true`, `appops ... MANAGE_EXTERNAL_STORAGE:
    // allow`, and `fs_list` on `/storage/emulated/0/Download` succeeding in 116 ms). A
    // permission that is demonstrably held cannot be the cause, so `create()` -- or the
    // read-probe it performs internally -- is. `File.write()` creates the file itself.
    if (!file.exists) {
      await this.ensureParentDirectory(path);
    }
    file.write(data);
  }

  /** Create the parent directory when the driver exposes enough to do it. */
  private async ensureParentDirectory(path: string): Promise<void> {
    const slash = path.replace(/\/+$/, "").lastIndexOf("/");
    if (slash <= 0) return;
    const parent = path.slice(0, slash);
    try {
      const directory = new this.fs.Directory(pathToUri(parent));
      if (!directory.exists) directory.create({ intermediates: true });
    } catch {
      // Best effort: a failing create() above still reports the real problem.
    }
  }

  async stat(path: string): Promise<{
    size: number;
    mtimeMs: number;
    isDirectory(): boolean;
    isFile(): boolean;
  }> {
    const uri = pathToUri(path);
    const file = new this.fs.File(uri);
    if (file.exists) {
      return {
        size: file.size ?? 0,
        // Expo may report null when metadata is unavailable.
        mtimeMs: file.modificationTime ?? 0,
        isDirectory: () => false,
        isFile: () => true,
      };
    }
    const directory = new this.fs.Directory(uri);
    if (directory.exists) {
      return { size: 0, mtimeMs: 0, isDirectory: () => true, isFile: () => false };
    }
    throw new CoreError("E_TOOL_FAILED", `path does not exist: ${path}`);
  }

  async readdir(path: string): Promise<string[]> {
    const directory = new this.fs.Directory(pathToUri(path));
    if (!directory.exists) throw new CoreError("E_TOOL_FAILED", `no such directory: ${path}`);
    return directory.list().map((item) => baseName(uriToPath(item.uri)));
  }

  async mkdir(path: string, options: { recursive: boolean }): Promise<void> {
    const directory = new this.fs.Directory(pathToUri(path));
    if (directory.exists) return;
    directory.create({ intermediates: options.recursive });
  }

  async rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void> {
    const uri = pathToUri(path);
    const file = new this.fs.File(uri);
    if (file.exists) {
      file.delete();
      return;
    }
    const directory = new this.fs.Directory(uri);
    if (!directory.exists) {
      if (options.force) return;
      throw new CoreError("E_TOOL_FAILED", `path does not exist: ${path}`);
    }
    if (!options.recursive && directory.list().length > 0) {
      throw new CoreError("E_TOOL_FAILED", `directory is not empty: ${path}`, {
        hint: "pass recursive to delete it and its contents",
      });
    }
    directory.delete();
  }

  async rename(from: string, to: string): Promise<void> {
    const source = new this.fs.File(pathToUri(from));
    if (source.exists) {
      source.move(new this.fs.File(pathToUri(to)));
      return;
    }
    new this.fs.Directory(pathToUri(from)).move(new this.fs.Directory(pathToUri(to)));
  }

  async copy(from: string, to: string): Promise<void> {
    const source = new this.fs.File(pathToUri(from));
    if (source.exists) {
      source.copy(new this.fs.File(pathToUri(to)));
      return;
    }
    new this.fs.Directory(pathToUri(from)).copy(new this.fs.Directory(pathToUri(to)));
  }
}

export interface ExpoFsOptions {
  fs: ExpoFsLike;
  roots: string[];
  allowReadOutsideRoots?: boolean;
  protectedPatterns?: RegExp[];
  maxReadBytes?: number;
  walkLimit?: number;
  /** Platform string for path semantics; Android/iOS are POSIX. */
  platform?: string;
}

/** Build a guarded filesystem over expo-file-system. */
export function createExpoFileSystem(options: ExpoFsOptions): GuardedFileSystem {
  const platform = options.platform ?? "android";
  const guard = new PathGuard(
    {
      roots: options.roots,
      ...(options.allowReadOutsideRoots !== undefined
        ? { allowReadOutsideRoots: options.allowReadOutsideRoots }
        : {}),
      ...(options.protectedPatterns ? { protectedPatterns: options.protectedPatterns } : {}),
    },
    platform,
  );
  return new GuardedFileSystem({
    driver: new ExpoFsDriver(options.fs),
    roots: options.roots,
    guard,
    ...(options.maxReadBytes !== undefined ? { maxReadBytes: options.maxReadBytes } : {}),
    ...(options.walkLimit !== undefined ? { walkLimit: options.walkLimit } : {}),
  });
}

/**
 * App-private roots that always work without any special permission. The agent
 * can fully manage files here on any device, which makes it a useful fallback
 * when the user has not granted all-files access.
 */
export function defaultAppRoots(fs: ExpoFsLike): string[] {
  const candidates = [fs.Paths.document, fs.Paths.cache];
  return candidates
    .filter((value): value is ExpoDirectoryLike => typeof value === "object" && value !== null)
    .map((directory) => uriToPath(directory.uri));
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

export type { FileStat, DirEntry, GrepMatch, FileSystemService };
