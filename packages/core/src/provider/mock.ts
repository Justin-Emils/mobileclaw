import { BaseProvider } from "./base";
import { CoreError } from "../errors";
import type { CompletionRequest, StreamEvent } from "../types";

/** One scripted assistant turn. */
export type ScriptedTurn =
  | string
  | {
      text?: string;
      reasoning?: string;
      toolCalls?: { id?: string; name: string; input?: unknown; argsDelta?: string }[];
      finishReason?: string;
      /** Throw this instead of responding, to exercise error paths. */
      error?: string;
      /** Delay between streamed chunks, for UI streaming tests. */
      chunkDelayMs?: number;
    };

export interface MockProviderOptions {
  id?: string;
  label?: string;
  model?: string;
  turns: ScriptedTurn[];
  /** Reuse the last turn when the script is exhausted (default false → error). */
  repeatLast?: boolean;
}

/**
 * Deterministic provider used by tests and by the app's "offline demo" mode.
 * Records every request so assertions can inspect the conversation the loop built.
 */
export class MockProvider extends BaseProvider {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly requests: CompletionRequest[] = [];
  private cursor = 0;

  constructor(private readonly options: MockProviderOptions) {
    super();
    this.id = options.id ?? "mock";
    this.label = options.label ?? "Mock provider";
    this.model = options.model ?? "mock-1";
  }

  get remaining(): number {
    return Math.max(0, this.options.turns.length - this.cursor);
  }

  push(turn: ScriptedTurn): void {
    this.options.turns.push(turn);
  }

  reset(): void {
    this.cursor = 0;
    this.requests.length = 0;
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const turn = this.pickTurn();
    if (typeof turn === "string") {
      yield* this.emitText(turn, request);
      return;
    }
    if (turn.error) throw new CoreError("E_PROVIDER", turn.error);
    if (turn.reasoning) yield { type: "reasoning", delta: turn.reasoning };
    if (turn.text) {
      yield* this.emitText(turn.text, request, turn.chunkDelayMs);
    }
    for (const [index, call] of (turn.toolCalls ?? []).entries()) {
      const id = call.id ?? `call_${index + 1}`;
      const args =
        call.argsDelta ??
        (typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}));
      // Emit the name first (as real providers do), then the argument fragments.
      yield { type: "tool_call", id, name: call.name, inputDelta: "" };
      yield { type: "tool_call", id, name: call.name, inputDelta: args };
    }
    yield { type: "usage", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
    yield { type: "done", finishReason: turn.finishReason ?? (turn.toolCalls?.length ? "tool_calls" : "stop") };
  }

  private async *emitText(
    text: string,
    request: CompletionRequest,
    delayMs = 0,
  ): AsyncIterable<StreamEvent> {
    const chunks = text.match(/[\s\S]{1,12}/g) ?? [];
    for (const chunk of chunks) {
      if (request.signal?.aborted) throw new CoreError("E_CANCELLED", "completion cancelled");
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield { type: "text", delta: chunk };
    }
  }

  private pickTurn(): ScriptedTurn {
    const turn = this.options.turns[this.cursor];
    if (turn === undefined) {
      if (this.options.repeatLast && this.options.turns.length > 0) {
        return this.options.turns[this.options.turns.length - 1]!;
      }
      throw new CoreError(
        "E_PROVIDER",
        `mock provider script exhausted after ${this.cursor} turn(s)`,
      );
    }
    this.cursor += 1;
    return turn;
  }
}
