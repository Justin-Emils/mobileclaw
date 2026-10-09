import { describe, expect, it } from "vitest";
import {
  PROBE_CACHE_KEY,
  classifyReading,
  createProbeCache,
  formatProbeReport,
  looksProtected,
  readCache,
  recordFailure,
  recordFromSnapshot,
  runScreenProbe,
  stalePackages,
  summarise,
  type ProbeCache,
  type ScreenProbeRecord,
} from "@mobileclaw/capabilities";
import {
  MemoryKeyValueStore,
  type AutomationService,
  type ScreenNode,
  type ScreenSnapshot,
  type SystemService,
} from "@mobileclaw/core";

/**
 * The app-readability inventory.
 *
 * The classification is the part worth pinning, because the counts alone cannot tell the
 * outcomes apart: a protected window and a genuinely empty screen both come back with zero
 * elements, and they mean opposite things. `blocked` says "stop trying this app"; `empty`
 * says "this screen published nothing, maybe another screen will". A test that only counted
 * elements would pass while the app reported the wrong advice.
 *
 * The runner is driven with stubs, so the merge and cache rules are checked without a
 * device: a later probe of three apps must not erase the earlier inventory of thirty, and
 * one app failing to open must not lose the results of the ones that worked.
 */

const APP_A = "com.example.alpha";
const APP_B = "com.example.beta";
const APP_C = "com.example.gamma";
const LABEL_A = "Alpha";
const PASSWORD_NOTE = "看起来是纯色画面：受保护的内容";

function node(over: Partial<ScreenNode> = {}): ScreenNode {
  return { index: 0, text: "Label", ...over };
}

function snapshotOf(over: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  return { nodes: [node({ clickable: true })], total: 1, ...over };
}

/** A cache backed by the real key-value store, so serialisation is exercised too. */
function cacheAt(kv: MemoryKeyValueStore): ProbeCache {
  return createProbeCache(kv);
}

/** A fake in-memory cache that records writes, for assertions about persistence. */
function trackingCache(initial: ScreenProbeRecord[] = []) {
  let stored = [...initial];
  const writes: ScreenProbeRecord[][] = [];
  return {
    writes,
    read: async () => [...stored],
    write: async (records: ScreenProbeRecord[]) => {
      stored = [...records];
      writes.push([...records]);
    },
    contents: () => stored,
  };
}

/** A screen backend whose reading is scripted per package. */
function probeSystem(
  readings: Record<string, ScreenSnapshot | Error>,
  over: Partial<SystemService> = {},
): { system: SystemService; opened: string[] } {
  const opened: string[] = [];
  let current: string | undefined;
  const automation: AutomationService = {
    kind: "shizuku",
    async status() {
      return { available: true, backend: "shizuku", uid: 2000 };
    },
    async captureScreen() {
      return { path: "file:///x.jpg", width: 1, height: 1 };
    },
    async tap() {},
    async scroll() {},
    async typeText() {
      return { method: "input" as const };
    },
    async currentWindow() {
      return { package: current, raw: "" };
    },
    async readScreen() {
      const entry = current === undefined ? undefined : readings[current];
      if (entry instanceof Error) throw entry;
      return entry ?? snapshotOf({ nodes: [], total: 0 });
    },
  };

  const system: SystemService = {
    kind: "stub",
    async openUrl() {},
    async openApp(packageId: string) {
      opened.push(packageId);
      current = packageId;
    },
    automation,
    ...over,
  };
  return { system, opened };
}

/** A record with just the fields a staleness decision looks at. */
function cachedRecord(packageId: string, at: number): ScreenProbeRecord {
  return { packageId, status: "readable", elements: 1, totalNodes: 1, pressable: 1, at, durationMs: 1 };
}

describe("looksProtected", () => {
  it("recognises the English phrasing", () => {
    expect(looksProtected("the window is FLAG_SECURE")).toBe(true);
  });

  it("recognises the localised phrasing, because the note is composed in another layer", () => {
    expect(looksProtected(PASSWORD_NOTE)).toBe(true);
  });

  it("does not treat a generic failure as protection", () => {
    expect(looksProtected("the screen could not be read: timed out")).toBe(false);
    expect(looksProtected(undefined)).toBe(false);
  });
});

