import { CoreError } from "./errors.js";
import { EventBus, type DefaultEvents, type Disposable, type EventMap } from "./events.js";

/**
 * Service registry contract. Packages extend this interface through TypeScript
 * declaration merging so `ctx.get("fs")` is fully typed without casts:
 *
 * ```ts
 * declare module "@mobileclaw/core" {
 *   interface Services { myService: MyService }
 * }
 * ```
 */
export interface Services {
  [name: string]: unknown;
}

/** Per-plugin key/value bucket passed to every plugin invocation. */
export class PluginStore {
  private readonly data = new Map<string, unknown>();

  constructor(private readonly owner: string) {}

  get<T>(key: string, fallback?: T): T | undefined {
    return this.data.has(key) ? (this.data.get(key) as T) : fallback;
  }

  set<T>(key: string, value: T): T {
    this.data.set(key, value);
    return value;
  }

  delete(key: string): boolean {
    return this.data.delete(key);
  }

  keys(): string[] {
    return [...this.data.keys()];
  }

  /** Namespaced so plugins never collide in a shared persistence layer. */
  scope(key: string): string {
    return `${this.owner}:${key}`;
  }
}

export interface Logger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export interface ContextOptions<Events extends EventMap = DefaultEvents> {
  events?: EventBus<Events>;
  /** Label used in diagnostics, usually the plugin name. */
  label?: string;
}

/**
 * The plugin host context. Deliberately small: a service container, a typed
 * event bus, a logger and per-plugin state. Everything else is a plugin.
 */
export class Context<Events extends EventMap = DefaultEvents> {
  readonly events: EventBus<Events>;
  readonly logger: Logger;
  readonly store: PluginStore;
  readonly label: string;
  readonly parent?: Context<Events>;

  private readonly localServices = new Map<string, unknown>();
  private readonly disposers: Disposable[] = [];
  private readonly injected = new Set<string>();
  private readonly children: Context<Events>[] = [];

  constructor(options: ContextOptions<Events> = {}) {
    this.parent = undefined;
    this.label = options.label ?? "root";
    this.events = options.events ?? new EventBus<Events>();
    this.store = new PluginStore(this.label);
    this.logger = {
      debug: (message, details) => writeLog(this.label, "debug", message, details),
      info: (message, details) => writeLog(this.label, "info", message, details),
      warn: (message, details) => writeLog(this.label, "warn", message, details),
      error: (message, details) => writeLog(this.label, "error", message, details),
    };
  }

  /** Register (or replace) a service in this context, returning the previous value. */
  provide<K extends keyof Services & string>(name: K, value: Services[K]): unknown {
    const previous = this.localServices.get(name);
    this.localServices.set(name, value);
    return previous;
  }

  provideAll(map: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(map)) this.provide(name, value);
  }

  /** True when the service exists here or in an ancestor context. */
  has(name: string): boolean {
    return this.localServices.has(name) || (this.parent?.has(name) ?? false);
  }

  /**
   * Resolve a service. A missing capability throws a structured error instead of
   * returning undefined, so the model receives an actionable message.
   */
  get<K extends keyof Services & string>(name: K): Services[K] {
    const found = this.lookup(name);
    if (found === undefined) {
      const available = this.localServices.size > 0 ? [...this.localServices.keys()] : [];
      throw new CoreError(
        "E_SERVICE_MISSING",
        `service "${name}" is not available; the plugin providing it is missing or failed to load`,
        { available },
      );
    }
    return found as Services[K];
  }

  /** Resolve a service or return undefined. */
  tryGet<K extends keyof Services & string>(name: K): Services[K] | undefined {
    return this.lookup(name) as Services[K] | undefined;
  }

  private lookup(name: string): unknown {
    if (this.localServices.has(name)) return this.localServices.get(name);
    return this.parent?.lookup(name);
  }

  /** Declare a dependency, satisfying the plugin's `inject` list. */
  inject(names: string | string[]): this {
    const list = Array.isArray(names) ? names : [names];
    for (const dependency of list) this.injected.add(dependency);
    return this;
  }

  /** Dependencies declared with `inject` that are still unresolved. */
  missingInjections(): string[] {
    return [...this.injected].filter((name) => !this.has(name));
  }

  /** Register a teardown callback, run by `dispose()`. */
  onDispose(disposer: Disposable): Disposable {
    this.disposers.push(disposer);
    return () => {
      const index = this.disposers.indexOf(disposer);
      if (index >= 0) this.disposers.splice(index, 1);
    };
  }

  /** Create a child context sharing the event bus but owning its own services. */
  extend(label: string): Context<Events> {
    const child = new Context<Events>({ events: this.events, label });
    // `parent` is readonly in the public shape, so assign through a narrow cast.
    (child as { parent?: Context<Events> }).parent = this;
    this.children.push(child);
    return child;
  }

  async dispose(): Promise<void> {
    for (const child of this.children.splice(0)) await child.dispose();
    for (const disposer of this.disposers.splice(0).reverse()) {
      try {
        disposer();
      } catch (error) {
        writeLog(this.label, "error", "a disposer threw", error);
      }
    }
    this.localServices.clear();
  }
}

/** Overridable sink so the host can route kernel logs into the app's logger. */
let logSink: (entry: { label: string; level: string; message: string; details?: unknown }) => void =
  (entry) => {
    const enabled = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.["MOBILECLAW_DEBUG"];
    if (enabled) {
      // eslint-disable-next-line no-console
      console.debug(`${entry.level.toUpperCase()} [${entry.label}] ${entry.message}`, entry.details ?? "");
    }
  };

export function setLogSink(
  sink: (entry: { label: string; level: string; message: string; details?: unknown }) => void,
): void {
  logSink = sink;
}

function writeLog(label: string, level: string, message: string, details?: unknown): void {
  logSink(details === undefined ? { label, level, message } : { label, level, message, details });
}
