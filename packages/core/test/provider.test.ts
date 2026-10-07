import { describe, expect, it } from "vitest";
import { SseParser, toOpenAiMessage, OpenAiCompatibleProvider, type ChatMessage } from "@mobileclaw/core";

describe("SseParser", () => {
  it("reassembles events split across chunk boundaries", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    expect(parser.push(':1}\n\ndata: {"b":2}\n')).toEqual(['{"a":1}']);
    expect(parser.push("\n")).toEqual(['{"b":2}']);
  });

  it("handles [DONE] and multi-line data payloads", () => {
    const parser = new SseParser();
    const events = parser.push("data: line1\ndata: line2\n\ndata: [DONE]\n\n");
    expect(events).toEqual(["line1\nline2", "[DONE]"]);
  });

  it("flushes a trailing event without a blank line", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"x":1}')).toEqual([]);
    expect(parser.flush()).toEqual(['{"x":1}']);
    expect(parser.flush()).toEqual([]);
  });

  it("ignores comment-only keepalives", () => {
    const parser = new SseParser();
    expect(parser.push(": keepalive\n\n")).toEqual([]);
  });
});

describe("OpenAI wire format", () => {
  it("maps assistant tool calls and tool results", () => {
    const assistant: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "fs_read", input: { path: "/sdcard/a.txt" } }],
    };
    expect(toOpenAiMessage(assistant)).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "fs_read", arguments: '{"path":"/sdcard/a.txt"}' },
        },
      ],
    });

    expect(
      toOpenAiMessage({ role: "tool", content: "ok", toolCallId: "call_1", name: "fs_read" }),
    ).toEqual({ role: "tool", tool_call_id: "call_1", content: "ok" });

    expect(toOpenAiMessage({ role: "user", content: "hi" })).toEqual({ role: "user", content: "hi" });
  });
});

/** Build a fake streaming Response out of SSE text. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("OpenAiCompatibleProvider", () => {
  it("streams text and aggregates fragmented tool calls", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"fs_read","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/sdcard/x\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
      "data: [DONE]\n\n",
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => sseResponse(chunks)) as typeof globalThis.fetch;

    try {
      const provider = new OpenAiCompatibleProvider({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      const result = await provider.complete({
        model: "test-model",
        messages: [{ role: "user", content: "read it" }],
      });
      expect(result.message.content).toBe("Hello");
      expect(result.message.toolCalls).toEqual([
        { id: "call_9", name: "fs_read", input: { path: "/sdcard/x" } },
      ]);
      expect(result.usage?.totalTokens).toBe(10);
      expect(result.finishReason).toBe("tool_calls");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses to call without an API key", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "",
      model: "m",
    });
    await expect(
      provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrowError(/no API key configured/);
  });

  it("reports HTTP failures with the response body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error":"bad key"}', { status: 401 })) as typeof globalThis.fetch;
    try {
      const provider = new OpenAiCompatibleProvider({
        baseUrl: "https://api.example.com/v1",
        apiKey: "k",
        model: "m",
      });
      await expect(
        provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrowError(/HTTP 401/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads configuration from the environment", () => {
    const provider = OpenAiCompatibleProvider.fromEnv({
      MOBILECLAW_API_KEY: "env-key",
      MOBILECLAW_BASE_URL: "https://api.deepseek.com/v1",
      MOBILECLAW_MODEL: "deepseek-chat",
    });
    expect(provider.model).toBe("deepseek-chat");
    expect(provider.label).toContain("api.deepseek.com");
  });
});
