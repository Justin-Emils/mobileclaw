import type { ReactNode } from "react";
import { MarkdownText } from "@/ui/render/markdown-view";
import { blocksToPlainText, parseMarkdown } from "@/ui/render/markdown";

/**
 * Content-format dispatch for assistant output.
 *
 * The renderer used to be a single `<Text>{text}</Text>`, which printed Markdown
 * source verbatim. Rather than hard-code Markdown, output goes through a small
 * registry so future formats are additive:
 *
 *   1. add a variant to `ContentKind`
 *   2. teach `detectKind` when to pick it (only if the format is auto-detectable)
 *   3. register a renderer in `RENDERERS`
 *
 * Nothing else in the app needs to change, and `parseContent` stays available for
 * tests and non-UI consumers (e.g. building conversation titles).
 */

export type ContentKind = "markdown" | "plain";

export interface RenderContext {
  /** True while tokens are still arriving. */
  streaming?: boolean;
  /** Base text colour, so the renderer fits its container. */
  color?: string;
}

export interface ContentRenderer {
  kind: ContentKind;
  /** Human label, used by the diagnostics screen. */
  label: string;
  render: (text: string, context: RenderContext) => ReactNode;
  /** Plain-text projection, for titles and search. */
  toPlainText: (text: string) => string;
}

const markdownRenderer: ContentRenderer = {
  kind: "markdown",
  label: "Markdown",
  render: (text, context) => (
    <MarkdownText text={text} streaming={context.streaming} color={context.color} />
  ),
  toPlainText: (text) => blocksToPlainText(parseMarkdown(text).blocks),
};

/**
 * Assistant messages are Markdown by convention — every model we support emits it,
 * and the system prompt says so. Kept as a separate kind so a caller can opt out
 * (tool output, user input) without inventing a second component.
 */
const plainRenderer: ContentRenderer = {
  kind: "plain",
  label: "Plain text",
  render: (text, context) => (
    <MarkdownText text={text} streaming={context.streaming} color={context.color} />
  ),
  toPlainText: (text) => text,
};

const RENDERERS: Record<ContentKind, ContentRenderer> = {
  markdown: markdownRenderer,
  plain: plainRenderer,
};

/** Which renderer to use. Assistant answers are Markdown; everything else plain. */
export function detectKind(source: "assistant" | "user" | "system" | "tool"): ContentKind {
  return source === "assistant" ? "markdown" : "plain";
}

export function rendererFor(kind: ContentKind): ContentRenderer {
  return RENDERERS[kind] ?? RENDERERS.plain;
}

/** Render content of a given kind. Unknown kinds fall back to plain text. */
export function renderContent(kind: ContentKind, text: string, context: RenderContext = {}): ReactNode {
  return rendererFor(kind).render(text, context);
}

/** Plain-text projection for any kind. */
export function contentToPlainText(kind: ContentKind, text: string): string {
  return rendererFor(kind).toPlainText(text);
}

export function availableKinds(): ContentKind[] {
  return Object.keys(RENDERERS) as ContentKind[];
}

export { MarkdownText } from "@/ui/render/markdown-view";
export * from "@/ui/render/markdown";
