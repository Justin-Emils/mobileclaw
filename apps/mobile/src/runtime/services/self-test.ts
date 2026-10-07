/**
 * Scripted model provider for the in-app self-test.
 *
 * Purpose: let the whole agent pipeline run on a device with **no API key, no network and
 * no user input** -- which is what makes it possible to verify the parts that only appear
 * on a real run: the tool registry, the permission gate, the workspace assigned on a
 * conversation's first turn, the transcript entry, and the persistence that follows.
 *
 * It asks for a tool rather than answering directly. A canned text reply would stream to
 * the transcript and skip every one of those.
 *
 * Why a provider and not a fake `fetch`: an earlier version scripted the HTTP layer, which
 * needs `response.body.getReader()`. A `ReadableStream` constructed in JS is not bridged to
 * `response.body` by React Native's global fetch -- the property comes back null and the
 * provider reports "provider returned an empty response body". Node's fetch does bridge it,
 * so the unit tests passed while the device failed. The SSE parsing that this gives up is
 * covered by the provider's own tests; what the self-test is for is the pipeline above it.
 */

import type { CompletionRequest, LlmProvider, StreamEvent } from "@mobileclaw/core";

/** First turn: ask for `fs_list` on the given path. */
function toolCallEvents(path: string): StreamEvent[] {
  // Every fragment repeats the id, because `StreamEvent` has no index and the agent keys
  // its accumulator on `event.id`. Fragments sent with an empty id opened a *second* call
  // whose name was empty, failing with `E_TOOL_NOT_FOUND unknown tool ""` -- visible on a
  // device, invisible in the unit tests, which is what made this worth spelling out.
  const id = "call_selftest";
  return [
    { type: "tool_call", id, name: "fs_list", inputDelta: "" },
    { type: "tool_call", id, name: "", inputDelta: '{"path":' },
    { type: "tool_call", id, name: "", inputDelta: JSON.stringify(path) },
    { type: "tool_call", id, name: "", inputDelta: "}" },
    { type: "done", finishReason: "tool_calls" },
  ];
}

/** Second turn: answer once the tool result is in the conversation. */
function answerEvents(): StreamEvent[] {
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
  const events: StreamEvent[] = [];
  for (const part of answer.match(/[\s\S]{1,20}/g) ?? []) {
    events.push({ type: "text", delta: part });
  }
  events.push({ type: "done", finishReason: "stop" });
  return events;
}

export interface SelfTestProvider extends LlmProvider {
  /** True once a request arrived carrying a tool result. */
  sawToolResult: () => boolean;
}

/**
 * Build the scripted provider.
 *
 * Whether a tool result is present is read from the messages the agent sends, so the second
 * turn only happens after a real tool result came back. If the tool never ran the flow
 * stalls exactly as it would with a real model, and the self-test reports that rather than
 * papering over it.
 */
export function createSelfTestProvider(path = "/demo/Download"): SelfTestProvider {
  let toolResultSeen = false;
  return {
    id: "selftest",
    label: "自检（脚本）",
    model: "selftest",
    sawToolResult: () => toolResultSeen,
    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const sawTool = request.messages.some((message) => message.role === "tool");
      if (sawTool) toolResultSeen = true;
      const events = sawTool ? answerEvents() : toolCallEvents(path);
      for (const event of events) {
        yield event;
      }
    },
    async complete(request: CompletionRequest) {
      let text = "";
      for await (const event of this.stream(request)) {
        if (event.type === "text") text += event.delta;
      }
      return { message: { role: "assistant" as const, content: text } };
    },
    async ping() {
      return { ok: true, message: "自检提供方（脚本，不联网）" };
    },
  };
}
