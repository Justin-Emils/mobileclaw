/**
 * Scripted model transport for the in-app self-test.
 *
 * Purpose: let the whole agent pipeline run on a device with **no API key, no network and
 * no user input** -- which is what makes it possible to verify the parts that only appear
 * on a real run: the tool registry, the permission gate, the workspace assigned on a
 * conversation's first turn, the transcript entry, and the persistence that follows.
 *
 * It calls a tool rather than answering directly. A canned text reply would stream to the
 * transcript and skip every one of those.
 *
 * Lives here rather than in runtime-provider so `runtime.ts` can use it without importing
 * the provider (which imports the runtime - a cycle).
 */

/** One SSE chunk in the OpenAI wire format. */
function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** First turn: ask for `fs_list` on a path the demo filesystem actually has. */
function toolCallTurn(path: string): string {
  return (
    sse({ choices: [{ delta: { role: "assistant", content: "" } }] }) +
    sse({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_selftest", type: "function", function: { name: "fs_list", arguments: "" } },
            ],
          },
        },
      ],
    }) +
    // Arguments arrive fragmented, as a real provider sends them.
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }) +
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(path) } }] } }] }) +
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] }) +
    sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
    "data: [DONE]\n\n"
  );
}

/** Second turn: answer once the tool result is in the conversation. */
function answerTurn(): string {
  const answer = [
    "自检完成：已经真正调用过一次工具。",
    "",
    "| 环节 | 状态 |",
    "| :--- | :---: |",
    "| 工具调用 | 成功 |",
    "| 权限门 | 已通过 |",
    "| 会话记录 | 已保存 |",
    "",
    "**说明**：这条回答由脚本生成，不是真实模型。它能验证界面、工具链路与持久化，但内容是固定的。",
  ].join("\n");
  let out = sse({ choices: [{ delta: { role: "assistant", content: "" } }] });
  for (const part of answer.match(/[\s\S]{1,20}/g) ?? []) {
    out += sse({ choices: [{ delta: { content: part } }] });
  }
  return out + sse({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
}

export interface SelfTestTransport {
  fetch: typeof globalThis.fetch;
  /** True once a request arrived carrying a tool result. */
  sawToolResult: () => boolean;
}

/**
 * Build a transport that asks for a tool on the first request and answers on the second.
 *
 * Exposed as a small object so the caller can assert that the tool result actually came
 * back, rather than trusting that the loop completed.
 */
export function createSelfTestTransport(path = "/demo/Download"): SelfTestTransport {
  let toolResultSeen = false;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    let hasToolResult = false;
    try {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      hasToolResult = Array.isArray(body?.messages)
        ? body.messages.some((message: { role?: string }) => message.role === "tool")
        : false;
    } catch {
      hasToolResult = false;
    }
    if (hasToolResult) toolResultSeen = true;
    const script = toolResultSeen ? answerTurn() : toolCallTurn(path);
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(script));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, sawToolResult: () => toolResultSeen };
}
