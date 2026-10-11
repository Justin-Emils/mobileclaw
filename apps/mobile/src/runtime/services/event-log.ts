/**
 * An on-device event log, for diagnosing failures that happen on someone else's phone.
 *
 * ## Why this exists
 *
 * `console.log` does not reach `adb logcat` in a release build — React Native only bridges the
 * console in development. That leaves a real gap: several defects in this project were only
 * visible on a physical device, and on a release build there was **nothing to read afterwards**.
 * The worst of them produced no symptom at all:
 *
 *   the model returned no text and no tool calls, so the agent stored an empty assistant message
 *   and reported `stopReason: "completed"`. The screen simply showed the tool cards and stopped.
 *
 * That is invisible from the inside and unreadable from the outside, which is exactly the case
 * this log is for. The entries below are chosen so that run can be reconstructed after the fact:
 * what was requested, how the stream ended, what the tools did, and how the run stopped.
 *
 * ## Why a file and not a screen buffer
 *
 * The app is usually killed or replaced before anyone reads a memory buffer, and the interesting
 * run is often the one that came before the current launch. Entries are appended to a file in the
 * app's private directory and capped, so the log survives a restart without growing without
 * bound.
 *
 * ## Why the file system is injected
 *
 * So this is unit-testable on Node. The ring buffer, the cap and the append-vs-rewrite behaviour
 * are the parts worth testing, and none of them need a device.
 */

/** Anything that can be turned into one line and read back. */
export type LogValue = string | number | boolean | null | undefined;

/** One recorded event. */
export interface LogEntry {
  /** Epoch milliseconds. */
  at: number;
  level: "debug" | "info" | "warn" | "error";
  /** Where it came from, e.g. `provider` or `tools`. Kept short so lines stay readable. */
  scope: string;
  message: string;
  /** Extra named values, rendered as `key=value`. */
  fields?: Record<string, LogValue>;
}

/**
 * The slice of `expo-file-system` this needs.
 *
 * A callback rather than the object API because the log must be writable from anywhere,
 * including paths that run before the file-system service is built.
 */
export interface LogSink {
  /** Append one line. Implementations must not throw. */
  write(line: string): void;
  /** The current contents, for the on-screen viewer. */
  read(): Promise<string>;
  /** Clear it. */
  clear(): Promise<void>;
}

export interface EventLogOptions {
  sink: LogSink;
  /** Lines kept in memory and on disk. The oldest are dropped first. */
  limit?: number;
  now?: () => number;
}

/** Enough to cover one long session with room to spare. */
export const DEFAULT_LOG_LIMIT = 800;

/** Render one field value so a log line never contains a raw newline. */
function renderValue(value: LogValue): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  // Newlines inside details would break the one-entry-per-line shape the viewer relies on.
  return text.replace(/\r?\n/g, "\\n");
}

/** Render one entry as a single line. Also what is written to disk. */
export function formatEntry(entry: LogEntry): string {
  const time = new Date(entry.at).toISOString().slice(11, 23);
  const level = entry.level.toUpperCase().padEnd(5);
  const fields = entry.fields
    ? Object.entries(entry.fields)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${renderValue(value)}`)
        .join(" ")
    : "";
  return [time, level, `[${entry.scope}]`, entry.message, fields].filter((part) => part !== "").join(" ");
}

export interface EventLog {
  /** Record something. Never throws; a log failure must not become the failure. */
  add(level: LogEntry["level"], scope: string, message: string, fields?: Record<string, LogValue>): void;
  /** Convenience wrappers. */
  debug(scope: string, message: string, fields?: Record<string, LogValue>): void;
  info(scope: string, message: string, fields?: Record<string, LogValue>): void;
  warn(scope: string, message: string, fields?: Record<string, LogValue>): void;
  error(scope: string, message: string, fields?: Record<string, LogValue>): void;
  /** The most recent entries, oldest first. */
  entries(): LogEntry[];
  /** Everything recorded, as text, for display or sharing. */
  dump(): string;
  /** Persist whatever is only in memory. Called on a timer and at important moments. */
  flush(): void;
  clear(): void;
}

/**
 * Build the log.
 *
 * Writes are buffered and flushed rather than issued per entry: this is called from inside the
 * agent loop, and a synchronous file write per event would put I/O latency on the run's critical
 * path. The buffer is flushed on an error, on request, and on a timer the caller drives.
 */
export function createEventLog(options: EventLogOptions): EventLog {
  const limit = options.limit ?? DEFAULT_LOG_LIMIT;
  const now = options.now ?? (() => Date.now());
  const buffer: LogEntry[] = [];
  const pending: string[] = [];
  let dropped = 0;

  const add: EventLog["add"] = (level, scope, message, fields) => {
    const entry: LogEntry = { at: now(), level, scope, message, ...(fields ? { fields } : {}) };
    buffer.push(entry);
    // Drop from the front, and count them: a log that silently loses its beginning is
    // misleading when someone is trying to read a failure that happened early.
    while (buffer.length > limit) {
      buffer.shift();
      dropped += 1;
    }
    pending.push(formatEntry(entry));
    try {
      for (const line of pending) options.sink.write(line);
      pending.length = 0;
    } catch {
      // Keep the lines queued; the next flush tries again. A broken log must not break the run.
    }
    // An error is worth persisting immediately: the process may not survive to the next flush.
    if (level === "error") {
      try {
        options.sink.write(`--- dropped ${dropped} earlier line(s) ---`);
      } catch {
        // Same reasoning as above.
      }
    }
  };

  return {
    add,
    debug: (scope, message, fields) => add("debug", scope, message, fields),
    info: (scope, message, fields) => add("info", scope, message, fields),
    warn: (scope, message, fields) => add("warn", scope, message, fields),
    error: (scope, message, fields) => add("error", scope, message, fields),
    entries: () => [...buffer],
    dump: () =>
      [
        `MobileClaw 诊断日志`,
        `记录 ${buffer.length} 条（上限 ${limit}${dropped > 0 ? `，已丢弃最早 ${dropped} 条` : ""}）`,
        "",
        ...buffer.map(formatEntry),
      ].join("\n"),
    flush: () => {
      try {
        for (const line of pending) options.sink.write(line);
        pending.length = 0;
      } catch {
        // See `add`.
      }
    },
    clear: () => {
      buffer.length = 0;
      pending.length = 0;
      dropped = 0;
      void options.sink.clear();
    },
  };
}
