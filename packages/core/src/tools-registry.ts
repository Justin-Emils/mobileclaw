import { z } from "zod";
import { CoreError, safeStringify, toCoreError } from "./errors.js";
import type { AnyToolDefinition, ToolCallContext, ToolDefinition, ToolSchema } from "./tool.js";

/**
 * Holds the tools every plugin contributed and turns them into the JSON Schema
 * shape providers expect. Duplicate names are rejected: silently overwriting a
 * tool would make the agent behave differently depending on plugin order.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register(tool: AnyToolDefinition): this {
    if (this.tools.has(tool.name)) {
      throw new CoreError("E_PLUGIN", `tool "${tool.name}" is already registered`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new CoreError(
        "E_PLUGIN",
        `tool name "${tool.name}" must be snake_case starting with a letter`,
      );
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: readonly AnyToolDefinition[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): AnyToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new CoreError("E_TOOL_NOT_FOUND", `unknown tool "${name}"`, {
        available: this.names(),
      });
    }
    return tool;
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Filter by prefix, e.g. everything under `fs_`. */
  withPrefix(prefix: string): AnyToolDefinition[] {
    return this.list().filter((tool) => tool.name.startsWith(prefix));
  }

  select(names: readonly string[]): AnyToolDefinition[] {
    const wanted = new Set(names);
    return this.list().filter((tool) => wanted.has(tool.name));
  }

  /** JSON Schema for the provider, using Zod's native JSON Schema converter. */
  schemas(selection?: readonly string[]): ToolSchema[] {
    return (selection ? this.select(selection) : this.list()).map((tool) =>
      toToolSchema(tool),
    );
  }

  /**
   * Validate input, run the tool, and validate output. Failures are returned as
   * structured CoreErrors so the agent loop can hand them back to the model.
   */
  async execute(
    name: string,
    rawInput: unknown,
    ctx: ToolCallContext,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: CoreError }> {
    let tool: AnyToolDefinition;
    try {
      tool = this.get(name);
    } catch (error) {
      return { ok: false, error: toCoreError(error, "E_TOOL_NOT_FOUND") };
    }

    let input: unknown;
    try {
      const parsed = tool.input.safeParse(normalizeInput(rawInput));
      if (!parsed.success) {
        return {
          ok: false,
          error: new CoreError("E_TOOL_INPUT", `invalid input for "${name}"`, {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          }),
        };
      }
      input = parsed.data;
    } catch (error) {
      return { ok: false, error: toCoreError(error, "E_TOOL_INPUT") };
    }

    const timeoutMs = tool.timeoutMs ?? 60_000;
    try {
      const value = await withTimeout(
        Promise.resolve(tool.execute(input as never, ctx)),
        timeoutMs,
        ctx.signal,
        name,
      );
      if (tool.output) {
        const parsed = tool.output.safeParse(value);
        if (!parsed.success) {
          return {
            ok: false,
            error: new CoreError("E_TOOL_FAILED", `tool "${name}" returned invalid output`, {
              issues: parsed.error.issues.map((issue) => issue.message),
            }),
          };
        }
        return { ok: true, value: parsed.data };
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: toCoreError(error, "E_TOOL_FAILED") };
    }
  }

  clear(): void {
    this.tools.clear();
  }
}

export function toToolSchema(tool: AnyToolDefinition): ToolSchema {
  let parameters: Record<string, unknown>;
  try {
    parameters = zodToJsonSchema(tool.input);
  } catch {
    parameters = { type: "object", additionalProperties: true };
  }
  return { name: tool.name, description: tool.description, parameters };
}

