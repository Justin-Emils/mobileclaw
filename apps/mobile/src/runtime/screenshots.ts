/**
 * Screenshot retention: which pictures have aged out, and doing something about it.
 *
 * ## Why the policy is a pure function
 *
 * The rule the user asked for is short — "keep three days, delete the older ones automatically,
 * but make me confirm when *I* delete something" — and it is the kind of rule that is quietly
 * wrong in the dangerous direction. Deleting too little leaves private conversations on disk;
 * deleting too much destroys the only evidence of what an agent did. Neither shows up in a
 * manual test on the day it is written.
 *
 * So the decision is separated from the doing: `expiredScreenshots` is a pure function of a
 * listing, a clock and a retention window, and it is tested at the boundaries (exactly at the
 * cutoff, a year old, a file with a nonsense timestamp). Everything below it is the plumbing that
 * feeds it real numbers.
 */

/** A picture found on disk. */
export interface ScreenshotFile {
  path: string;
  /** Milliseconds since the epoch, from the filesystem. */
  modifiedMs: number;
  sizeBytes?: number;
}

/** Retention choices offered to the user, in days. `0` means keep forever. */
export const RETENTION_CHOICES = [1, 3, 7, 30, 0] as const;
export type RetentionDays = (typeof RETENTION_CHOICES)[number];
export const DEFAULT_RETENTION_DAYS: RetentionDays = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function retentionMs(days: RetentionDays | number): number {
  return days > 0 ? days * MS_PER_DAY : 0;
}

/**
 * The files older than the retention window.
 *
 * `nowMs` is a parameter rather than read from the clock inside, so a test can say "this file is
 * three days and one second old" instead of waiting three days.
 *
 * The comparison is strict (`<`): a file exactly at the cutoff is kept. The asymmetry is
 * deliberate — being one tick late costs a few kilobytes, being one tick early destroys evidence,
 * and only one of those is recoverable.
 *
 * A retention of zero or less means keep everything, which is also what an unreadable setting
 * falls back to. Failing towards keeping is the safe direction: the user can always press the
 * button, and a bug that deletes someone's screenshots cannot be undone by any button.
 */
export function expiredScreenshots(
  files: readonly ScreenshotFile[],
  nowMs: number,
  retention: number,
): ScreenshotFile[] {
  if (retention <= 0) return [];
  const cutoff = nowMs - retention;
  return files.filter((file) => Number.isFinite(file.modifiedMs) && file.modifiedMs < cutoff);
}

/** What a prune did, in terms a screen can show without doing arithmetic. */
export interface PruneResult {
  deleted: number;
  freedBytes: number;
  kept: number;
}

/** The filesystem operations retention needs. Injected so tests can describe a disk. */
export interface ScreenshotStore {
  dir(): Promise<string>;
  list(dir: string): Promise<ScreenshotFile[]>;
  remove(path: string): Promise<void>;
}

