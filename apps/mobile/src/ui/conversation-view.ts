import type { ChatMessage } from "@mobileclaw/core";

/** Minimal transcript row. Mirrors the `Bubble` shape in app/index.tsx. */
export interface TranscriptBubble {
  id: string;
  role: "user" | "assistant"; 
  text: string;
}

/**
 * Project a stored conversation onto the transcript.
 *
 * Lives here rather than in the screen so it can be unit-tested: restoring a
 * conversation is easy to get subtly wrong (duplicating tool messages, dropping
 * empty assistant turns, reordering) and hard to notice by eye.
 *
 * Tool messages are deliberately skipped — they are rendered from
 * `conversation.entries` by the tool cards, and replaying them as bubbles would show
 * every call twice.
 */
export function toBubbles(messages: ChatMessage[]): TranscriptBubble[] {
  const out: TranscriptBubble[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return;
    // An assistant turn that only requested tools has no prose; skip it rather than
    // rendering an empty bubble.
    if (message.content.trim() === "") return;
    out.push({
      // Index-based so a re-hydration of the same conversation is stable in React.
      id: `h_${index}`,
      role: message.role,
      text: message.content,
    });
  });
  return out;
}

/** Title shown in the conversation list, derived from the opening user message. */
export function titleFromConversation(messages: ChatMessage[], fallback: string): string {
  const first = messages.find((message) => message.role === "user" && message.content.trim() !== "");
  if (!first) return fallback;
  const flat = first.content.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}