describe("classifyReading", () => {
  it("calls a screen with pressable elements readable", () => {
    expect(classifyReading(snapshotOf())).toBe("readable");
  });

  it("separates 'text but nothing pressable' from 'nothing at all'", () => {
    const labelsOnly = snapshotOf({ nodes: [node({ clickable: false })], total: 1 });
    expect(classifyReading(labelsOnly)).toBe("labels-only");
  });

  it("calls a reading with no elements empty", () => {
    expect(classifyReading(snapshotOf({ nodes: [], total: 0 }))).toBe("empty");
  });

  it("calls a protected window blocked, not empty", () => {
    // This is the case the counts cannot distinguish, and the one where "empty" is
    // actively wrong advice: the app is unreadable by design, not unreadable by accident.
    const blocked = snapshotOf({ nodes: [], total: 0, note: PASSWORD_NOTE });
    expect(classifyReading(blocked)).toBe("blocked");
  });

  it("prefers the protection explanation even when elements came back", () => {
    // Some protected screens still publish a frame's worth of chrome.
    const blocked = snapshotOf({ total: 1, note: "FLAG_SECURE window" });
    expect(classifyReading(blocked)).toBe("blocked");
  });
});

describe("recordFromSnapshot", () => {
  it("counts pressable elements and keeps the backend's note", () => {
    const reading = snapshotOf({
      nodes: [node({ clickable: true }), node({ index: 1 }), node({ index: 2, clickable: true })],
      total: 9,
      note: "some text was shortened",
      package: APP_A,
    });
    const record = recordFromSnapshot({ packageId: APP_A, label: LABEL_A }, reading, {
      at: 1000,
      durationMs: 250,
    });

    expect(record.status).toBe("readable");
    expect(record.elements).toBe(3);
    expect(record.totalNodes).toBe(9);
    expect(record.pressable).toBe(2);
    expect(record.note).toBe("some text was shortened");
    expect(record.package).toBe(APP_A);
    expect(record.label).toBe(LABEL_A);
  });

  it("flags a screen containing password fields", () => {
    // Worth surfacing: it is the screen a user would least want automated by accident.
    const reading = snapshotOf({ nodes: [node({ password: true, clickable: true })], total: 1 });
    expect(recordFromSnapshot({ packageId: APP_A }, reading, { at: 1, durationMs: 1 }).passwordFields).toBe(1);
  });

  it("omits optional fields rather than carrying empty ones", () => {
    const record = recordFromSnapshot({ packageId: APP_A }, snapshotOf(), { at: 1, durationMs: 1 });
    expect(record).not.toHaveProperty("note");
    expect(record).not.toHaveProperty("passwordFields");
    expect(record).not.toHaveProperty("label");
  });
});

describe("recordFailure", () => {
  it("records the reason instead of throwing", () => {
    const record = recordFailure({ packageId: APP_A }, new Error("app not installed"), {
      at: 5,
      durationMs: 2,
    });
    expect(record.status).toBe("failed");
    expect(record.error).toBe("app not installed");
    expect(record.elements).toBe(0);
  });
});

describe("summarise", () => {
  it("counts every status, including the ones with none", () => {
    const records = [
      cachedRecord(APP_A, 1),
      { ...cachedRecord(APP_B, 1), status: "blocked" as const },
      { ...cachedRecord(APP_C, 1), status: "blocked" as const },
    ];
    expect(summarise(records)).toEqual({
      readable: 1,
      "labels-only": 0,
      empty: 0,
      blocked: 2,
      failed: 0,
    });
  });
});

describe("stalePackages", () => {
  it("re-probes what was never probed", () => {
    expect(stalePackages([APP_A], [], { ttlMs: 100, now: 0 })).toEqual([APP_A]);
  });

  it("keeps a fresh entry", () => {
    expect(stalePackages([APP_A], [cachedRecord(APP_A, 1000)], { ttlMs: 100, now: 1050 })).toEqual([]);
  });

  it("re-probes an expired entry", () => {
    expect(stalePackages([APP_A], [cachedRecord(APP_A, 1000)], { ttlMs: 100, now: 1200 })).toEqual([APP_A]);
  });
});

