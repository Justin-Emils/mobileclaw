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
      "List one directory level: folder names and file names with sizes. With no path, lists the allowed roots. Call this to orient yourself before searching.",
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
        const data: Record<string, unknown>[] = [];
        const lines: string[] = [];
        for (const root of roots) {
          try {
            const entries = await fs.list(root);
            const capped = capEntries(entries, 40);
            data.push({ root, exists: true, entries: capped.shown });
            lines.push(
              `${root} (${entries.length} entries)`,
              ...capped.shown.map((entry) => `  ${formatEntry(entry)}`),
              ...(capped.omitted > 0 ? [`  … and ${capped.omitted} more`] : []),
            );
          } catch (error) {
            data.push({ root, exists: false, error: String(error) });
            lines.push(`${root} — not accessible: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return { display: `Allowed roots:\n${lines.join("\n")}`, data: { roots: data } };
      }

      const entries = await fs.list(input.path);
      const capped = capEntries(entries, input.limit);
      const directories = capped.shown.filter((entry) => entry.isDirectory);
      const files = capped.shown.filter((entry) => entry.isFile);

      const lines = [
        `${input.path} — ${entries.length} entries (${entries.filter((e) => e.isDirectory).length} folders, ${entries.filter((e) => e.isFile).length} files)`,
      ];
      if (directories.length > 0) {
        lines.push(`folders:\n${directories.map((entry) => `  ${entry.name}/`).join("\n")}`);
      }
      if (files.length > 0) {
        lines.push(`files:\n${files.map((entry) => `  ${formatEntry(entry)}`).join("\n")}`);
      }
      if (entries.length === 0) lines.push("(empty)");
      if (capped.omitted > 0) {
        lines.push(`… ${capped.omitted} more entries not shown; narrow the path or use fs_search.`);
      }

      return {
        display: lines.join("\n"),
        data: {
          path: input.path,
          count: entries.length,
          directories: entries.filter((entry) => entry.isDirectory).map((entry) => entry.name),
          files: entries
            .filter((entry) => entry.isFile)
            .map((entry) => ({ name: entry.name, size: entry.size, mtimeMs: entry.mtimeMs })),
          truncated: capped.omitted > 0,
        },
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

/* ------------------------------------------------------------- formatting */

/**
 * Cap a listing so neither the model's context nor the transcript drowns.
 * Returns the entries to show and how many were held back, because "there are 300
 * more" is information the model needs to decide between listing and searching.
 */
function capEntries<T>(entries: T[], limit: number): { shown: T[]; omitted: number } {
  if (entries.length <= limit) return { shown: entries, omitted: 0 };
  return { shown: entries.slice(0, limit), omitted: entries.length - limit };
}

/** `name (1.2 MB)` — sizes are what make an "organise my downloads" task possible. */
function formatEntry(entry: { name: string; size: number; isDirectory: boolean }): string {
  if (entry.isDirectory) return `${entry.name}/`;
  return `${entry.name} (${formatSize(entry.size)})`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
