import type { LogSink } from "./services/event-log";

/**
 * The event log, on disk in the app's private directory.
 *
 * ## Shape
 *
 * One line per event. `formatEntry` escapes newlines inside fields, so a line is always one entry
 * and the viewer can render it directly.
 *
 * ## Why the whole file is rewritten instead of appended to
 *
 * `expo-file-system`'s read API is **asynchronous** and its write API is **synchronous**. An
 * append therefore cannot read the existing contents in the same synchronous step, and a sink that
 * pretends otherwise silently truncates the log on every write — which is worse than not having one,
 * because it looks like it works.
 *
 * So the lines live in memory and the file is a materialised view of them, rewritten on flush. The
 * content is bounded (see `event-log.ts`), so a rewrite is a sub-kilobyte-to-a-few-hundred-kilobyte
 * write, and it only happens when the caller flushes rather than per event. `adb`-style log
 * rotation was the alternative; it would split one session across files and make "what happened"
 * harder to answer, which is the only question this log exists to answer.
 */
export interface LogFileLike {
  uri: string;
  exists: boolean;
  size?: number | null;
  text(): Promise<string>;
  write(content: string): void;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  delete(): void;
}

export interface LogFsLike {
  File: new (path: string) => LogFileLike;
}

export interface FileLogSinkOptions {
  fs: LogFsLike;
  /** Absolute path of the log file. */
  path: () => string;
  /**
   * Keep the last N lines. The event log already caps itself; this is the second bound, so the
   * file cannot grow even if the caller is configured with a much larger limit.
   */
  maxLines?: number;
}

export const DEFAULT_LOG_MAX_LINES = 2000;

export function createFileLogSink(options: FileLogSinkOptions): LogSink {
  const maxLines = options.maxLines ?? DEFAULT_LOG_MAX_LINES;
  const lines: string[] = [];
  let cleared = false;

  const file = () => new options.fs.File(options.path());

  const materialise = () => {
    const target = file();
    if (!target.exists) {
      try {
        target.create({ intermediates: true, overwrite: true });
      } catch {
        // Another writer created it first, or the directory is unavailable. The write below is the
        // real attempt; a failed `create` on an existing file is not worth reporting.
      }
    }
    try {
      target.write(`${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`);
    } catch {
      // The caller (`event-log.ts`) keeps the text queued and retries on the next flush. A log that
      // cannot be written must never become the failure being investigated.
    }
  };

  return {
    write(line: string) {
      lines.push(line);
      if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
      materialise();
    },

    async read() {
      const target = file();
      if (!target.exists) return "";
      try {
        const text = await target.text();
        // A file left over from a previous session, before this one has written anything: prefer it
        // over the empty buffer, so a launch right after a crash still shows the last run.
        if (lines.length === 0 && !cleared && text.trim() !== "") return text;
        return text;
      } catch {
        return "";
      }
    },

    async clear() {
      cleared = true;
      lines.length = 0;
      const target = file();
      try {
        if (target.exists) target.delete();
      } catch {
        // "Nothing to clear" and "cleared" are the same outcome here.
      }
    },
  };
}
