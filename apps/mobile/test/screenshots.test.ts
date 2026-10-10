import { describe, expect, it } from "vitest";
import {
  createScreenshotRetention,
  expiredScreenshots,
  retentionMs,
  RETENTION_CHOICES,
  DEFAULT_RETENTION_DAYS,
  type ScreenshotFile,
  type ScreenshotStore,
} from "../src/runtime/screenshots";

/**
 * Retention: what gets deleted, and what must not.
 *
 * The user's rule is "keep three days, delete the older ones by itself, but make me confirm when
 * I delete something". The dangerous half is the automatic deletion, because it runs unattended:
 * deleting too little quietly leaves private conversations on disk, and deleting too much
 * destroys the only record of what an agent did. Neither is visible in a manual check on the day
 * it is written, so the boundaries are pinned here.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);

function file(name: string, ageDays: number, sizeBytes = 1000): ScreenshotFile {
  return { path: `/files/screenshots/${name}`, modifiedMs: NOW - ageDays * DAY, sizeBytes };
}

/** A store that records what it was asked to delete. */
function fakeStore(files: ScreenshotFile[], onRemove?: (path: string) => void) {
  const removed: string[] = [];
  const store: ScreenshotStore = {
    async dir() {
      return "/files/screenshots";
    },
    async list() {
      return files;
    },
    async remove(path) {
      // Recorded before the failure hook runs, so the log is of what was *attempted* — which is
      // what this test is about. Pushing afterwards would silently drop the failing file and make
      // the assertion below read as if the sweep had stopped early.
      removed.push(path);
      onRemove?.(path);
    },
  };
  return { store, removed };
}

describe("expiredScreenshots", () => {
  it("deletes what is older than the window and keeps what is not", () => {
    const files = [file("old.jpg", 4), file("fresh.jpg", 1)];
    const doomed = expiredScreenshots(files, NOW, retentionMs(3));
    expect(doomed.map((f) => f.path)).toEqual(["/files/screenshots/old.jpg"]);
  });

  it("keeps a file sitting exactly on the cutoff", () => {
    // The comparison is strict on purpose. Being a tick late costs a few kilobytes; being a tick
    // early destroys evidence, and only one of those can be undone.
    const files = [file("exactly-three-days.jpg", 3)];
    expect(expiredScreenshots(files, NOW, retentionMs(3))).toEqual([]);
  });

  it("deletes a file one millisecond past the cutoff", () => {
    const files: ScreenshotFile[] = [
      { path: "/files/screenshots/just-over.jpg", modifiedMs: NOW - retentionMs(3) - 1 },
    ];
    expect(expiredScreenshots(files, NOW, retentionMs(3))).toHaveLength(1);
  });

  it("keeps everything when the setting is 'forever'", () => {
    const files = [file("ancient.jpg", 3650)];
    expect(expiredScreenshots(files, NOW, retentionMs(0))).toEqual([]);
  });

  it("keeps everything when the setting is nonsense", () => {
    // Failing towards keeping. A bug that deletes someone's screenshots cannot be undone by any
    // button, so an unreadable setting must not be read as "delete now".
    const files = [file("old.jpg", 4)];
    expect(expiredScreenshots(files, NOW, retentionMs(-5))).toEqual([]);
    expect(expiredScreenshots(files, NOW, Number.NaN)).toEqual([]);
  });

  it("keeps a file whose timestamp could not be read", () => {
    // An unreadable mtime reads as *new*, so the file survives. Guessing "old" here would delete
    // evidence on the strength of a failed stat.
    const files: ScreenshotFile[] = [
      { path: "/files/screenshots/no-mtime.jpg", modifiedMs: Number.POSITIVE_INFINITY },
    ];
    expect(expiredScreenshots(files, NOW, retentionMs(3))).toEqual([]);
  });

  it("offers 3 days as the default", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(3);
    expect(RETENTION_CHOICES).toContain(3);
    // 0 is the "keep" option and has to stay offered.
    expect(RETENTION_CHOICES).toContain(0);
  });
});

describe("createScreenshotRetention", () => {
  it("reports how many it removed and how much that freed", async () => {
    const { store, removed } = fakeStore([file("a.jpg", 5, 2000), file("b.jpg", 6, 3000), file("c.jpg", 1, 50)]);
    const retention = createScreenshotRetention(store, () => NOW);

    const result = await retention.prune(retentionMs(3));
    expect(result).toEqual({ deleted: 2, freedBytes: 5000, kept: 1 });
    expect(removed).toHaveLength(2);
  });

  it("deletes nothing, and says so, when nothing has expired", async () => {
    const { store, removed } = fakeStore([file("a.jpg", 0), file("b.jpg", 2)]);
    const retention = createScreenshotRetention(store, () => NOW);

    expect(await retention.prune(retentionMs(3))).toEqual({ deleted: 0, freedBytes: 0, kept: 2 });
    expect(removed).toEqual([]);
  });

  it("keeps sweeping after one file refuses to be deleted", async () => {
    // One locked file must not stop the other nine. A cleanup that stops half way leaves the disk
    // in a state nobody can describe, and the counts would be wrong rather than merely incomplete.
    const { store, removed } = fakeStore([file("locked.jpg", 5), file("b.jpg", 6), file("c.jpg", 7)], (path) => {
      if (path.endsWith("locked.jpg")) throw new Error("EBUSY");
    });
    const retention = createScreenshotRetention(store, () => NOW);

    const result = await retention.prune(retentionMs(3));
    expect(result.deleted).toBe(2);
    // The one that survived is counted as kept, which is honest: it is still there.
    expect(result.kept).toBe(1);
    expect(removed).toHaveLength(3);
  });

  it("clears everything only when asked", async () => {
    const { store } = fakeStore([file("a.jpg", 0), file("b.jpg", 99)]);
    const retention = createScreenshotRetention(store, () => NOW);
    expect(await retention.clearAll()).toEqual({ deleted: 2, freedBytes: 2000, kept: 0 });
  });

  it("reports the count and size it is holding", async () => {
    const { store } = fakeStore([file("a.jpg", 1, 500), file("b.jpg", 2, 1500)]);
    const retention = createScreenshotRetention(store, () => NOW);
    expect(await retention.usage()).toEqual({ count: 2, bytes: 2000 });
  });

  it("treats a missing directory as empty rather than as a failure", async () => {
    // A fresh install has captured nothing, and that is the normal case, not an error.
    const store: ScreenshotStore = {
      async dir() {
        return "/files/screenshots";
      },
      async list() {
        return [];
      },
      async remove() {
        throw new Error("should not be called");
      },
    };
    const retention = createScreenshotRetention(store, () => NOW);
    expect(await retention.prune(retentionMs(3))).toEqual({ deleted: 0, freedBytes: 0, kept: 0 });
  });
});
