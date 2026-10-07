import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { PathGuard } from "@mobileclaw/core";
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
});