export function createScreenshotRetention(store: ScreenshotStore, now: () => number = Date.now) {
  return {
    /**
     * Delete what has aged out. Never throws for a single unremovable file.
     *
     * A picture that cannot be deleted is reported in the counts rather than aborting the sweep:
     * one locked file should not stop the other nine from being cleaned up, and a cleanup that
     * stops half way leaves the disk in a state nobody can describe.
     */
    async prune(retention: number): Promise<PruneResult> {
      const dir = await store.dir();
      const files = await store.list(dir);
      const doomed = expiredScreenshots(files, now(), retention);

      let deleted = 0;
      let freedBytes = 0;
      for (const file of doomed) {
        try {
          await store.remove(file.path);
          deleted += 1;
          freedBytes += file.sizeBytes ?? 0;
        } catch {
          // Counted as kept, which is honest: it is still there.
        }
      }
      return { deleted, freedBytes, kept: files.length - deleted };
    },

    /** Everything, on purpose. Only ever called behind a confirmation. */
    async clearAll(): Promise<PruneResult> {
      const dir = await store.dir();
      const files = await store.list(dir);

      let deleted = 0;
      let freedBytes = 0;
      for (const file of files) {
        try {
          await store.remove(file.path);
          deleted += 1;
          freedBytes += file.sizeBytes ?? 0;
        } catch {
          // As above: what survived is what is reported as kept.
        }
      }
      return { deleted, freedBytes, kept: files.length - deleted };
    },

    /** Count and size, for showing the user what is being kept on their behalf. */
    async usage(): Promise<{ count: number; bytes: number }> {
      const dir = await store.dir();
      const files = await store.list(dir);
      return {
        count: files.length,
        bytes: files.reduce((total, file) => total + (file.sizeBytes ?? 0), 0),
      };
    },

    /**
     * Every screenshot, newest first, for the screen that shows them.
     *
     * Each entry carries `expired` because the screen has to say *which* ones are about to go.
     * Without it the user sees a deletion policy they cannot check against reality, and the only
     * way to learn what "3 days" means would be to wait three days.
     */
    async listing(retention: number): Promise<Array<ScreenshotFile & { expired: boolean }>> {
      const dir = await store.dir();
      const files = await store.list(dir);
      const doomed = new Set(expiredScreenshots(files, now(), retention).map((file) => file.path));
      return [...files]
        .sort((a, b) => b.modifiedMs - a.modifiedMs)
        .map((file) => ({ ...file, expired: doomed.has(file.path) }));
    },

    /** One picture, on the user's explicit instruction. */
    async remove(path: string): Promise<void> {
      await store.remove(path);
    },
  };
}

export type ScreenshotRetention = ReturnType<typeof createScreenshotRetention>;

/* ------------------------------------------------------------------ adapters */

/** The slice of `expo-file-system`'s object API that retention needs. */
export interface ExpoFileLikePort {
  uri: string;
  size?: number | null;
  modificationTime?: number | null;
  delete(): void;
}
export interface ExpoDirectoryLikePort {
  exists?: boolean;
  list(): ExpoFileLikePort[];
}
export interface ExpoFsPort {
  File: new (path: string) => ExpoFileLikePort;
  Directory: new (path: string) => ExpoDirectoryLikePort;
}

/**
 * Retention backed by `expo-file-system`.
 *
 * A missing directory reads as an empty one rather than an error. On a fresh install nothing has
 * been captured yet, and "there is nothing to delete" is the correct answer to that — making the
 * caller handle an exception for the normal state of a new phone is how a cleanup path ends up
 * wrapped in a try/catch that also swallows the real failures.
 */
export function createExpoScreenshotStore(
  fs: ExpoFsPort,
  dir: () => string | undefined,
): ScreenshotStore {
  return {
    async dir() {
      const path = dir();
      if (!path) throw new Error("no screenshot directory is configured");
      return path;
    },
    async list(path) {
      try {
        const directory = new fs.Directory(path);
        return directory.list().map((file) => ({
          path: file.uri,
          // An unknown timestamp is treated as *new*, so a file whose metadata cannot be read is
          // kept. Deleting evidence because its mtime was unreadable would be the wrong guess.
          modifiedMs: file.modificationTime ?? Number.POSITIVE_INFINITY,
          sizeBytes: file.size ?? undefined,
        }));
      } catch {
        return [];
      }
    },
    async remove(path) {
      new fs.File(path).delete();
    },
  };
}

/**
 * Ask the native module where screenshots go, then remember the answer.
 *
 * Cached because the answer is a constant for the life of the process, and because the
 * alternative — an async hop before every capture and every sweep — would put a `await` between
 * a screenshot and its destination for no benefit.
 *
 * Resolved once at startup rather than lazily, so that a build without the native module (the
 * optional `native-shizuku` dependency) reports "no directory" immediately and the screenshot
 * tools fall back to the backend's own choice, instead of failing at the moment of capture.
 */
export async function resolveScreenshotDir(
  native: { screenshotDir?(): Promise<string> } | undefined,
): Promise<() => string | undefined> {
  if (!native?.screenshotDir) return () => undefined;
  try {
    const path = await native.screenshotDir();
    return () => path;
  } catch {
    return () => undefined;
  }
}
