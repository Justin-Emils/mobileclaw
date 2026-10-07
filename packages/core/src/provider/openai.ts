import { CoreError, safeStringify } from "../errors";
import { BaseProvider, SseParser } from "./base";
import type { ChatMessage, CompletionRequest, HttpService, StreamEvent } from "../types";

export interface OpenAiCompatibleOptions {
  /** e.g. https://api.deepseek.com/v1 or https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  id?: string;
  label?: string;
  /** Extra headers, e.g. for gateways that want `HTTP-Referer`. */
  headers?: Record<string, string>;
  /** Injectable transport; defaults to the platform HTTP service or global fetch. */
  http?: HttpService;
  /**
   * Injectable `fetch`. This is the seam used by tests and by hosts that need a
   * custom transport (proxying, certificate pinning, `expo/fetch` streaming)
   * while still exercising the real request/response mapping below.
   */
  fetchImpl?: typeof globalThis.fetch;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Ask the server to include token usage in the stream. */
  includeUsage?: boolean;
}

/**
 * Works with any OpenAI-compatible `/chat/completions` endpoint: OpenAI,
 * DeepSeek, Moonshot, OpenRouter, Ollama, vLLM, LM Studio, ...
 */
export class OpenAiCompatibleProvider extends BaseProvider {
  readonly id: string;
  readonly label: string;
  readonly model: string;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    super();
    this.model = options.model;
    this.id = options.id ?? "openai-compatible";
    this.label = options.label ?? `OpenAI-compatible (${hostOf(options.baseUrl)})`;
  }

  static fromEnv(
    env: Record<string, string | undefined>,
    options: Partial<OpenAiCompatibleOptions> = {},
  ): OpenAiCompatibleProvider {
    const apiKey = options.apiKey ?? env["MOBILECLAW_API_KEY"] ?? "";
    const baseUrl = options.baseUrl ?? env["MOBILECLAW_BASE_URL"] ?? "https://api.deepseek.com/v1";
    const model = options.model ?? env["MOBILECLAW_MODEL"] ?? "deepseek-chat";
    return new OpenAiCompatibleProvider({ ...options, apiKey, baseUrl, model });
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    if (!this.options.apiKey) {
      throw new CoreError("E_PROVIDER", "no API key configured for the model provider");
    }
    const body = {
      model: request.model || this.model,
      messages: request.messages.map(toOpenAiMessage),
      stream: true,
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: "auto",
          }
        : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(this.options.includeUsage === false ? {} : { stream_options: { include_usage: true } }),
    };

    const response = await this.send(body, request.signal);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new CoreError("E_PROVIDER", `provider returned HTTP ${response.status}`, {
        body: truncate(detail, 800),
      });
    }
    if (!response.body) {
      throw new CoreError("E_PROVIDER", "provider returned an empty response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    /** Accumulate tool call fragments by index, as OpenAI streams them. */
    const pending = new Map<number, { id: string; name: string; args: string; announced: boolean }>();
    /** Set once the provider sends its `[DONE]` sentinel. */
    let sawDone = false;

    const consume = (payload: string): StreamEvent[] => {
      if (payload === "[DONE]") {
        sawDone = true;
        return [{ type: "done" }];
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return [];
      }
      return this.translate(parsed, pending);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          for (const event of consume(payload)) yield event;
        }
      }
      for (const payload of parser.flush()) {
        for (const event of consume(payload)) yield event;
      }
      // Some servers close without emitting [DONE]; make sure consumers finish.
      if (!sawDone) yield { type: "done" };
    } finally {
      reader.releaseLock?.();
    }
  }

  /** Map one provider chunk onto our stream events. */
  private translate(
    chunk: Record<string, unknown>,
    pending: Map<number, { id: string; name: string; args: string; announced: boolean }>,
  ): StreamEvent[] {
    const events: StreamEvent[] = [];
    const errorField = chunk["error"];
    if (errorField) {
      throw new CoreError("E_PROVIDER", "provider reported an error", errorField);
    }
    const usage = chunk["usage"] as Record<string, number> | undefined;
    if (usage) {
      events.push({
        type: "usage",
        usage: {
          promptTokens: usage["prompt_tokens"],
          completionTokens: usage["completion_tokens"],
          totalTokens: usage["total_tokens"],
        },
      });
    }

    const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) return events;

    for (const choice of choices) {
      const delta = (choice["delta"] ?? {}) as Record<string, unknown>;
      const content = delta["content"];
      if (typeof content === "string" && content !== "") {
        events.push({ type: "text", delta: content });
      }
      const reasoning = delta["reasoning_content"] ?? delta["reasoning"];
      if (typeof reasoning === "string" && reasoning !== "") {
        events.push({ type: "reasoning", delta: reasoning });
      }

      const toolCalls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
      for (const call of toolCalls ?? []) {
        const index = typeof call["index"] === "number" ? (call["index"] as number) : 0;
        const fn = (call["function"] ?? {}) as Record<string, unknown>;
        const entry =
          pending.get(index) ??
          { id: String(call["id"] ?? `call_${index}`), name: "", args: "", announced: false };
        if (typeof call["id"] === "string" && call["id"] !== "") entry.id = call["id"];
        if (typeof fn["name"] === "string" && fn["name"] !== "") entry.name = fn["name"];
        const argsDelta = typeof fn["arguments"] === "string" ? fn["arguments"] : "";
        entry.args += argsDelta;
        pending.set(index, entry);
        events.push({
          type: "tool_call",
          id: entry.id,
          name: entry.name,
          inputDelta: argsDelta,
        });
        entry.announced = true;
      }

      const finish = choice["finish_reason"];
      if (typeof finish === "string" && finish !== "" && finish !== "null") {
        events.push({ type: "done", finishReason: finish });
      }
    }
    return events;
  }

  private async send(body: unknown, signal?: AbortSignal): Promise<Response> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${this.options.apiKey}`,
      ...this.options.headers,
    };
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const globalFetch = this.options.fetchImpl ?? (globalThis as { fetch?: typeof globalThis.fetch }).fetch;
      if (globalFetch) {
        const response = await globalFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        return response;
      }
      if (this.options.http) {
        // Fallback transport for runtimes without fetch (older RN engines).
        const text = JSON.stringify(body);
        const response = await this.options.http.fetch({ url, method: "POST", headers, body: text });
        return sseResponseFromText(response.body);
      }
      throw new CoreError("E_PROVIDER", "this runtime has neither fetch nor an HttpService");
    } catch (error) {
      if (signal?.aborted) throw new CoreError("E_CANCELLED", "completion cancelled");
      if (error instanceof CoreError) throw error;
      throw new CoreError("E_PROVIDER", error instanceof Error ? error.message : String(error), {
        url,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function sseResponseFromText(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Convert our message model into the wire format. */
export function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "unknown",
      content: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content === "" ? null : message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments:
            typeof call.input === "string" ? call.input : safeStringify(call.input ?? {}),
        },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
