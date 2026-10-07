import { describe, expect, it } from "vitest";
import { globMatch, PathGuard } from "@mobileclaw/core";

const posix = new PathGuard({ roots: ["/data/user/0/app/files", "/sdcard/Download"] }, "linux");

describe("PathGuard", () => {
  it("resolves relative paths against the first root", () => {
    expect(posix.resolve("notes.txt")).toBe("/data/user/0/app/files/notes.txt");
    expect(posix.resolve("./a/../b/c.txt")).toBe("/data/user/0/app/files/b/c.txt");
  });

  it("accepts paths inside a root and rejects everything else", () => {
    expect(posix.checkRead("/sdcard/Download/report.log").ok).toBe(true);
    expect(posix.checkRead("/etc/passwd").ok).toBe(false);
    expect(posix.checkRead("/sdcard/Download/../../etc/shadow").ok).toBe(false);
  });

  it("blocks traversal that escapes the roots but allows in-root climbs", () => {
    const escaped = posix.checkRead("/sdcard/Download/../../../etc/hosts");
    expect(escaped.ok).toBe(false);
    expect(escaped.reason).toMatch(/escapes the allowed roots/);

    expect(posix.checkRead("/sdcard/Download/sub/../report.log").ok).toBe(true);
  });

  it("does not treat a sibling directory with a shared prefix as contained", () => {
    const guard = new PathGuard({ roots: ["/sdcard/Download"] }, "linux");
    expect(guard.checkRead("/sdcard/Downloads/secret.txt").ok).toBe(false);
  });

  it("enforces write containment even when reads are open", () => {
    const guard = new PathGuard(
      { roots: ["/sdcard/Download"], allowReadOutsideRoots: true },
      "linux",
    );
    expect(guard.checkRead("/etc/hosts").ok).toBe(true);
    expect(guard.checkWrite("/etc/hosts").ok).toBe(false);
    expect(guard.checkWrite("/sdcard/Download/new.txt").ok).toBe(true);
  });

  it("honours protected path patterns", () => {
    const guard = new PathGuard(
      { roots: ["/sdcard"], protectedPatterns: [/\/Android\/data\//] },
      "linux",
    );
    expect(guard.checkRead("/sdcard/Android/data/com.app/cache").ok).toBe(false);
    expect(guard.checkRead("/sdcard/Documents/file.txt").ok).toBe(true);
  });

  it("normalises windows paths case-insensitively", () => {
    const win = new PathGuard({ roots: ["C:\\Users\\me\\Documents"] }, "win32");
    expect(win.checkRead("C:\\Users\\ME\\Documents\\a.txt").ok).toBe(true);
    expect(win.resolve("sub\\file.txt")).toBe("C:\\Users\\me\\Documents\\sub\\file.txt");
    expect(win.checkRead("C:\\Windows\\System32\\config").ok).toBe(false);
  });

  it("uses structured errors from the assert helpers", () => {
    expect(() => posix.assertRead("/etc/passwd")).toThrowError(/restricted to/);
    try {
      posix.assertWrite("/etc/passwd");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("E_PATH_ESCAPE");
    }
  });

  it("matches globs the way the permission rules expect", () => {
    expect(globMatch("fs_*", "fs_read")).toBe(true);
    expect(globMatch("fs_*", "shell_run")).toBe(false);
    expect(globMatch("/sdcard/**/*.log", "/sdcard/Download/logs/app.log")).toBe(true);
    expect(globMatch("**/*.log", "/sdcard/Download/app.log")).toBe(true);
    expect(globMatch("/sdcard/*.log", "/sdcard/Download/app.log")).toBe(false);
  });
});
