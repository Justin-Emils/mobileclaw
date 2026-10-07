import { CoreError } from "./errors.js";

export interface PathGuardOptions {
  /**
   * Directories the agent may touch. Empty means "no containment" — only used by
   * tests and by desktop/CLI hosts where the user granted full disk access.
   */
  roots: string[];
  /** Subpaths that are never allowed, even inside a root. */
  protectedPatterns?: RegExp[];
  /** Allow reads outside roots (writes still enforced). */
  allowReadOutsideRoots?: boolean;
}

export interface PathDecision {
  ok: boolean;
  /** Canonical absolute path when ok. */
  path: string;
  reason?: string;
}

/**
 * Lexical path containment, deliberately platform-aware but I/O free.
 *
 * We do NOT resolve symlinks here (that needs a stat call, which may not exist in
 * the React Native file system shim). Instead every capability plugin routes
 * user/model supplied paths through this guard, and native layers additionally
 * rely on the OS to refuse unreadable locations.
 */
export class PathGuard {
  private readonly separator: string;
  private readonly caseInsensitive: boolean;

  constructor(
    private readonly options: PathGuardOptions,
    platform: string = detectPlatform(),
  ) {
    this.separator = platform === "win32" ? "\\" : "/";
    this.caseInsensitive = platform === "win32" || platform === "darwin";
  }

  get roots(): string[] {
    return [...this.options.roots];
  }

  withRoots(roots: string[]): PathGuard {
    return new PathGuard({ ...this.options, roots }, this.separator === "\\" ? "win32" : "linux");
  }

  /** Check a path for a read (or list) operation. */
  checkRead(input: string, cwd?: string): PathDecision {
    return this.check(input, cwd, "read");
  }

  /** Check a path for a write (or delete/move target) operation. */
  checkWrite(input: string, cwd?: string): PathDecision {
    return this.check(input, cwd, "write");
  }

  check(input: string, cwd: string | undefined, mode: "read" | "write"): PathDecision {
    if (typeof input !== "string" || input.trim() === "") {
      return { ok: false, path: "", reason: "path must be a non-empty string" };
    }
    const resolved = this.resolve(input, cwd);
    const rootsEnforced =
      this.options.roots.length > 0 && (mode === "write" || !this.options.allowReadOutsideRoots);

    // Containment is the authoritative rule: when it applies, a path outside the
    // roots is reported as such, whether it got there by `..` or directly.
    if (rootsEnforced && !this.containingRoot(resolved)) {
      const verb = hasTraversal(input) ? `${mode} escapes` : `${mode} is restricted to`;
      return {
        ok: false,
        path: resolved,
        reason: hasTraversal(input)
          ? `${verb} the allowed roots (${this.roots.join(", ")})`
          : `${verb}: ${this.roots.join(", ")}`,
      };
    }

    for (const pattern of this.options.protectedPatterns ?? []) {
      if (pattern.test(resolved)) {
        return { ok: false, path: resolved, reason: `path is protected: ${pattern}` };
      }
    }

    return { ok: true, path: resolved };
  }

  /** Throw a structured error instead of returning a decision. */
  assertRead(input: string, cwd?: string): string {
    const decision = this.checkRead(input, cwd);
    if (!decision.ok) {
      throw new CoreError("E_PATH_ESCAPE", decision.reason ?? "path not allowed", {
        path: input,
        roots: this.roots,
      });
    }
    return decision.path;
  }

  assertWrite(input: string, cwd?: string): string {
    const decision = this.checkWrite(input, cwd);
    if (!decision.ok) {
      throw new CoreError("E_PATH_ESCAPE", decision.reason ?? "path not allowed", {
        path: input,
        roots: this.roots,
      });
    }
    return decision.path;
  }

  /** Resolve to an absolute, normalised path without touching the filesystem. */
  resolve(input: string, cwd?: string): string {
    let path = input.trim().replace(/^file:\/\//, "");
    if (!this.isAbsolute(path)) {
      const base = cwd ?? this.options.roots[0] ?? (this.separator === "\\" ? "C:\\" : "/");
      path = `${base}${base.endsWith(this.separator) ? "" : this.separator}${path}`;
    }
    return this.normalize(path);
  }

  /** Collapse `.`/`..` segments lexically. */
  normalize(path: string): string {
    const unified = path.replace(/[\\/]+/g, this.separator);
    const prefixMatch = /^([a-zA-Z]:)?([\\/]?)/.exec(unified);
    const prefix = prefixMatch ? prefixMatch[0] : "";
    const rest = unified.slice(prefix.length);
    const parts: string[] = [];
    for (const segment of rest.split(this.separator)) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
        else if (!prefix) parts.push("..");
        continue;
      }
      parts.push(segment);
    }
    const joined = parts.join(this.separator);
    if (prefix === "") return joined;
    return joined === "" ? prefix : `${prefix}${joined}`;
  }

  isAbsolute(path: string): boolean {
    return this.separator === "\\" ? /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") : path.startsWith("/");
  }

  /** The root that contains `path`, or undefined. */
  private containingRoot(path: string): string | undefined {
    return this.options.roots.find((root) => {
      const normalizedRoot = this.normalize(root);
      const a = this.caseInsensitive ? path.toLowerCase() : path;
      const b = this.caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
      if (a === b) return true;
      const withSep = b.endsWith(this.separator) ? b : `${b}${this.separator}`;
      return a.startsWith(withSep);
    });
  }
}

function hasTraversal(input: string): boolean {
  return input.split(/[\\/]/).includes("..");
}

function detectPlatform(): string {
  const maybeProcess = (globalThis as { process?: { platform?: string } }).process;
  if (maybeProcess?.platform) return maybeProcess.platform;
  // React Native exposes Platform.OS, but the kernel must not import it.
  return "linux";
}

export function normalizeForCompare(path: string, platform = detectPlatform()): string {
  const p = path.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? p.toLowerCase() : p;
}
