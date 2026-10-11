import { describe, expect, it } from "vitest";
import { createEventLog, formatEntry, DEFAULT_LOG_LIMIT } from "@/runtime/services/event-log";
import { createFileLogSink, type LogFileLike, type LogFsLike } from "@/runtime/log-sink";

/**
 * The event log exists because a release build has no readable output: React Native does not bridge
 * `console.log` to logcat outside development. Several defects here were only visible on a device,
 * and the worst produced no symptom at all — the model returned no text and no tool calls, so the
 * agent stored an empty assistant message and reported `completed`. Nothing on screen, nothing in
 * logcat. These tests hold the properties that make such a run reconstructable afterwards.
 */

function memorySink() {
  const lines: string[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(line);
    },
    async read() {
      return lines.join("\n");
    },
    async clear() {
      lines.length = 0;
    },
  };
}

describe("formatEntry", () => {
  it("renders one line with time, level, scope, message and fields", () => {
    const line = formatEntry({
      at: Date.UTC(2026, 0, 2, 3, 4, 5, 678),
      level: "info",
      scope: "provider",
      message: "stream done",
      fields: { finishReason: "stop", text: 0 },
    });
    expect(line).toContain("03:04:05.678");
    expect(line).toContain("INFO ");
    expect(line).toContain("[provider]");
    expect(line).toContain("stream done");
    expect(line).toContain("finishReason=stop");
    expect(line).toContain("text=0");
  });

  it("keeps a newline inside a field on one line", () => {
    // The viewer renders one entry per line; an embedded newline would split an entry in two and
    // make the log look like it had unrelated entries.
    const line = formatEntry({
      at: 0,
      level: "error",
      scope: "run",
      message: "failed",
      fields: { detail: "line one\nline two" },
    });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("line one\\nline two");
  });

  it("omits empty fields rather than printing key=", () => {
    const line = formatEntry({
      at: 0,
      level: "info",
      scope: "x",
      message: "m",
      fields: { present: "yes", absent: undefined, blank: "" },
    });
    expect(line).toContain("present=yes");
    expect(line).not.toContain("absent=");
    expect(line).not.toContain("blank=");
  });
});

describe("createEventLog", () => {
  it("records every level and dumps them oldest first", () => {
    const sink = memorySink();
    const log = createEventLog({ sink, now: () => 1000 });
    log.debug("a", "d");
    log.info("a", "i");
    log.warn("a", "w");
    log.error("a", "e");

    expect(log.entries().map((entry) => entry.level)).toEqual(["debug", "info", "warn", "error"]);
    expect(log.dump()).toContain("d");
    expect(log.dump()).toContain("e");
  });

  it("caps the buffer and says how many lines it dropped", () => {
    // A log that silently loses its beginning is misleading to whoever is reading a failure that
    // happened early, so the drop is counted and reported.
    const sink = memorySink();
    const log = createEventLog({ sink, limit: 3, now: () => 0 });
    for (let i = 1; i <= 5; i += 1) log.info("s", `line ${i}`);

    expect(log.entries()).toHaveLength(3);
    expect(log.dump()).toContain("line 3");
    expect(log.dump()).not.toContain("line 2");
    expect(log.dump()).toContain("已丢弃最早 2 条");
  });

  it("never throws when the sink fails", () => {
    // The log is diagnostic. If writing it can fail a run, it has become a source of failures.
    const log = createEventLog({
      sink: {
        write() {
          throw new Error("disk full");
        },
        async read() {
          return "";
        },
        async clear() {},
      },
    });
    expect(() => log.error("s", "boom")).not.toThrow();
  });

  it("clear empties the buffer and the sink", async () => {
    const sink = memorySink();
    const log = createEventLog({ sink, now: () => 0 });
    log.info("s", "one");
    log.clear();
    expect(log.entries()).toHaveLength(0);
    expect(await sink.read()).toBe("");
  });

  it("uses the documented default cap", () => {
    const sink = memorySink();
    const log = createEventLog({ sink, now: () => 0 });
    for (let i = 0; i < DEFAULT_LOG_LIMIT + 50; i += 1) log.info("s", `l${i}`);
    expect(log.entries()).toHaveLength(DEFAULT_LOG_LIMIT);
  });
});

/** An in-memory `expo-file-system` stand-in, with the sync-write / async-read split of the real one. */
function fakeFs() {
  const files = new Map<string, string>();
  const fs: LogFsLike = {
    File: class implements LogFileLike {
      uri: string;
      constructor(path: string) {
        this.uri = path;
      }
      get exists() {
        return files.has(this.uri);
      }
      get size() {
        return files.get(this.uri)?.length ?? 0;
      }
      async text() {
        return files.get(this.uri) ?? "";
      }
      write(content: string) {
        files.set(this.uri, content);
      }
      create() {
        if (!files.has(this.uri)) files.set(this.uri, "");
      }
      delete() {
        files.delete(this.uri);
      }
    },
  };
  return { fs, files };
}

describe("createFileLogSink", () => {
  it("materialises written lines into the file, one per line", () => {
    const { fs, files } = fakeFs();
    const sink = createFileLogSink({ fs, path: () => "/logs/event.log" });
    sink.write("one");
    sink.write("two");
    expect(files.get("/logs/event.log")).toBe("one\ntwo\n");
  });

  it("does not lose earlier lines when a later write happens", () => {
    // This is the defect the whole-file-rewrite design avoids: the real API reads asynchronously and
    // writes synchronously, so an append that read the file would silently truncate it every time.
    const { fs, files } = fakeFs();
    const sink = createFileLogSink({ fs, path: () => "/logs/event.log" });
    for (const line of ["a", "b", "c"]) sink.write(line);
    expect(files.get("/logs/event.log")).toBe("a\nb\nc\n");
  });

  it("keeps the last N lines once the cap is passed", () => {
    const { fs, files } = fakeFs();
    const sink = createFileLogSink({ fs, path: () => "/logs/event.log", maxLines: 2 });
    for (const line of ["a", "b", "c"]) sink.write(line);
    expect(files.get("/logs/event.log")).toBe("b\nc\n");
  });

  it("reads a file left by a previous session", async () => {
    // A launch right after a crash is exactly when the previous run's log matters most.
    const { fs, files } = fakeFs();
    files.set("/logs/event.log", "from the last run\n");
    const sink = createFileLogSink({ fs, path: () => "/logs/event.log" });
    expect(await sink.read()).toBe("from the last run\n");
  });

  it("reads as empty when nothing has been written", async () => {
    const { fs } = fakeFs();
    const sink = createFileLogSink({ fs, path: () => "/logs/event.log" });
    expect(await sink.read()).toBe("");
  });

  it("clears the file", async () => {
    const { fs, files } = fakeFs();
    const sink = createFileLogSink({ fs, path: () => "/logs/event.log" });
    sink.write("something");
    await sink.clear();
    expect(files.has("/logs/event.log")).toBe(false);
    expect(await sink.read()).toBe("");
  });
});
