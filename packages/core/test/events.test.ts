import { describe, expect, it, vi } from "vitest";
import { EventBus } from "@mobileclaw/core";
import { Context, setLogSink } from "@mobileclaw/core";

describe("EventBus", () => {
  it("awaits listeners in registration order", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on("log", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push("first");
    });
    bus.on("log", () => {
      seen.push("second");
    });
    await bus.emit("log", "info", "hello");
    expect(seen).toEqual(["first", "second"]);
  });

  it("keeps emitting after a listener throws and reports it on the log channel", async () => {
    const bus = new EventBus();
    const errors: string[] = [];
    const survivor = vi.fn();
    bus.on("log", (_level, message) => {
      errors.push(message);
    });
    bus.on("tool/call", () => {
      throw new Error("boom");
    });
    bus.on("tool/call", survivor);

    await bus.emit("tool/call", "fs_read", { path: "/tmp/a" });
    expect(survivor).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("tool/call");
  });

  it("supports once() and disposal", async () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.once("log", listener);
    await bus.emit("log", "info", "one");
    await bus.emit("log", "info", "two");
    expect(listener).toHaveBeenCalledOnce();

    const off = bus.on("log", listener);
    off();
    await bus.emit("log", "info", "three");
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("Context", () => {
  it("resolves services from ancestors and namespaces plugin state", () => {
    const root = new Context({ label: "root" });
    root.provide("fs", { kind: "test" });
    const child = root.extend("cap-files");
    expect(child.has("fs")).toBe(true);
    expect(child.get("fs")).toEqual({ kind: "test" });
    expect(child.store.scope("cache")).toBe("cap-files:cache");
  });

  it("reports missing services with the available names", () => {
    const ctx = new Context({ label: "root" });
    ctx.provide("fs", { kind: "test" });
    expect(() => ctx.get("shell")).toThrowError(/service "shell" is not available/);
    try {
      ctx.get("shell");
    } catch (error) {
      expect((error as { details?: { available?: string[] } }).details?.available).toEqual(["fs"]);
    }
  });

  it("disposes children before parents and clears services", async () => {
    const order: string[] = [];
    const root = new Context({ label: "root" });
    const child = root.extend("child");
    child.onDispose(() => order.push("child"));
    root.onDispose(() => order.push("root"));
    await root.dispose();
    expect(order).toEqual(["child", "root"]);
  });

  it("routes logs through the installed sink", () => {
    const entries: string[] = [];
    setLogSink((entry) => entries.push(`${entry.level}:${entry.label}:${entry.message}`));
    const ctx = new Context({ label: "probe" });
    ctx.logger.warn("careful");
    expect(entries).toEqual(["warn:probe:careful"]);
    setLogSink(() => {});
  });
});