describe("createProbeCache", () => {
  it("round-trips through the key-value store", async () => {
    const kv = new MemoryKeyValueStore();
    const cache = cacheAt(kv);
    const records = [cachedRecord(APP_A, 42)];

    await cache.write(records);
    expect(await cache.read()).toEqual(records);
    // The document has a name, so a caller can find it without guessing.
    expect(await kv.get(PROBE_CACHE_KEY)).toBeTruthy();
  });

  it("treats corrupt content as nothing cached rather than failing", async () => {
    const kv = new MemoryKeyValueStore();
    await kv.set(PROBE_CACHE_KEY, "{not json");
    expect(await cacheAt(kv).read()).toEqual([]);
  });

  it("keeps entries that look like records and drops the rest", async () => {
    const kv = new MemoryKeyValueStore();
    const good = cachedRecord(APP_A, 1);
    await kv.set(PROBE_CACHE_KEY, JSON.stringify([good, { nope: true }, null, "junk"]));
    const records = await readCache(cacheAt(kv));
    expect(records).toEqual([good]);
  });

  it("treats a read failure as an empty cache", async () => {
    const broken: ProbeCache = {
      read: async () => {
        throw new Error("store unavailable");
      },
      write: async () => {},
    };
    expect(await readCache(broken)).toEqual([]);
  });
});

