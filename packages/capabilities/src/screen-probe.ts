import type { KeyValueStore, ScreenSnapshot, SystemService } from "@mobileclaw/core";

/**
 * Probing which installed apps publish a readable accessibility tree.
 *
 * The question this answers cannot be answered from documentation. Whether an app exposes
 * a usable semantic tree is a **runtime property**: it depends on the app version, on the
 * particular screen, and on the account's state. Two builds of the same app differ; the
 * home screen and an embedded WebView differ. No public dataset records it, which is why
 * the only honest source is the device itself.
 *
 * So the device does the answering: open the app, read the screen through the privileged
 * backend, and record what came back. The results are cached, because the probe costs one
 * app switch and a wait per entry and the answer changes slowly.
 *
 * The classification is deliberately conservative, and "nothing readable" is split into
 * several outcomes rather than one. `blocked` (a protected window), `empty` (nothing was
 * published at all) and `labels-only` (text but nothing pressable) each imply a different
 * next move — the first means "this app cannot be automated this way, stop trying", while
 * the last means "this screen is readable but you cannot press anything on it yet".
 */

/* ------------------------------------------------------------------ shapes --- */

export type ScreenProbeStatus =
  /** Elements with labels, and at least one of them pressable. */
  | "readable"
  /** Labels came back but nothing is pressable — readable, not yet actionable. */
  | "labels-only"
  /** The backend answered and the screen published nothing. */
  | "empty"
  /** Protected content: `FLAG_SECURE` looks identical to a genuinely empty screen. */
  | "blocked"
  /** The read or the app launch failed. */
  | "failed";

export interface ScreenProbeRecord {
  packageId: string;
  label?: string;
  status: ScreenProbeStatus;
  /** Elements the reading kept, after its budget. */
  elements: number;
  /** Nodes the projection examined before the budget. */
  totalNodes: number;
  /** How many elements reported a press action. */
  pressable: number;
  /** The app that was in the foreground when the reading was taken. */
  package?: string;
  /** Why the reading is thin, when the backend could say. */
  note?: string;
  /** How many nodes carried a password flag — a screen worth being careful about. */
  passwordFields?: number;
  error?: string;
  /** When the probe ran, epoch ms. */
  at: number;
  durationMs: number;
}

export interface ScreenProbeReport {
  records: ScreenProbeRecord[];
  /** Counts per status, so a caller can summarise without walking the list. */
  summary: Record<ScreenProbeStatus, number>;
  /** Entries served from the cache instead of being re-probed. */
  fromCache: number;
}

/** Somewhere to keep results between runs. The app backs this with its SQLite store. */
export interface ProbeCache {
  read(): Promise<ScreenProbeRecord[]>;
  write(records: ScreenProbeRecord[]): Promise<void>;
}

/** What a caller can observe while a probe runs. */
export interface ScreenProbeHooks {
  onProgress?: (event: { index: number; total: number; packageId: string }) => void;
  onRecord?: (record: ScreenProbeRecord) => void;
  signal?: AbortSignal;
}

export interface ScreenProbeOptions {
  /** Cache age past which an entry is probed again. */
  ttlMs?: number;
  /** Report only what is cached; probe nothing. */
  cachedOnly?: boolean;
  /** How long to wait after launching before reading, in ms. */
  settleMs?: number;
}

/* --------------------------------------------------------------- constants --- */

const DEFAULTS = {
  /**
   * How long to wait for an app to show something after being launched.
   *
   * A cold start of a large app takes seconds, and reading too early records "empty" for an
   * app that is merely still starting — a wrong answer that looks like a finding. The cost
   * of waiting is time; the cost of not waiting is a false negative that gets cached.
   */
  settleMs: 2000,
  /** Re-probe after a week: version updates are what move this answer. */
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  /** Where the records live in the key-value store. */
  key: "screenProbe.v1",
} as const;

/**
 * Text that means "protected" rather than "empty".
 *
 * Matched loosely and case-insensitively because the wording is composed in different
 * layers, and a protected window is the one case where "nothing here" is actively wrong.
 */
const PROTECTED_MARKERS = ["flag_secure", "protected", "受保护"] as const;

const ZERO_SUMMARY: Record<ScreenProbeStatus, number> = {
  readable: 0,
  "labels-only": 0,
  empty: 0,
  blocked: 0,
  failed: 0,
};