/**
 * Structural Zod → JSON Schema conversion.
 *
 * Deliberately hand-written instead of depending on a converter API: the agent's
 * contract with the model must not shift when a Zod major version changes how it
 * emits schemas. Unknown node types degrade to a permissive schema, because a
 * slightly loose tool schema is far better than a tool the model cannot call.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny, seen = new Set<unknown>()): Record<string, unknown> {
  if (seen.has(schema)) return {};
  seen.add(schema);
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def ?? {};
  const typeName = String(def["typeName"] ?? "");
  const description = (schema as unknown as { description?: string }).description ?? def["description"];

  const withMeta = (json: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...json };
    if (typeof description === "string" && description !== "") out["description"] = description;
    if (typeof def["defaultValue"] === "function") {
      try {
        out["default"] = (def["defaultValue"] as () => unknown)();
      } catch {
        // Defaults are a hint, never a hard requirement.
      }
    }
    return out;
  };

  switch (typeName) {
    case "ZodObject": {
      const shape = (
        typeof def["shape"] === "function" ? (def["shape"] as () => Record<string, z.ZodTypeAny>)() : {}
      ) as Record<string, z.ZodTypeAny>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value, seen);
        if (!isOptional(value, seen)) required.push(key);
      }
      return withMeta({
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      });
    }
    case "ZodArray": {
      const inner = def["type"] as z.ZodTypeAny | undefined;
      const json = withMeta({
        type: "array",
        items: inner ? zodToJsonSchema(inner, seen) : {},
      });
      const minLength = def["minLength"];
      const maxLength = def["maxLength"];
      if (typeof minLength === "number") json["minItems"] = minLength;
      if (typeof maxLength === "number") json["maxItems"] = maxLength;
      return json;
    }
    case "ZodString": {
      const json: Record<string, unknown> = withMeta({ type: "string" });
      const checks = (def["checks"] as { kind: string; value?: number; regex?: RegExp }[] | undefined) ?? [];
      for (const check of checks) {
        if (check.kind === "min") json["minLength"] = check.value;
        if (check.kind === "max") json["maxLength"] = check.value;
        if (check.kind === "url") json["format"] = "uri";
        if (check.kind === "email") json["format"] = "email";
        if (check.kind === "regex" && check.regex) json["pattern"] = check.regex.source;
      }
      return json;
    }
    case "ZodNumber": {
      const json: Record<string, unknown> = withMeta({ type: "number" });
      const checks = (def["checks"] as { kind: string; value?: number }[] | undefined) ?? [];
      for (const check of checks) {
        if (check.kind === "int") json["type"] = "integer";
        if (check.kind === "min") json["minimum"] = check.value;
        if (check.kind === "max") json["maximum"] = check.value;
      }
      return json;
    }
    case "ZodBoolean":
      return withMeta({ type: "boolean" });
    case "ZodEnum": {
      const values = (def["values"] as unknown[] | undefined) ?? [];
      return withMeta({ type: "string", enum: values });
    }
    case "ZodNativeEnum": {
      const values = (def["values"] as unknown[] | undefined) ?? [];
      return withMeta({ enum: values });
    }
    case "ZodLiteral":
      return withMeta({ const: def["value"] });
    case "ZodRecord": {
      const valueType = def["valueType"] as z.ZodTypeAny | undefined;
      return withMeta({
        type: "object",
        ...(valueType ? { additionalProperties: zodToJsonSchema(valueType, seen) } : { additionalProperties: true }),
      });
    }
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodReadonly":
    case "ZodCatch": {
      const inner = (def["innerType"] ?? def["type"]) as z.ZodTypeAny | undefined;
      const json = inner ? zodToJsonSchema(inner, seen) : {};
      if (typeName === "ZodNullable") {
        return withMeta({ anyOf: [json, { type: "null" }] });
      }
      return withMeta(json);
    }
    case "ZodEffects": {
      const inner = def["schema"] as z.ZodTypeAny | undefined;
      return withMeta(inner ? zodToJsonSchema(inner, seen) : {});
    }
    case "ZodUnion": {
      const options = def["options"] as z.ZodTypeAny[] | undefined;
      return withMeta({ anyOf: (options ?? []).map((option) => zodToJsonSchema(option, seen)) });
    }
    case "ZodDiscriminatedUnion": {
      const options = [...(((def["optionsMap"] as Map<string, z.ZodTypeAny>) ?? new Map()).values())];
      return withMeta({ anyOf: options.map((option) => zodToJsonSchema(option, seen)) });
    }
    case "ZodTuple": {
      const items = (def["items"] as z.ZodTypeAny[] | undefined) ?? [];
      return withMeta({ type: "array", items: items.map((item) => zodToJsonSchema(item, seen)) });
    }
    case "ZodAny":
    case "ZodUnknown":
      return withMeta({});
    case "ZodNull":
      return withMeta({ type: "null" });
    case "ZodVoid":
    case "ZodUndefined":
      return withMeta({});
    default:
      return {};
  }
}

/** A field is optional when its wrapper chain contains optional/default/catch. */
function isOptional(schema: z.ZodTypeAny, seen: Set<unknown>): boolean {
  let current: z.ZodTypeAny | undefined = schema;
  let depth = 0;
  while (current && depth < 8) {
    const def = (current as unknown as { _def?: Record<string, unknown> })._def ?? {};
    const typeName = String(def["typeName"] ?? "");
    if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodCatch") return true;
    if (typeName === "ZodEffects" || typeName === "ZodReadonly") {
      current = def["schema"] as z.ZodTypeAny | undefined;
      depth += 1;
      continue;
    }
    return false;
  }
  void seen;
  return false;
}


/**
 * Providers feed models loosely typed JSON, so tolerate a JSON-encoded string
 * (common when a model double-encodes its arguments) before validation.
 */
export function normalizeInput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "null") return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

/** Execute with a hard timeout and abort-signal awareness. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  name: string,
): Promise<T> {
  if (signal.aborted) throw new CoreError("E_CANCELLED", `tool "${name}" was cancelled`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new CoreError("E_TOOL_FAILED", `tool "${name}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        onAbort = () => reject(new CoreError("E_CANCELLED", `tool "${name}" was cancelled`));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Human-readable summary helper shared by plugins. */
export function describeInput(tool: ToolDefinition, input: unknown): string {
  if (tool.summarize) {
    try {
      return tool.summarize(input as never);
    } catch {
      return "";
    }
  }
  return safeStringify(input);
}
