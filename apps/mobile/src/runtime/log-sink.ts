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
  /**
   * Absolute **path** of the log file.
   *
   * Converted with `pathToUri` before it reaches `File`, because `expo-file-system`'s constructor
   * takes a URI: handing it a bare path makes every `exists` read throw
   * `IllegalArgumentException: URI is not absolute`. That produced a log which reported "nothing
   * recorded" on a device while lines were being written — see `toUri` below.
   */
  path: () => string;
  /** Converts an absolute path to the `file://` URI `expo-file-system` expects. */
  toUri: (path: string) => string;
  /**
   * Keep the last N lines. The event log already caps itself; this is the second bound, so the
   * file cannot grow even if the caller is configured with a much larger limit.
   */
  maxLines?: number;
}

export const DEFAULT_LOG_MAX_LINES = 2000;

export interface LogSinkStatus {
  /** Absolute path the log is written to. */
  path: string;
  /** Whether the file exists right now. */
  exists: boolean;
  /** Lines this process has written. */
  lines: number;
  /** Size reported by the file system, when it reports one. */
  bytes?: number;
  /** The first failure seen, verbatim. Empty when nothing has failed. */
  lastError: string;
}

export interface FileLogSink extends LogSink {
  /**
   * What actually happened, for the screen.
   *
   * Added after the first version of this screen read "还没有记录" on a device while lines had
   * definitely been written — an empty log and a *failing* log were indistinguishable, because both
   * the write and the read path swallowed their errors. A diagnostic that cannot report its own
   * failure is worse than none: it looks like the thing it is meant to explain simply did not happen.
   */
  status(): LogSinkStatus;
}

export function createFileLogSink(options: FileLogSinkOptions): FileLogSink {
  const maxLines = options.maxLines ?? DEFAULT_LOG_MAX_LINES;
  const lines: string[] = [];
  let cleared = false;
  let lastError = "";

  const record = (error: unknown) => {
    if (lastError !== "") return;
    lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  };

  const file = () => new options.fs.File(options.toUri(options.path()));

  const materialise = () => {
    // Write directly; do NOT call `create()` first.
    //
    // The same rule `GuardedFileSystem` learned on this project: `expo-file-system`'s `write`
    // creates the file, and a preceding `create()` throws when the file already exists — which
    // would put a failure in this log's own status line on every write after the first.
    try {
      const target = file();
      target.write(`${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`);
    } catch (error) {
      // The caller (`event-log.ts`) keeps the text queued and retries on the next flush.
      record(error);
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
        return await target.text();
      } catch (error) {
        record(error);
        return "";
      }
    },

    async clear() {
      cleared = true;
      lines.length = 0;
      const target = file();
      try {
        if (target.exists) target.delete();
      } catch (error) {
        // "Nothing to clear" and "cleared" are the same outcome here -- but a permission failure is
        // not, so it is recorded rather than assumed away.
        record(error);
      }
    },

    status() {
      let exists = false;
      let bytes: number | undefined;
      try {
        const target = file();
        exists = target.exists;
        if (typeof target.size === "number") bytes = target.size;
      } catch (error) {
        record(error);
      }
      return {
        path: options.path(),
        exists,
        lines: lines.length,
        ...(bytes === undefined ? {} : { bytes }),
        lastError,
      };
    },
  };
}