/* ------------------------------------------------------------------ logic --- */

/** Does the backend's own note describe protected content? */
export function looksProtected(note: string | undefined): boolean {
  if (!note) return false;
  const lower = note.toLowerCase();
  return PROTECTED_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Turn one reading into a verdict.
 *
 * Ordered so the most specific explanation wins: a note about protection outranks "there
 * were no elements", because those two look the same in the counts and mean opposite things.
 */
export function classifyReading(snapshot: ScreenSnapshot): ScreenProbeStatus {
  if (looksProtected(snapshot.note)) return "blocked";
  if (snapshot.nodes.length === 0) return "empty";
  if (snapshot.nodes.some((node) => node.clickable === true)) return "readable";
  return "labels-only";
}

/** Count how many records carry each status. */
export function summarise(records: ScreenProbeRecord[]): Record<ScreenProbeStatus, number> {
  const summary = { ...ZERO_SUMMARY };
  for (const record of records) summary[record.status] += 1;
  return summary;
}

/** Build a record from a reading. Pure, so the classification is directly testable. */
export function recordFromSnapshot(
  app: { packageId: string; label?: string },
  snapshot: ScreenSnapshot,
  timing: { at: number; durationMs: number },
): ScreenProbeRecord {
  const pressable = snapshot.nodes.filter((node) => node.clickable === true).length;
  const passwordFields = snapshot.nodes.filter((node) => node.password === true).length;
  const status = classifyReading(snapshot);

  return {
    packageId: app.packageId,
    ...(app.label ? { label: app.label } : {}),
    status,
    elements: snapshot.nodes.length,
    totalNodes: snapshot.total,
    pressable,
    ...(snapshot.package ? { package: snapshot.package } : {}),
    ...(snapshot.note ? { note: snapshot.note } : {}),
    ...(passwordFields > 0 ? { passwordFields } : {}),
    at: timing.at,
    durationMs: timing.durationMs,
  };
}

/** A record for an attempt that threw. */
export function recordFailure(
  app: { packageId: string; label?: string },
  error: unknown,
  timing: { at: number; durationMs: number },
): ScreenProbeRecord {
  return {
    packageId: app.packageId,
    ...(app.label ? { label: app.label } : {}),
    status: "failed",
    elements: 0,
    totalNodes: 0,
    pressable: 0,
    error: error instanceof Error ? error.message : String(error),
    at: timing.at,
    durationMs: timing.durationMs,
  };
}

function isRecord(value: unknown): value is ScreenProbeRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["packageId"] === "string" &&
    typeof candidate["status"] === "string" &&
    typeof candidate["at"] === "number"
  );
}

/**
 * Read the cache, tolerating anything unexpected in it.
 *
 * A cache is not worth failing over. Corrupt or older-shaped content is treated as "nothing
 * cached", which costs one re-probe rather than breaking the screen that shows the results.
 */
export async function readCache(cache: ProbeCache): Promise<ScreenProbeRecord[]> {
  try {
    const records = await cache.read();
    return Array.isArray(records) ? records.filter(isRecord) : [];
  } catch {
    return [];
  }
}

/** Which packages still need probing, given what is cached and how old it is. */
export function stalePackages(
  packages: string[],
  cached: ScreenProbeRecord[],
  options: { ttlMs: number; now: number },
): string[] {
  const byPackage = new Map(cached.map((record) => [record.packageId, record]));
  return packages.filter((packageId) => {
    const record = byPackage.get(packageId);
    if (!record) return true;
    return options.now - record.at > options.ttlMs;
  });
}

/**
 * Run probes and merge them into the cache.
 *
 * Failures are recorded as `failed` rather than thrown: one app that will not open must not
 * lose the results of the twenty that did. That is the same rule the tool layer follows —
 * a capability failing is data.
 */
