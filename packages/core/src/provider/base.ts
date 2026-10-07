import type { ChatMessage, CompletionResult, LlmProvider, StreamEvent } from "../types";

/**
 * Shared plumbing for providers: turn a stream into a single message, and expose
 * a sane default `ping`. Concrete providers only implement `stream`.
 */
export abstract class BaseProvider implements LlmProvider {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly model: string;
  abstract stream(request: Parameters<LlmProvider["stream"]>[0]): AsyncIterable<StreamEvent>;

  async complete(request: Parameters<LlmProvider["stream"]>[0]): Promise<CompletionResult> {
    let text = "";
    let reasoning = "";
    let finishReason: string | undefined;
    let usage: CompletionResult["usage"];
    const calls = new Map<string, { name: string; input: string; order: number }>();
    let order = 0;

    for await (const event of this.stream(request)) {
      switch (event.type) {
        case "text":
          text += event.delta;
          break;
        case "reasoning":
          reasoning += event.delta;
          break;
        case "tool_call": {
          const existing = calls.get(event.id);
          if (existing) {
            existing.input += event.inputDelta;
            if (event.name) existing.name = event.name;
          } else {
            calls.set(event.id, { name: event.name, input: event.inputDelta, order: order++ });
          }
          break;
        }
        case "usage":
          usage = { ...usage, ...event.usage };
          break;
        case "done":
          // Keep the first reason: a later bare `done` (the end-of-stream
          // sentinel) must not erase what the provider actually reported.
          finishReason ??= event.finishReason;
          break;
      }
    }

    const message: ChatMessage = { role: "assistant", content: text, at: Date.now() };
    if (calls.size > 0) {
      message.toolCalls = [...calls.entries()]
        .sort((a, b) => a[1].order - b[1].order)
        .map(([id, call]) => ({ id, name: call.name, input: parseMaybeJson(call.input) }));
      if (message.content === "" && reasoning !== "") message.content = reasoning;
    }
    return {
      message,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
    };
  }

  async ping(signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    try {
      const result = await this.complete({
        model: this.model,
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 8,
        ...(signal ? { signal } : {}),
      });
      return { ok: true, message: `connected to ${this.model} (${result.message.content.length} chars)` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function parseMaybeJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

/**
 * Incremental Server-Sent Events parser. Chunk boundaries can split an event, so
 * we buffer until a blank line and hand over complete `data:` payloads.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    let index = this.buffer.indexOf("\n\n");
    while (index !== -1) {
      const rawEvent = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const data = extractData(rawEvent);
      if (data !== undefined) events.push(data);
      index = this.buffer.indexOf("\n\n");
    }
    return events;
  }

  /** Flush a trailing event that never got its blank-line terminator. */
  flush(): string[] {
    const remaining = this.buffer.trim();
    this.buffer = "";
    if (remaining === "") return [];
    const data = extractData(remaining);
    return data === undefined ? [] : [data];
  }
}

function extractData(rawEvent: string): string | undefined {
  const lines = rawEvent.split(/\r?\n/);
  const parts: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) parts.push(line.slice(5).replace(/^ /, ""));
  }
  if (parts.length === 0) return undefined;
  return parts.join("\n");
}
