import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { PathGuard, type FileSystemService } from "@mobileclaw/core";
import { createFilesystemTools } from "@mobileclaw/capabilities";
import { createNodeFileSystem, NodeFsDriver } from "@mobileclaw/capabilities/node";

let root: string;

function buildTools() {
  const guard = new PathGuard({ roots: [root] }, process.platform);
  const fs = createNodeFileSystem({ roots: [root] });
  void guard;
  return { fs, tools: createFilesystemTools({ fs }) };
}

const call = { signal: new AbortController().signal, callId: "call_1" };

describe("GuardedFileSystem", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mobileclaw-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips writes and reads", async () => {
    const { fs } = buildTools();
    await fs.write(join(root, "notes.txt"), "hello claw");
    expect(await fs.read(join(root, "notes.txt"))).toBe("hello claw");
    expect(await fs.exists(join(root, "notes.txt"))).toBe(true);
    const stat = await fs.stat(join(root, "notes.txt"));
    expect(stat.size).toBe(10);
    expect(stat.isFile).toBe(true);
  });

  it("creates parent directories on write", async () => {
    const { fs } = buildTools();
    await fs.write(join(root, "a", "b", "c.txt"), "deep");
    expect(await fs.read(join(root, "a", "b", "c.txt"))).toBe("deep");
  });

  it("refuses paths outside the roots", async () => {
    const { fs } = buildTools();
    // A sibling directory shares the temp parent but is NOT inside the root.
    const sibling = await mkdtemp(join(tmpdir(), "mobileclaw-other-"));
    try {
      await writeFile(join(sibling, "outside.txt"), "not yours");
      await expect(fs.read(join(sibling, "outside.txt"))).rejects.toThrowError(/restricted to/);
      await expect(fs.write(join(sibling, "escape.txt"), "nope")).rejects.toThrowError(/restricted to/);

      // A literal `..` segment is reported as an escape; a direct outside path
      // is reported as outside the allowed roots. NB: `path.join` would resolve
      // the `..` away before the guard ever sees it, so build the string by hand.
      const escaping = `${root}${sep}..${sep}escape-${Date.now()}.txt`;
      await expect(fs.write(escaping, "nope")).rejects.toThrowError(/escapes the allowed roots/);
      await expect(fs.read(`${root}-outside.txt`)).rejects.toThrowError(/restricted to/);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("rejects binary and oversized files on read", async () => {
    const guard = new PathGuard({ roots: [root] }, process.platform);
    const fs = createNodeFileSystem({ roots: [root], maxReadBytes: 4 });
    void guard;
    await writeFile(join(root, "big.txt"), "0123456789");
    await expect(fs.read(join(root, "big.txt"))).rejects.toThrowError(/larger than 4 bytes/);
  });

  it("lists directories with directories first", async () => {
    const { fs } = buildTools();
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, "a.txt"), "a");
    const entries = await fs.list(root);
    expect(entries.map((entry) => entry.name)).toEqual(["sub", "a.txt", "b.txt"]);
  });

  it("globs and greps across the tree", async () => {
    const { fs } = buildTools();
    await writeFile(join(root, "top.log"), "ERROR: another\n");
    await mkdir(join(root, "logs"));
    await writeFile(join(root, "logs", "app.log"), "line one\nERROR: disk full\n");
    await writeFile(join(root, "logs", "other.txt"), "nothing here\n");

    const logs = await fs.glob("*.log", { cwd: join(root, "logs") });
    expect(logs.map((path) => path.split(/[\\/]/).pop())).toEqual(["app.log"]);

    const errors = await fs.grep("ERROR", { path: root });
    expect(errors).toHaveLength(2);
    const appHit = errors.find((match) => match.path.endsWith("app.log"));
    expect(appHit?.line).toBe(2);
    expect(appHit?.text).toContain("disk full");

    const narrowed = await fs.grep("ERROR", { path: join(root, "logs") });
    expect(narrowed).toHaveLength(1);
  });

  it("moves, copies and removes entries", async () => {
    const { fs } = buildTools();
    await fs.write(join(root, "one.txt"), "1");
    await fs.copy(join(root, "one.txt"), join(root, "copy.txt"));
    await fs.move(join(root, "copy.txt"), join(root, "moved.txt"));
    expect(await fs.read(join(root, "moved.txt"))).toBe("1");
    await fs.remove(join(root, "moved.txt"));
    expect(await fs.exists(join(root, "moved.txt"))).toBe(false);
  });

  it("appends to an existing file", async () => {
    const { fs } = buildTools();
    await fs.write(join(root, "log.txt"), "first\n");
    await fs.append(join(root, "log.txt"), "second\n");
    expect(await fs.read(join(root, "log.txt"))).toBe("first\nsecond\n");
  });
});

