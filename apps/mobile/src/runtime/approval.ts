import type { ApprovalHandler, PermissionRequest } from "@mobileclaw/core";

export interface PendingApproval {
  id: string;
  request: PermissionRequest;
  /** Human-facing title, e.g. `shell_run (execute)`. */
  title: string;
  detail: string;
  createdAt: number;
  resolve: (answer: { approved: boolean; remember?: boolean }) => void;
}

/**
 * Bridges the kernel's permission gate to the UI.
 *
 * The gate calls the handler and awaits a promise; the UI subscribes, renders a
 * modal, and resolves it. Keeping the queue here (rather than in a component)
 * means approvals survive hot reloads and can be inspected in tests.
 */
export class ApprovalBroker {
  private readonly queue: PendingApproval[] = [];
  private readonly listeners = new Set<() => void>();
  private counter = 0;

  /**
   * Bound form of {@link handle}, so `new ApprovalBroker()` itself satisfies the
   * kernel's `ApprovalHandler` signature.
   */
  readonly request: ApprovalHandler = (request) => this.handle(request);

  /** Auto-answer hook used by tests and by the "auto-approve in dev" toggle. */
  autoAnswer?: (request: PermissionRequest) => { approved: boolean; remember?: boolean } | undefined;

  /** The gate's approval callback: parks the run until the user answers. */
  async handle(request: PermissionRequest): Promise<{ approved: boolean; remember?: boolean }> {
    const preset = this.autoAnswer?.(request);
    if (preset) return preset;

    return new Promise<{ approved: boolean; remember?: boolean }>((resolve) => {
      const entry: PendingApproval = {
        id: `approval_${(this.counter += 1)}`,
        request,
        title: `${request.tool} (${request.risk})`,
        detail: describeRequest(request),
        createdAt: Date.now(),
        resolve,
      };
      this.queue.push(entry);
      this.notify();
    });
  }

  /** Called by the UI when the user answers the modal. */
  answer(id: string, answer: { approved: boolean; remember?: boolean }): void {
    const index = this.queue.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const [entry] = this.queue.splice(index, 1);
    entry?.resolve(answer);
    this.notify();
  }

  /** Grant or deny every waiting request at once (used on run cancellation). */
  flush(answer: { approved: boolean; remember?: boolean }): void {
    for (const entry of this.queue.splice(0)) entry.resolve(answer);
    this.notify();
  }

  pending(): PendingApproval[] {
    return [...this.queue];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** One-line summary shown in the approval sheet. */
export function describeRequest(request: PermissionRequest): string {
  if (request.summary) return request.summary;
  if (request.paths && request.paths.length > 0) return request.paths.join(", ");
  if (typeof request.input === "string") return request.input;
  try {
    return JSON.stringify(request.input ?? {});
  } catch {
    return String(request.input);
  }
}