export async function runScreenProbe(
  deps: { system: SystemService; cache: ProbeCache },
  packages: Array<{ packageId: string; label?: string }>,
  options: ScreenProbeOptions = {},
  hooks: ScreenProbeHooks = {},
): Promise<ScreenProbeReport> {
  const ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
  const settleMs = options.settleMs ?? DEFAULTS.settleMs;
  const now = Date.now();

  const cached = await readCache(deps.cache);
  const stale = new Set(
    stalePackages(
      packages.map((entry) => entry.packageId),
      cached,
      { ttlMs, now },
    ),
  );
  const fresh = packages.filter((entry) => !stale.has(entry.packageId)).length;
  const fromCache = options.cachedOnly === true ? 0 : fresh;

  const probed: ScreenProbeRecord[] = [];
  if (options.cachedOnly !== true) {
    for (const [index, app] of packages.entries()) {
      if (hooks.signal?.aborted) break;
      if (!stale.has(app.packageId)) continue;

      hooks.onProgress?.({ index, total: packages.length, packageId: app.packageId });
      const started = Date.now();
      let record: ScreenProbeRecord;
      try {
        const automation = deps.system.automation;
        if (!automation) throw new Error("this device has no privileged screen backend");

        await deps.system.openApp(app.packageId);
        // Waiting is the difference between "this app publishes nothing" and "this app had
        // not finished starting". Recorded as a false negative if skipped.
        await sleep(settleMs, hooks.signal);
        const snapshot = await automation.readScreen({});
        record = recordFromSnapshot(app, snapshot, { at: started, durationMs: Date.now() - started });
      } catch (error) {
        record = recordFailure(app, error, { at: started, durationMs: Date.now() - started });
      }
      probed.push(record);
      hooks.onRecord?.(record);
    }
  }

  // Newest record per package wins; results for packages not in this request are kept, so a
  // later probe of three apps does not erase the earlier inventory of thirty.
  const merged = new Map<string, ScreenProbeRecord>();
  for (const record of cached) merged.set(record.packageId, record);
  for (const record of probed) merged.set(record.packageId, record);

  const all = [...merged.values()];
  try {
    await deps.cache.write(all);
  } catch {
    // A cache write that fails leaves the results usable in memory for this call; the next
    // run simply probes again.
  }

  const requestedIds = new Set(packages.map((entry) => entry.packageId));
  const records = all
    .filter((record) => requestedIds.has(record.packageId))
    .sort((a, b) => a.packageId.localeCompare(b.packageId));

  return { records, summary: summarise(records), fromCache };
}

/**
 * A cache over any `KeyValueStore`, so the app's SQLite store can back it with no new table.
 *
 * Stored as one JSON document rather than a key per app: the whole inventory is read and
 * written together by every caller, and a single document keeps the read path one call.
 */
export function createProbeCache(kv: KeyValueStore, key: string = DEFAULTS.key): ProbeCache {
  return {
    async read() {
      const raw = await kv.get(key);
      if (!raw) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as ScreenProbeRecord[]) : [];
      } catch {
        return [];
      }
    },
    async write(records) {
      await kv.set(key, JSON.stringify(records));
    },
  };
}

/** The cache key, so a caller can point at the same document without repeating the string. */
export const PROBE_CACHE_KEY = DEFAULTS.key;

/** Cancellable sleep: a probe parked here must not outlive a cancelled run. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled while waiting for the app to settle"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("cancelled while waiting for the app to settle"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------ report --- */

const STATUS_LABEL: Record<ScreenProbeStatus, string> = {
  readable: "可读可点",
  "labels-only": "只读不能点",
  empty: "读不到内容",
  blocked: "受保护（FLAG_SECURE）",
  failed: "失败",
};

/** One line per app, for a transcript or a settings screen. */
export function formatProbeReport(report: ScreenProbeReport): string {
  if (report.records.length === 0) {
    return "还没有探测过任何应用。先选几个应用再跑一次。";
  }
  const head = (Object.keys(report.summary) as ScreenProbeStatus[])
    .filter((status) => report.summary[status] > 0)
    .map((status) => `${STATUS_LABEL[status]} ${report.summary[status]}`)
    .join(" · ");

  const lines = report.records.map((record) => {
    const name = record.label ? `${record.label} (${record.packageId})` : record.packageId;
    const detail =
      record.status === "failed"
        ? (record.error ?? "未知错误")
        : `元素 ${record.elements} / 可点 ${record.pressable}`;
    const extra = record.note ? ` — ${record.note}` : "";
    return `- ${name}: ${STATUS_LABEL[record.status]} · ${detail}${extra}`;
  });

  return [head, "", ...lines].join("\n");
}