describe("filesystem tools", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mobileclaw-tools-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function tool(name: string) {
    const { tools } = buildTools();
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`tool ${name} missing`);
    return found;
  }

  it("exposes a JSON schema for every tool", () => {
    const { tools } = buildTools();
    expect(tools.map((candidate) => candidate.name)).toEqual([
      "fs_list",
      "fs_read",
      "fs_write",
      "fs_edit",
      "fs_search",
      "fs_info",
      "fs_organize",
    ]);
    for (const candidate of tools) {
      const schema = (candidate.input as unknown as { safeParse: unknown }).safeParse;
      expect(typeof schema).toBe("function");
    }
  });

  it("writes, edits and reads back through the tools", async () => {
    const write = tool("fs_write");
    const edit = tool("fs_edit");
    const read = tool("fs_read");

    await write.execute!({ path: join(root, "todo.md"), content: "# Todo\n- milk\n" } as never, call as never);
    await edit.execute!(
      { path: join(root, "todo.md"), old: "- milk", new: "- milk and bread", replaceAll: false } as never,
      call as never,
    );
    const result = (await read.execute!({ path: join(root, "todo.md") } as never, call as never)) as {
      content: string;
    };
    expect(result.content).toContain("- milk and bread");
  });

  it("refuses an ambiguous edit instead of guessing", async () => {
    const write = tool("fs_write");
    const edit = tool("fs_edit");
    await write.execute!({ path: join(root, "dup.txt"), content: "x\nx\n" } as never, call as never);
    await expect(
      edit.execute!({ path: join(root, "dup.txt"), old: "x", new: "y", replaceAll: false } as never, call as never),
    ).rejects.toThrowError(/appears 2 times/);
  });

  it("supports dry runs for destructive operations", async () => {
    const organize = tool("fs_organize");
    const write = tool("fs_write");
    await write.execute!({ path: join(root, "keep.txt"), content: "k" } as never, call as never);

    const result = (await organize.execute!(
      {
        op: "delete",
        from: join(root, "keep.txt"),
        recursive: false,
        dryRun: true,
      } as never,
      call as never,
    )) as { dryRun: boolean; exists: boolean };
    expect(result).toMatchObject({ dryRun: true, exists: true });
    expect(await new NodeFsDriver().stat(join(root, "keep.txt"))).toBeTruthy();
  });

  it("returns a readable listing for the model and full data for the UI", async () => {
    const { fs } = buildTools();
    await mkdir(join(root, "logs"));
    await writeFile(join(root, "report.pdf"), "x".repeat(2048));

    const list = tool("fs_list");
    const result = (await list.execute!({ path: root, limit: 200 } as never, call as never)) as {
      display: string;
      data: { count: number; directories: string[]; files: { name: string }[] };
    };

    // The model gets text it can actually read — this is what stops it from
    // repeating the same listing because paths were cut off mid-string.
    expect(result.display).toContain("logs/");
    expect(result.display).toContain("report.pdf (2.0 KB)");
    expect(result.display).not.toContain("{");
    // The UI still gets the structured form.
    expect(result.data.count).toBe(2);
    expect(result.data.directories).toEqual(["logs"]);
    expect(result.data.files.map((file) => file.name)).toEqual(["report.pdf"]);
  });

  it("reports entries it cannot read instead of dropping them", async () => {
    // The bug this guards: on Android without all-files access, `stat` fails for every
    // file in shared storage, the entries were skipped silently, and the agent concluded
    // a full folder was empty -- it even said so in the transcript.
    const stub: FileSystemService = {
      kind: "stub",
      async roots() {
        return [root];
      },
      async list() {
        return [
          {
            path: join(root, "real.txt"),
            name: "real.txt",
            relative: "real.txt",
            size: 10,
            isDirectory: false,
            isFile: true,
            unreadable: true,
          },
        ];
      },
    } as unknown as FileSystemService;

    const list = createFilesystemTools({ fs: stub }).find((candidate) => candidate.name === "fs_list");
    const result = (await list!.execute!({ path: root, limit: 200 } as never, call as never)) as {
      display: string;
      data: { count: number; unreadable: string[] };
    };

    // The model must be told to ask for access, not to report an empty directory.
    expect(result.display).toContain("CANNOT READ");
    expect(result.display).toContain("real.txt");
    expect(result.display).toContain("all-files access");
    expect(result.display).not.toContain("(empty)");
    expect(result.data.unreadable).toEqual(["real.txt"]);
  });

  it("still says a genuinely empty directory is empty", async () => {
    // The counterpart: a real empty directory must not be dressed up as a permission
    // problem, or the message becomes noise the model learns to ignore.
    const { fs } = buildTools();
    const empty = join(root, "nothing-here");
    await mkdir(empty);
    const list = tool("fs_list");
    const result = (await list.execute!({ path: empty, limit: 200 } as never, call as never)) as {
      display: string;
    };
    expect(result.display).toContain("(empty)");
    expect(result.display).not.toContain("CANNOT READ");
  });

  it("says how many entries it withheld instead of silently truncating", async () => {
    const { fs } = buildTools();
    for (let i = 0; i < 12; i += 1) {
      await writeFile(join(root, `f${String(i).padStart(2, "0")}.txt`), "x");
    }
    const list = tool("fs_list");
    const result = (await list.execute!({ path: root, limit: 5 } as never, call as never)) as {
      display: string;
      data: { truncated: boolean; count: number };
    };
    expect(result.display).toContain("7 more entries not shown");
    expect(result.display).toContain("12 entries");
    expect(result.data.truncated).toBe(true);
    expect(result.data.count).toBe(12);
  });

  it("flags hidden and app-owned entries so the model asks before touching them", async () => {
    const { fs } = buildTools();
    await mkdir(join(root, ".csj"));
    await mkdir(join(root, "Telegram"));
    await mkdir(join(root, "MyStuff"));
    await writeFile(join(root, "notes.md"), "x");

    const list = tool("fs_list");
    const result = (await list.execute!({ path: root, limit: 200 } as never, call as never)) as {
      display: string;
      data: { special: { name: string; reason: string }[] };
    };

    // Separated and labelled: these must not be reorganised without asking.
    expect(result.display).toContain("special or app-owned entries");
    expect(result.display).toContain(".csj/ [hidden]");
    expect(result.display).toContain("Telegram/ [owned by another app]");
    // The user's own folder stays in the normal list.
    expect(result.display).toContain("MyStuff/");
    expect(result.display).not.toContain("MyStuff/ [");

    expect(result.data.special.map((entry) => entry.name).sort()).toEqual([".csj", "Telegram"]);
    expect(result.data.special.find((entry) => entry.name === ".csj")?.reason).toBe("hidden");
  });

  it("tells the model that an empty search is not an empty folder", async () => {
    const { fs } = buildTools();
    await mkdir(join(root, "Telegram"));
    const search = tool("fs_search");
    const result = (await search.execute!(
      { glob: "**/*", path: root, limit: 50, ignoreCase: false } as never,
      call as never,
    )) as { display: string };
    expect(result.display).toContain("0 file(s)");
    expect(result.display).toContain("No results");
    expect(result.display).toContain("glob matches FILES, not directories");
  });

  it("formats sizes so an organise task can compare files", async () => {
    const { fs } = buildTools();
    await writeFile(join(root, "small.txt"), "x".repeat(300));
    await writeFile(join(root, "big.bin"), "x".repeat(3 * 1024 * 1024));
    const list = tool("fs_list");
    const result = (await list.execute!({ path: root, limit: 200 } as never, call as never)) as {
      display: string;
    };
    expect(result.display).toContain("small.txt (300 B)");
    expect(result.display).toContain("big.bin (3.0 MB)");
  });
});
