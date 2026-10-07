import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { PathGuard } from "@mobileclaw/core";
import { GuardedFileSystem, type FsDriver } from "../guarded-fs.js";

/** Resolved stat shape returned by an {@link FsDriver}. */
export interface DriverStat {
  size: number;
  mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * Node `fs/promises` driver. Used by tests and by the desktop playgound — the
 * phone uses a React Native driver behind the same interface.
 */
export class NodeFsDriver implements FsDriver {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, "utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const buffer = await fs.readFile(path);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await fs.writeFile(path, data);
  }

  async stat(path: string): Promise<DriverStat> {
    const info = await fs.stat(path);
    return {
      size: info.size,
      mtimeMs: info.mtimeMs,
      isDirectory: () => info.isDirectory(),
      isFile: () => info.isFile(),
    };
  }

  async readdir(path: string): Promise<string[]> {
    return fs.readdir(path);
  }

  async mkdir(path: string, options: { recursive: boolean }): Promise<void> {
    await fs.mkdir(path, options);
  }

  async rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void> {
    await fs.rm(path, options);
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }

  async copy(from: string, to: string): Promise<void> {
    await fs.cp(from, to, { recursive: true, errorOnExist: false });
  }
}

export interface NodeFsOptions {
  /** Directories the agent may touch. Defaults to home + temp. */
  roots?: string[];
  allowReadOutsideRoots?: boolean;
  protectedPatterns?: RegExp[];
  maxReadBytes?: number;
  walkLimit?: number;
}

/**
 * A guarded filesystem over the real disk. Note this is the *desktop/test*
 * flavour: on Android the roots are shared-storage directories resolved by a
 * native module, but the guard and tool semantics are identical.
 */
export function createNodeFileSystem(options: NodeFsOptions = {}): GuardedFileSystem {
  const roots = (options.roots ?? [homedir(), tmpdir()]).map((root) => resolve(root));
  const guard = new PathGuard(
    {
      roots,
      ...(options.allowReadOutsideRoots !== undefined
        ? { allowReadOutsideRoots: options.allowReadOutsideRoots }
        : {}),
      ...(options.protectedPatterns ? { protectedPatterns: options.protectedPatterns } : {}),
    },
    process.platform,
  );
  return new GuardedFileSystem({
    driver: new NodeFsDriver(),
    roots,
    guard,
    ...(options.maxReadBytes !== undefined ? { maxReadBytes: options.maxReadBytes } : {}),
    ...(options.walkLimit !== undefined ? { walkLimit: options.walkLimit } : {}),
  });
}

/** Default roots worth advertising on a phone (Android, then iOS). */
export const ANDROID_ROOT_CANDIDATES = [
  "/storage/emulated/0/Download",
  "/storage/emulated/0/Documents",
  "/storage/emulated/0/DCIM",
  "/storage/emulated/0/Pictures",
  "/storage/emulated/0/Music",
  "/storage/emulated/0/Movies",
  "/sdcard",
];

export { resolve };
