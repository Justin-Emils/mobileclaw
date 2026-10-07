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

/** Convert a `file://` URI (Expo) to a plain path (the guard's vocabulary). */
export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const withoutScheme = uri.slice("file://".length);
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}

export function pathToUri(path: string): string {
  if (path.startsWith("file://")) return path;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
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
    // `overwrite` keeps repeated tool calls idempotent, which matters because the
    // model may retry a write after an unrelated failure.
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(data);
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
