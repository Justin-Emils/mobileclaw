import { CoreError, globToRegExp, PathGuard } from "@mobileclaw/core";

/** Minimal async filesystem surface the capability layer needs. */
export interface FsDriver {
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean }>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /**
   * Optional recursive walker. When absent, `glob`/`grep` fall back to a
   * breadth-first walk built on `readdir`.
   */
  walk?(root: string, options: { limit: number }): Promise<string[]>;
}

export interface NodeFsServiceOptions {
  driver: FsDriver;
  /** Extra directories advertised to the model as places worth looking in. */
  roots: string[];
  /**
   * Containment policy. Tools never resolve paths themselves, so the guard is
   * the single chokepoint for "may I touch this path".
   */
  guard: PathGuard;
  /** Upper bound for a single read, in bytes. */
  maxReadBytes?: number;
  /** Upper bound for a single write, in bytes. */
  maxWriteBytes?: number;
  /** Entries visited by glob/grep before giving up. */
  walkLimit?: number;
  /** Skip these directory names during walks (perf + noise). */
  ignoreDirs?: string[];
}

import type { FileStat, GrepMatch, DirEntry, FileSystemService } from "@mobileclaw/core";

const DEFAULT_IGNORES = [
  "node_modules",
  ".git",
  ".gradle",
  "build",
  ".expo",
  "__pycache__",
  ".cache",
  "Android/data",
];

/**
 * Filesystem capability with a mandatory path guard. Every method takes a
 * model-supplied path, so containment is enforced here rather than in each tool.
 */
export class GuardedFileSystem implements FileSystemService {
  readonly kind = "guarded-fs";
  private readonly maxReadBytes: number;
  private readonly maxWriteBytes: number;
  private readonly walkLimit: number;
  private readonly ignoreDirs: Set<string>;

