import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, zodToJsonSchema } from "@mobileclaw/core";

const echoTool = {
  name: "echo_text",
  description: "Echo text back.",
  input: z.object({
    text: z.string().min(1).describe("Text to echo."),
    repeat: z.number().int().min(1).max(5).optional(),
  }),
  risk: "read" as const,
  async execute(input: { text: string; repeat?: number }) {
    return { text: input.text.repeat(input.repeat ?? 1) };
  },
};

const ctx = { signal: new AbortController().signal, callId: "call_1" };

describe("zodToJsonSchema", () => {
  it("converts objects, optionality, defaults and constraints", () => {
    const json = zodToJsonSchema(
      z.object({
        path: z.string().min(1).describe("A path."),
        limit: z.number().int().min(1).max(50).optional().default(10),
        flag: z.boolean().optional(),
        mode: z.enum(["a", "b"]),
        tags: z.array(z.string()).optional(),
      }),
    );
    const properties = json["properties"] as Record<string, Record<string, unknown>>;
    expect(json["type"]).toBe("object");
    expect(properties["path"]).toMatchObject({ type: "string", minLength: 1, description: "A path." });
    expect(properties["limit"]).toMatchObject({ type: "integer", minimum: 1, maximum: 50, default: 10 });
    expect(properties["mode"]).toMatchObject({ type: "string", enum: ["a", "b"] });
    expect(properties["tags"]).toMatchObject({ type: "array", items: { type: "string" } });
    // Optional and defaulted fields are not required.
    expect(json["required"]).toEqual(["path", "mode"]);
  });
});

describe("ToolRegistry", () => {
  it("converts registrations into provider tool schemas", () => {
    const registry = new ToolRegistry().register(echoTool);
    const [schema] = registry.schemas();
    expect(schema?.name).toBe("echo_text");
    expect(schema?.parameters["type"]).toBe("object");
  });

  it("rejects duplicate and malformed tool names", () => {
    const registry = new ToolRegistry().register(echoTool);
    expect(() => registry.register(echoTool)).toThrowError(/already registered/);
    expect(() =>
      registry.register({ ...echoTool, name: "NotSnakeCase" }),
    ).toThrowError(/must be snake_case/);
  });

  it("validates input and returns structured errors", async () => {
    const registry = new ToolRegistry().register(echoTool);
    const missing = await registry.execute("echo_text", {}, ctx);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("E_TOOL_INPUT");
      expect(missing.error.toToolResult()).toContain("E_TOOL_INPUT");
    }

    const unknown = await registry.execute("nope", {}, ctx);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("E_TOOL_NOT_FOUND");
  });

  it("parses JSON-encoded arguments, as models sometimes emit", async () => {
    const registry = new ToolRegistry().register(echoTool);
    const result = await registry.execute("echo_text", '{"text":"hi","repeat":2}', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ text: "hihi" });
  });

  it("turns a thrown tool error into a structured failure", async () => {
    const registry = new ToolRegistry().register({
      ...echoTool,
      name: "boom_now",
      execute: async () => {
        throw new Error("disk on fire");
      },
    });
    const result = await registry.execute("boom_now", { text: "x" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TOOL_FAILED");
      expect(result.error.message).toBe("disk on fire");
    }
  });

  it("enforces the per-tool timeout", async () => {
    const registry = new ToolRegistry().register({
      ...echoTool,
      name: "slow_call",
      timeoutMs: 20,
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ text: "late" }), 200)),
    });
    const result = await registry.execute("slow_call", { text: "x" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/timed out after 20ms/);
  });

  it("aborts a running tool when the signal fires", async () => {
    const registry = new ToolRegistry().register({
      ...echoTool,
      name: "hangs_forever",
      timeoutMs: 5000,
      execute: () => new Promise(() => {}),
    });
    const controller = new AbortController();
    const pending = registry.execute("hangs_forever", { text: "x" }, {
      signal: controller.signal,
      callId: "call_x",
    });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_CANCELLED");
  });

  it("selects and filters tools", () => {
    const registry = new ToolRegistry()
      .register(echoTool)
      .register({ ...echoTool, name: "fs_read" })
      .register({ ...echoTool, name: "fs_write" });
    expect(registry.withPrefix("fs_").map((tool) => tool.name)).toEqual(["fs_read", "fs_write"]);
    expect(registry.schemas(["fs_write"]).map((schema) => schema.name)).toEqual(["fs_write"]);
    expect(registry.names()).toEqual(["echo_text", "fs_read", "fs_write"]);
  });
});
