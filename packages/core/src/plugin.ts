import type { Context } from "./context.js";
import { CoreError, isCoreError, toCoreError } from "./errors.js";
import type { ToolRegistry } from "./tools-registry.js";
import type { AnyToolDefinition } from "./tool.js";

/**
 * A plugin is a plain function plus optional metadata. This mirrors the Cordis
 * model: plugins receive the host context and register services, tools and
 * event listeners on it.
 */
export interface PluginMetadata {
  name: string;
  /** Human description shown in the in-app plugin list. */
  description?: string;
  version?: string;
  /** Capabilities that must exist before `apply` runs. */
  inject?: string[];
  /** Tools are re-registered on reload, so a plugin can be toggled at runtime. */
  tools?: AnyToolDefinition[];
  /** Marks plugins that ship with the app and cannot be uninstalled. */
  core?: boolean;
}

export type PluginApply = (ctx: Context, options?: never) => void | Promise<void>;

export type Plugin = PluginMetadata & { apply: PluginApply };

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

export interface LoadedPlugin extends PluginMetadata {
  status: "loaded" | "error" | "pending";
  error?: CoreError;
  /** Names registered by this plugin, for precise unloading. */
  toolNames: string[];
  loadedAt?: number;
}

/**
 * Loads plugins into a context and exposes the resulting capability inventory.
 * A failing plugin is contained: it is reported and skipped so one broken
 * capability never takes down the agent.
 */
export class PluginHost {
  private readonly loaded = new Map<string, LoadedPlugin>();

  constructor(
    private readonly ctx: Context,
    private readonly registry: ToolRegistry,
  ) {}

  async load(plugin: Plugin): Promise<LoadedPlugin> {
    const existing = this.loaded.get(plugin.name);
    if (existing?.status === "loaded") return existing;

    const entry: LoadedPlugin = {
      ...plugin,
      status: "pending",
      toolNames: [],
    };
    this.loaded.set(plugin.name, entry);

    const missing = (plugin.inject ?? []).filter((name) => !this.ctx.has(name));
    if (missing.length > 0) {
      const error = new CoreError(
        "E_SERVICE_MISSING",
        `plugin "${plugin.name}" requires services that are not registered: ${missing.join(", ")}`,
      );
      entry.status = "error";
      entry.error = error;
      await this.ctx.events.emit("plugin/error", plugin.name, error);
      return entry;
    }

    const child = this.ctx.extend(plugin.name);
    child.inject(plugin.inject ?? []);
    // Ask the child context so an ancestor-provided service also counts.
    const unresolved = child.missingInjections();
    if (unresolved.length > 0) {
      const error = new CoreError(
        "E_SERVICE_MISSING",
        `plugin "${plugin.name}" requires services that are not registered: ${unresolved.join(", ")}`,
      );
      entry.status = "error";
      entry.error = error;
      await this.ctx.events.emit("plugin/error", plugin.name, error);
      return entry;
    }
    const registered: string[] = [];
    try {
      // Tools declared as metadata are registered before apply so a plugin can
      // reference them (e.g. to build a dispatch table).
      for (const tool of plugin.tools ?? []) {
        this.registry.register(tool);
        registered.push(tool.name);
      }
      await plugin.apply(child);
      entry.status = "loaded";
      entry.loadedAt = Date.now();
      entry.toolNames = registered;
      await this.ctx.events.emit("plugin/loaded", plugin.name);
    } catch (error) {
      // Roll back partial registration so the inventory stays truthful.
      for (const name of registered) this.unregisterTool(name);
      const coreError = toCoreError(error, "E_PLUGIN");
      entry.status = "error";
      entry.error = coreError;
      entry.toolNames = [];
      await this.ctx.events.emit("plugin/error", plugin.name, coreError);
    }
    return entry;
  }

  async loadAll(plugins: readonly Plugin[]): Promise<LoadedPlugin[]> {
    const results: LoadedPlugin[] = [];
    for (const plugin of plugins) results.push(await this.load(plugin));
    return results;
  }

  list(): LoadedPlugin[] {
    return [...this.loaded.values()].map((entry) => ({ ...entry }));
  }

  get(name: string): LoadedPlugin | undefined {
    const entry = this.loaded.get(name);
    return entry ? { ...entry } : undefined;
  }

  has(name: string): boolean {
    return this.loaded.get(name)?.status === "loaded";
  }

  /** Plugin errors, for a diagnostics screen. */
  failures(): LoadedPlugin[] {
    return this.list().filter((entry) => entry.status === "error");
  }

  private unregisterTool(name: string): void {
    const registry = this.registry as unknown as { tools?: Map<string, unknown> };
    registry.tools?.delete(name);
  }
}

export function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Plugin).name === "string" &&
    typeof (value as Plugin).apply === "function"
  );
}

export { isCoreError };
