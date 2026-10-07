import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@mobileclaw/core";
import { titleFromConversation, toBubbles } from "@/ui/conversation-view";

/**
 * Restoring a conversation is the difference between "history works" and "the app
 * forgot my work again", and the failure modes are quiet: a duplicated tool row or a
 * dropped assistant turn is easy to miss by eye.
 */

function message(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

describe("toBubbles", () => {
  it("keeps user and assistant prose in order", () => {
    const bubbles = toBubbles([
      message("system", "you are a helper"),
      message("user", "整理下载目录"),
      message("assistant", "好的，我先看看。"),
    ]);
    expect(bubbles.map((b) => b.role)).toEqual(["user", "assistant"]);
    expect(bubbles[0]?.text).toBe("整理下载目录");
  });

  it("drops tool messages, which the tool cards already render", () => {
    // Replaying these as bubbles showed every tool call twice.
    const bubbles = toBubbles([
      message("user", "list it"),
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "fs_list", input: {} }] },
      { role: "tool", content: "3 entries", toolCallId: "1" },
      message("assistant", "3 个条目。"),
    ]);
    expect(bubbles.map((b) => b.text)).toEqual(["list it", "3 个条目。"]);
  });

  it("skips an assistant turn that only requested tools", () => {
    const bubbles = toBubbles([
      message("user", "go"),
      { role: "assistant", content: "  ", toolCalls: [{ id: "1", name: "fs_list", input: {} }] },
    ]);
    expect(bubbles).toHaveLength(1);
  });

  it("produces stable ids so re-hydration does not remount rows", () => {
    const messages = [message("user", "hi"), message("assistant", "hello")];
    expect(toBubbles(messages).map((b) => b.id)).toEqual(toBubbles(messages).map((b) => b.id));
  });

  it("returns an empty transcript for an empty conversation", () => {
    expect(toBubbles([])).toEqual([]);
  });
});

describe("titleFromConversation", () => {
  it("uses the first user message", () => {
    expect(titleFromConversation([message("assistant", "hi"), message("user", "  找大文件  ")], "x")).toBe("找大文件");
  });

  it("truncates a long opening message instead of wrapping the list", () => {
    const long = "a".repeat(80);
    const title = titleFromConversation([message("user", long)], "x");
    expect(title.length).toBeLessThanOrEqual(40);
    expect(title.endsWith("…")).toBe(true);
  });

  it("collapses newlines so a multi-line paste stays one line", () => {
    expect(titleFromConversation([message("user", "第一行\n第二行")], "x")).toBe("第一行 第二行");
  });

  it("falls back when there is no user message", () => {
    expect(titleFromConversation([message("assistant", "hi")], "未命名")).toBe("未命名");
  });
});
