/**
 * Minimal typed event bus, Cordis-style: events are a fixed map declared by the
 * host, listeners are registered per event name, and every listener may be async
 * so pre-flight work (approval prompts, logging, persistence) fits naturally.
 */
export type EventMap = { [event: string]: unknown[] };

export type EventListener<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/** Removes whatever a registration created. */
export type Disposable = () => void;

/**
 * Event contract for the core bus.
 *
 * Declared as a type alias on purpose: TypeScript gives type aliases an implicit
 * index signature (interfaces do not), which is what lets the host constraint
 * `extends EventMap` accept this map. Hosts that add events must extend it the
 * same way, e.g.
 *
 * ```ts
 * type AppEvents = DefaultEvents & { "run/finished": [id: string] };
 * ```
 */
export type DefaultEvents = {
  /** A plugin finished loading. */
  "plugin/loaded": [name: string];
  /** A plugin threw while loading; the host keeps running. */
  "plugin/error": [name: string, error: Error];
  /** A tool call is about to run (after permission approval). */
  "tool/call": [name: string, input: unknown];
  /** A tool call returned (or threw). */
  "tool/result": [name: string, result: unknown, durationMs: number];
  /** A diagnostic message worth surfacing in the UI. */
  log: [level: "debug" | "info" | "warn" | "error", message: string, details?: unknown];
};

export class EventBus<Events extends EventMap = DefaultEvents> {
  private readonly listeners = new Map<keyof Events, Set<EventListener<never[]>>>();

  on<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): Disposable {
    const set = this.listeners.get(event) ?? new Set<EventListener<never[]>>();
    set.add(listener as unknown as EventListener<never[]>);
    this.listeners.set(event, set);
    return () => {
      set.delete(listener as unknown as EventListener<never[]>);
    };
  }

  once<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): Disposable {
    const handle = (async (...args: Events[K]) => {
      dispose();
      await listener(...args);
    }) as EventListener<Events[K]>;
    const dispose = this.on(event, handle);
    return dispose;
  }

  /** Number of listeners for an event; used by diagnostics and tests. */
  count(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /**
   * Await every listener sequentially. A failing listener is reported through the
   * `log` channel and never breaks the emitter.
   */
  async emit<K extends keyof Events>(event: K, ...args: Events[K]): Promise<void> {
    await this.dispatch(event, args as unknown[]);
  }

  private async dispatch(event: keyof Events, args: unknown[]): Promise<void> {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        await (listener as unknown as (...inner: unknown[]) => void | Promise<void>)(...args);
      } catch (error) {
        const logEvent = "log" as unknown as keyof Events;
        if (event !== logEvent && this.listeners.has(logEvent)) {
          await this.dispatch(logEvent, [
            "error",
            `listener for "${String(event)}" threw`,
            error,
          ]);
        }
      }
    }
  }

  /** Remove every listener; used by tests and teardown. */
  clear(): void {
    this.listeners.clear();
  }
}
