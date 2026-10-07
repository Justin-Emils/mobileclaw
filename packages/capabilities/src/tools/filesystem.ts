import { z } from "zod";
import { CoreError, type AnyToolDefinition, type FileSystemService } from "@mobileclaw/core";

/**
 * Filesystem tools. The platform filesystem (Node driver in tests/desktop, native
 * module on the phone) is injected here; path containment lives inside that
 * service, so these tools stay thin and never resolve paths themselves.
 */
export interface FsToolDeps {
  fs: FileSystemService;
}

const pathArg = z
  .string()
  .min(1)
  .describe("Path; absolute, or relative to the first allowed root.");

export function createFilesystemTools(deps: FsToolDeps): AnyToolDefinition[] {
  const fsListTool = {
    name: "fs_list",
    description:
      "List a directory (names, sizes, types). With no path, lists the allowed roots. Use this first to orient yourself.",
    input: z.object({
      path: pathArg.optional().describe("Directory to list; omit to list the allowed roots."),
      limit: z.number().int().min(1).max(2000).optional().default(200),
    }),
    risk: "read",
    paths: (input: { path?: string }) => (input.path ? [input.path] : []),
    summarize: (input: { path?: string }) => (input.path ? `list ${input.path}` : "list allowed roots"),
    async execute(input: { path?: string; limit: number }) {
      const fs = deps.fs;
      if (!input.path) {
        const roots = await fs.roots();
        const items: Record<string, unknown>[] = [];
        for (const root of roots) {
          try {
            const entries = await fs.list(root);
            items.push({ root, exists: true, entries: entries.slice(0, 40) });
          } catch (error) {
            items.push({ root, exists: false, error: String(error) });
          }
        }
        return { roots: items };
      }
      const entries = await fs.list(input.path);
      return {
        path: input.path,
        count: entries.length,
        directories: entries.filter((entry) => entry.isDirectory).map((entry) => entry.name),
        files: entries
          .filter((entry) => entry.isFile)
          .slice(0, input.limit)
          .map((entry) => ({ name: entry.name, size: entry.size, mtimeMs: entry.mtimeMs })),
        truncated: entries.length > input.limit,
      };
    },
  } satisfies AnyToolDefinition;

  const fsReadTool = {
    name: "fs_read",
    description:
      "Read a UTF-8 text file. Fails on very large or binary files; use shell tools for those.",
    input: z.object({
      path: pathArg,
      offset: z.number().int().min(0).optional().describe("Line offset for partial reads."),
      limit: z.number().int().min(1).max(5000).optional().describe("Maximum lines to return."),
    }),
    risk: "read",
    paths: (input: { path: string }) => [input.path],
    summarize: (input: { path: string }) => `read ${input.path}`,
    async execute(input: { path: string; offset?: number; limit?: number }) {
      const fs = deps.fs;
      const text = await fs.read(input.path);
      if (input.offset === undefined && input.limit === undefined) {
        return { path: input.path, content: text, chars: text.length };
      }
      const lines = text.split(/\r?\n/);
      const start = input.offset ?? 0;
      const end = input.limit === undefined ? lines.length : start + input.limit;
      return {
        path: input.path,
        totalLines: lines.length,
        offset: start,
        content: lines.slice(start, end).join("\n"),
      };
    },
  } satisfies AnyToolDefinition;

  const fsWriteTool = {
    name: "fs_write",
    description:
      "Create or overwrite a text file. Overwrites are destructive: confirm with the user first when the file already exists.",
    input: z.object({
      path: pathArg,
      content: z.string().describe("Full file content."),
    }),
    risk: "write",
    paths: (input: { path: string }) => [input.path],
    summarize: (input: { path: string; content: string }) =>
      `write ${input.path} (${input.content.length} chars)`,
    async execute(input: { path: string; content: string }) {
      const stat = await deps.fs.write(input.path, input.content);
      return { path: stat.path, bytes: stat.size };
    },
  } satisfies AnyToolDefinition;

  const fsEditTool = {
    name: "fs_edit",
    description:
      "Replace an exact string in a text file. `old` must match exactly once unless replaceAll is true. Use for targeted edits instead of rewriting whole files.",
    input: z.object({
      path: pathArg,
      old: z.string().min(1),
      new: z.string(),
      replaceAll: z.boolean().optional().default(false),
    }),
    risk: "write",
    paths: (input: { path: string }) => [input.path],
    summarize: (input: { path: string }) => `edit ${input.path}`,
    async execute(input: { path: string; old: string; new: string; replaceAll: boolean }) {
      const fs = deps.fs;
      const text = await fs.read(input.path);
      const occurrences = text.split(input.old).length - 1;
      if (occurrences === 0) {
        throw new CoreError("E_TOOL_FAILED", "`old` string not found in file", { path: input.path });
      }
      if (occurrences > 1 && !input.replaceAll) {
        throw new CoreError(
          "E_TOOL_FAILED",
          `\`old\` appears ${occurrences} times; pass a longer unique string or set replaceAll`,
          { path: input.path, occurrences },
        );
      }
      const next = input.replaceAll
        ? text.split(input.old).join(input.new)
        : text.replace(input.old, input.new);
      await fs.write(input.path, next);
      return { path: input.path, replacements: input.replaceAll ? occurrences : 1 };
    },
  } satisfies AnyToolDefinition;

  const fsSearchTool = {
    name: "fs_search",
    description:
      "Find files by glob pattern (`*.log`, `**/*.md`) and/or search file contents with a regular expression. This is the main tool for organising and auditing local data.",
    input: z.object({
      glob: z.string().optional().describe("Glob pattern for file names."),
      content: z.string().optional().describe("Regular expression to search inside files."),
      path: pathArg.optional().describe("Directory to search (defaults to the first root)."),
      limit: z.number().int().min(1).max(500).optional().default(50),
      ignoreCase: z.boolean().optional().default(false),
    }),
    risk: "read",
    paths: (input: { path?: string }) => (input.path ? [input.path] : []),
    summarize: (input: { glob?: string; content?: string }) =>
      [input.glob ? `glob ${input.glob}` : "", input.content ? `grep /${input.content}/` : ""]
        .filter(Boolean)
        .join(" + ") || "search",
    async execute(input: {
      glob?: string;
      content?: string;
      path?: string;
      limit: number;
      ignoreCase: boolean;
    }) {
      const fs = deps.fs;
      if (!input.glob && !input.content) {
        throw new CoreError("E_TOOL_INPUT", "provide `glob`, `content` or both");
      }
      const result: Record<string, unknown> = {};
      if (input.glob) {
        result["files"] = await fs.glob(input.glob, {
          ...(input.path ? { cwd: input.path } : {}),
          limit: input.limit,
        });
      }
      if (input.content) {
        result["matches"] = await fs.grep(input.content, {
          ...(input.path ? { path: input.path } : {}),
          limit: input.limit,
          ignoreCase: input.ignoreCase,
        });
      }
      return result;
    },
  } satisfies AnyToolDefinition;

  const fsInfoTool = {
    name: "fs_info",
    description: "Stat one or more paths: existence, size, type, modification time.",
    input: z.object({ paths: z.array(pathArg).min(1).max(100) }),
    risk: "read",
    paths: (input: { paths: string[] }) => input.paths,
    summarize: (input: { paths: string[] }) => `stat ${input.paths.length} path(s)`,
    async execute(input: { paths: string[] }) {
      const results: Record<string, unknown>[] = [];
      for (const path of input.paths) {
        try {
          const stat = await deps.fs.stat(path);
          results.push({ ...stat, exists: true });
        } catch (error) {
          results.push({
            path,
            exists: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { results };
    },
  } satisfies AnyToolDefinition;

  const fsOrganizeTool = {
    name: "fs_organize",
    description:
      "Move, copy, rename, create directories or delete. `op` picks the action; `to` is required except for mkdir/delete. Plan bulk operations and report the mapping before running them on user data.",
    input: z.object({
      op: z.enum(["move", "copy", "rename", "mkdir", "delete"]),
      from: pathArg,
      to: pathArg.optional(),
      recursive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Required for deleting a non-empty directory."),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("Validate and report without touching the disk."),
    }),
    risk: "write" as const,
    alwaysAsk: true,
    paths: (input: { from: string; to?: string }) => (input.to ? [input.from, input.to] : [input.from]),
    summarize: (input: { op: string; from: string; to?: string; dryRun: boolean }) =>
      `${input.op} ${input.from}${input.to ? ` -> ${input.to}` : ""}${input.dryRun ? " (dry run)" : ""}`,
    async execute(input: {
      op: "move" | "copy" | "rename" | "mkdir" | "delete";
      from: string;
      to?: string;
      recursive: boolean;
      dryRun: boolean;
    }) {
      const fs = deps.fs;
      if (input.op !== "mkdir" && input.op !== "delete" && !input.to) {
        throw new CoreError("E_TOOL_INPUT", `\`to\` is required for op "${input.op}"`);
      }
      if (input.dryRun) {
        const exists = await fs.exists(input.from);
        const targetExists = input.to ? await fs.exists(input.to) : undefined;
        return { dryRun: true, op: input.op, from: input.from, to: input.to, exists, targetExists };
      }
      switch (input.op) {
        case "mkdir":
          await fs.mkdir(input.from);
          return { op: input.op, path: input.from, ok: true };
        case "delete":
          await fs.remove(input.from, { recursive: input.recursive });
          return { op: input.op, path: input.from, ok: true };
        case "move":
        case "rename":
          await fs.move(input.from, input.to!);
          return { op: input.op, from: input.from, to: input.to, ok: true };
        case "copy":
          await fs.copy(input.from, input.to!);
          return { op: input.op, from: input.from, to: input.to, ok: true };
        default:
          throw new CoreError("E_TOOL_INPUT", `unsupported op "${String(input.op)}"`);
      }
    },
  } satisfies AnyToolDefinition;

  return [
    fsListTool,
    fsReadTool,
    fsWriteTool,
    fsEditTool,
    fsSearchTool,
    fsInfoTool,
    fsOrganizeTool,
  ];
}