describe("runScreenProbe", () => {
  it("opens each app, waits for it, and records what came back", async () => {
    const { system, opened } = probeSystem({
      [APP_A]: snapshotOf(),
      [APP_B]: snapshotOf({ nodes: [], total: 0 }),
    });
    const report = await runScreenProbe(
      { system, cache: trackingCache() },
      [{ packageId: APP_A, label: LABEL_A }, { packageId: APP_B }],
      { settleMs: 1 },
    );

    expect(opened).toEqual([APP_A, APP_B]);
    expect(report.summary.readable).toBe(1);
    expect(report.summary.empty).toBe(1);
    expect(formatProbeReport(report)).toContain(LABEL_A);
  });

  it("records a failure and keeps going, so one bad app loses nothing", async () => {
    // The same rule the tool layer follows: a capability failing is data.
    const { system } = probeSystem({
      [APP_A]: snapshotOf(),
      [APP_B]: new Error("app refused to open"),
      [APP_C]: snapshotOf(),
    });
    const report = await runScreenProbe(
      { system, cache: trackingCache() },
      [{ packageId: APP_A }, { packageId: APP_B }, { packageId: APP_C }],
      { settleMs: 1 },
    );

    expect(report.summary.readable).toBe(2);
    expect(report.summary.failed).toBe(1);
    expect(report.records.find((record) => record.packageId === APP_B)?.error).toMatch(/refused/);
  });

  it("skips probing for entries that are still fresh, and says how many it reused", async () => {
    const cache = trackingCache([cachedRecord(APP_A, Date.now())]);
    const { system, opened } = probeSystem({ [APP_A]: snapshotOf() });
    const report = await runScreenProbe({ system, cache }, [{ packageId: APP_A }], { settleMs: 1 });

    expect(opened).toEqual([]);
    expect(report.fromCache).toBe(1);
    expect(report.records).toHaveLength(1);
  });

  it("probes only what is missing from the cache", async () => {
    const cache = trackingCache([cachedRecord(APP_A, Date.now())]);
    const { system, opened } = probeSystem({ [APP_B]: snapshotOf() });
    await runScreenProbe({ system, cache }, [{ packageId: APP_A }, { packageId: APP_B }], {
      settleMs: 1,
    });
    expect(opened).toEqual([APP_B]);
  });

  it("keeps earlier results when a later probe covers fewer apps", async () => {
    // Otherwise probing three apps would erase the inventory of thirty.
    const cache = trackingCache([cachedRecord(APP_A, Date.now())]);
    const { system } = probeSystem({ [APP_B]: snapshotOf() });
    await runScreenProbe({ system, cache }, [{ packageId: APP_B }], { settleMs: 1 });

    const packages = cache.contents().map((record) => record.packageId).sort();
    expect(packages).toEqual([APP_A, APP_B]);
  });

  it("reports only the packages that were asked about", async () => {
    const cache = trackingCache([cachedRecord(APP_C, Date.now())]);
    const { system } = probeSystem({ [APP_A]: snapshotOf() });
    const report = await runScreenProbe({ system, cache }, [{ packageId: APP_A }], { settleMs: 1 });

    expect(report.records.map((record) => record.packageId)).toEqual([APP_A]);
    // ...while still keeping C in the cache for later.
    expect(cache.contents().map((record) => record.packageId).sort()).toEqual([APP_A, APP_C]);
  });

  it("probes nothing in cachedOnly mode", async () => {
    const cache = trackingCache([cachedRecord(APP_A, Date.now())]);
    const { system, opened } = probeSystem({ [APP_B]: snapshotOf() });
    const report = await runScreenProbe({ system, cache }, [{ packageId: APP_B }], {
      cachedOnly: true,
    });

    expect(opened).toEqual([]);
    // B was asked about and is not cached, so it is reported as nothing yet — not invented.
    expect(report.records).toEqual([]);
    // ...and nothing was served from the cache, because B was not in it.
    expect(report.fromCache).toBe(0);
  });

  it("counts a reused entry only in the cachedOnly branch", async () => {
    // `fromCache` counts entries in this request that were already fresh. In cachedOnly mode
    // nothing is served — the answer is simply whatever the cache held — so the count is 0
    // and the records are the whole story.
    const cache = trackingCache([cachedRecord(APP_A, Date.now())]);
    const { system } = probeSystem({ [APP_A]: snapshotOf() });
    const report = await runScreenProbe({ system, cache }, [{ packageId: APP_A }], {
      cachedOnly: true,
    });

    expect(report.fromCache).toBe(0);
    expect(report.records).toHaveLength(1);
  });

  it("fails every entry with a readable reason when there is no screen backend", async () => {
    const system: SystemService = { kind: "stub", async openUrl() {}, async openApp() {} };
    const report = await runScreenProbe(
      { system, cache: trackingCache() },
      [{ packageId: APP_A }],
      { settleMs: 1 },
    );

    expect(report.summary.failed).toBe(1);
    expect(report.records[0]?.error).toMatch(/privileged screen backend/);
  });

  it("stops early when the run is cancelled, keeping what it already probed", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const { system } = probeSystem({ [APP_A]: snapshotOf(), [APP_B]: snapshotOf() });
    const report = await runScreenProbe(
      { system, cache: trackingCache() },
      [{ packageId: APP_A }, { packageId: APP_B }],
      { settleMs: 1 },
      {
        signal: controller.signal,
        onRecord: (record) => {
          seen.push(record.packageId);
          controller.abort();
        },
      },
    );

    expect(seen).toEqual([APP_A]);
    expect(report.records.map((record) => record.packageId)).toEqual([APP_A]);
  });

  it("reports progress with an index and a total", async () => {
    const progress: Array<{ index: number; total: number }> = [];
    const { system } = probeSystem({ [APP_A]: snapshotOf(), [APP_B]: snapshotOf() });
    await runScreenProbe(
      { system, cache: trackingCache() },
      [{ packageId: APP_A }, { packageId: APP_B }],
      { settleMs: 1 },
      { onProgress: (event) => progress.push({ index: event.index, total: event.total }) },
    );

    expect(progress).toEqual([
      { index: 0, total: 2 },
      { index: 1, total: 2 },
    ]);
  });

  it("still returns results when the cache cannot be written", async () => {
    const broken: ProbeCache = {
      read: async () => [],
      write: async () => {
        throw new Error("disk full");
      },
    };
    const { system } = probeSystem({ [APP_A]: snapshotOf() });
    const report = await runScreenProbe({ system, cache: broken }, [{ packageId: APP_A }], {
      settleMs: 1,
    });
    expect(report.records).toHaveLength(1);
  });
});

describe("formatProbeReport", () => {
  it("says nothing has been probed rather than showing an empty table", () => {
    expect(formatProbeReport({ records: [], summary: summarise([]), fromCache: 0 })).toMatch(/还没有探测/);
  });

  it("lists the statuses that occurred, and names protected content plainly", () => {
    const records: ScreenProbeRecord[] = [
      cachedRecord(APP_A, 1),
      { ...cachedRecord(APP_B, 1), status: "blocked", note: PASSWORD_NOTE },
    ];
    const text = formatProbeReport({ records, summary: summarise(records), fromCache: 0 });

    expect(text).toContain("可读可点 1");
    expect(text).toContain("受保护");
    expect(text).toContain(APP_B);
  });

  it("shows the error for a failed app instead of a fake element count", () => {
    const records: ScreenProbeRecord[] = [
      { ...cachedRecord(APP_A, 1), status: "failed", error: "app refused to open" },
    ];
    expect(formatProbeReport({ records, summary: summarise(records), fromCache: 0 })).toContain(
      "app refused to open",
    );
  });
});