  constructor(protected readonly options: NodeFsServiceOptions) {
    this.maxReadBytes = options.maxReadBytes ?? 512 * 1024;
    this.maxWriteBytes = options.maxWriteBytes ?? 4 * 1024 * 1024;
    this.walkLimit = options.walkLimit ?? 4000;
    this.ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORES);
  }

  get guard(): PathGuard {
    return this.options.guard;
  }

  async roots(): Promise<string[]> {
    return [...this.options.roots];
  }

  async read(path: string): Promise<string> {
    const safe = this.options.guard.assertRead(path);
    const bytes = await this.options.driver.readFileBytes(safe);
    if (bytes.byteLength > this.maxReadBytes) {
      throw new CoreError("E_TOOL_FAILED", `file is larger than ${this.maxReadBytes} bytes`, {
        path: safe,
        size: bytes.byteLength,
        hint: "read it in chunks with an offset/limit, or use shell tools like head/tail",
      });
    }
    return new TextDecoder().decode(bytes);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const safe = this.options.guard.assertRead(path);
    return this.options.driver.readFileBytes(safe);
  }

  async write(path: string, data: string | Uint8Array): Promise<FileStat> {
    const safe = this.options.guard.assertWrite(path);
    const size = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
    if (size > this.maxWriteBytes) {
      throw new CoreError("E_TOOL_FAILED", `payload is larger than ${this.maxWriteBytes} bytes`, {
        path: safe,
        size,
      });
    }
    await this.ensureParent(safe);
    await this.options.driver.writeFile(safe, data);
    return this.stat(safe);
  }

  async append(path: string, data: string): Promise<void> {
    const safe = this.options.guard.assertWrite(path);
    const existing = (await this.exists(safe)) ? await this.read(safe) : "";
    await this.options.driver.writeFile(safe, existing + data);
  }

  async stat(path: string): Promise<FileStat> {
    const safe = this.options.guard.assertRead(path);
    const info = await this.options.driver.stat(safe);
    return {
      path: safe,
      name: baseName(safe),
      size: info.size,
      isDirectory: info.isDirectory(),
      isFile: info.isFile(),
      mtimeMs: info.mtimeMs,
    };
  }

  async exists(path: string): Promise<boolean> {
    try {
      const safe = this.options.guard.assertRead(path);
      await this.options.driver.stat(safe);
      return true;
    } catch {
      return false;
    }
  }

  async list(path: string): Promise<DirEntry[]> {
    const safe = this.options.guard.assertRead(path);
    const names = await this.options.driver.readdir(safe);
    const entries: DirEntry[] = [];
    for (const name of names) {
      const child = joinPath(safe, name);
      try {
        const info = await this.options.driver.stat(child);
        entries.push({
          path: child,
          name,
          relative: name,
          size: info.size,
          isDirectory: info.isDirectory(),
          isFile: info.isFile(),
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // Broken symlinks and permission errors are skipped, not fatal.
      }
    }
    return entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async mkdir(path: string): Promise<void> {
    const safe = this.options.guard.assertWrite(path);
    await this.options.driver.mkdir(safe, { recursive: true });
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const safe = this.options.guard.assertWrite(path);
    await this.options.driver.rm(safe, { recursive: options.recursive ?? false, force: false });
  }

  async move(from: string, to: string): Promise<void> {
    const safeFrom = this.options.guard.assertWrite(from);
    const safeTo = this.options.guard.assertWrite(to);
    await this.ensureParent(safeTo);
    await this.options.driver.rename(safeFrom, safeTo);
  }

  async copy(from: string, to: string): Promise<void> {
    const safeFrom = this.options.guard.assertRead(from);
    const safeTo = this.options.guard.assertWrite(to);
    await this.ensureParent(safeTo);
    await this.options.driver.copy(safeFrom, safeTo);
  }

  async glob(pattern: string, options: { cwd?: string; limit?: number } = {}): Promise<string[]> {
    const base =
      options.cwd !== undefined
        ? this.options.guard.assertRead(options.cwd)
        : (this.options.roots[0] ?? process.cwd());
    const matcher = globToRegExp(normalizeSlashes(pattern));
    const limit = options.limit ?? 200;
    const results: string[] = [];
    for await (const file of this.walk(base, false)) {
      const target = pattern.includes("/")
        ? normalizeSlashes(relativeTo(base, file))
        : baseName(file);
      if (matcher.test(target) || matcher.test(normalizeSlashes(file))) {
        results.push(file);
        if (results.length >= limit) break;
      }
    }
    return results.sort();
  }

  async grep(
    pattern: string,
    options: { path?: string; limit?: number; ignoreCase?: boolean } = {},
  ): Promise<GrepMatch[]> {
    const base =
      options.path !== undefined
        ? this.options.guard.assertRead(options.path)
        : (this.options.roots[0] ?? process.cwd());
    const limit = options.limit ?? 100;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, options.ignoreCase ? "i" : "");
    } catch (error) {
      throw new CoreError("E_TOOL_INPUT", `invalid regular expression: ${pattern}`, {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const matches: GrepMatch[] = [];
    const baseInfo = await this.options.driver.stat(base).catch(() => undefined);
    const files = baseInfo?.isFile() ? [base] : this.walk(base, false);
    for await (const file of files) {
      let text: string;
      try {
        const bytes = await this.options.driver.readFileBytes(file);
        if (bytes.byteLength > this.maxReadBytes) continue;
        if (looksBinary(bytes)) continue;
        text = new TextDecoder().decode(bytes);
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (regex.test(line)) {
          matches.push({ path: file, line: index + 1, text: line.length > 400 ? `${line.slice(0, 400)}…` : line });
          if (matches.length >= limit) return matches;
        }
      }
    }
    return matches;
  }

  /** Yield files under `root`; directories are visited breadth-first. */
  protected async *walk(root: string, includeDirectories: boolean): AsyncIterable<string> {
    if (this.options.driver.walk) {
      const files = await this.options.driver.walk(root, { limit: this.walkLimit });
      for (const file of files) yield file;
      return;
    }
    const queue: string[] = [root];
    let visited = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      let names: string[];
      try {
        names = await this.options.driver.readdir(current);
      } catch {
        continue;
      }
      for (const name of names) {
        if (++visited > this.walkLimit) return;
        const child = joinPath(current, name);
        let info: Awaited<ReturnType<FsDriver["stat"]>>;
        try {
          info = await this.options.driver.stat(child);
        } catch {
          continue;
        }
        if (info.isDirectory()) {
          if (this.ignoreDirs.has(name)) continue;
          if (includeDirectories) yield child;
          queue.push(child);
        } else if (info.isFile()) {
          yield child;
        }
      }
    }
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = dirName(path);
    if (parent === "" || parent === path) return;
    try {
      await this.options.driver.mkdir(parent, { recursive: true });
    } catch {
      // Parent may already exist; the write below reports real failures.
    }
  }
}

export function joinPath(base: string, name: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  if (base === "") return name;
  return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
}

export function dirName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index <= 0 ? normalized.slice(0, Math.max(index, 0)) : normalized.slice(0, index);
}

export function baseName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

export function relativeTo(base: string, path: string): string {
  const b = normalizeSlashes(base).replace(/\/$/, "");
  const p = normalizeSlashes(path);
  return p.startsWith(`${b}/`) ? p.slice(b.length + 1) : p;
}

/** Heuristic binary sniffing so grep does not drown in noise. */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 512);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}
