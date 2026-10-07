import type { AgentEvent } from "@mobileclaw/core";

/**
 * Push→pull bridge for the agent loop.
 *
 * The agent emits events synchronously from inside its own `await` chain, while
 * React consumes them from an async generator. Without this buffer the UI would
 * only see events after the whole run finished, which defeats streaming.
 *
 * A single waiter is enough because exactly one consumer drains the queue.
 */
export class AsyncEventQueue {
  private readonly items: AgentEvent[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;

  /** Called by the agent observer. Events after `close()` are dropped. */
  push(event: AgentEvent): void {
    if (this.closed) return;
    this.items.push(event);
    this.wake();
  }

  /** Resolves with the next event, or `undefined` once the run has ended. */
  async shift(): Promise<AgentEvent | undefined> {
    while (this.items.length === 0) {
      if (this.closed) return undefined;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    return this.items.shift();
  }

  /** Signals end-of-stream and releases a blocked `shift()`. */
  close(): void {
    this.closed = true;
    this.wake();
  }

  get size(): number {
    return this.items.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Resolves once a consumer is parked in `shift()`. Tests (and a UI that needs
   * to know rendering has caught up) use this instead of guessing at tick counts.
   */
  async waitForConsumer(): Promise<void> {
    while (this.waiter === undefined && !this.closed) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }
}
