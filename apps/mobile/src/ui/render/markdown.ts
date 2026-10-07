/**
 * Markdown parsing for the chat transcript.
 *
 * Why a hand-written parser instead of a library: every maintained option
 * (react-native-marked, react-native-markdown-display and its fork,
 * streamdown-rn) pulls in native dependencies, and none handles the case this app
 * hits constantly — **half-written Markdown during streaming**. An incomplete table
 * or an unclosed code fence renders as garbage with them, and a partially received
 * `| Folder | State |` is exactly what a user sees mid-answer.
 *
 * This layer is pure and dependency-free so it can be unit-tested on Node, and it
 * reports incomplete constructs separately: the renderer shows complete blocks and
 * holds back the rest until the stream finishes.
 */

export interface InlineNode {
  type: "text" | "strong" | "em" | "code" | "link" | "del";
  text: string;
  /** For links. */
  href?: string;
  /** Nested styling, e.g. bold inside a list item. */
  children?: InlineNode[];
}

export interface ListItemNode {
  content: InlineNode[];
  /** Nested list under this item, if any. */
  children?: MarkdownBlock[];
}

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: InlineNode[] }
  | { type: "paragraph"; content: InlineNode[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItemNode[] }
  | { type: "code"; language?: string; text: string }
  | { type: "blockquote"; blocks: MarkdownBlock[] }
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][]; align: TableAlign[] }
  | { type: "hr" };

export type TableAlign = "left" | "center" | "right" | null;

export interface ParseResult {
  blocks: MarkdownBlock[];
  /**
   * Raw text that belongs to a construct that is still being written and therefore
   * cannot be rendered yet: an open code fence, a table without its blank-line
   * terminator, a bare `**` at the very end. The renderer appends this verbatim
   * while streaming and parses again on the next chunk.
   */
  pending: string;
  /** True when the last construct was cut off by the end of input. */
  isPartial: boolean;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const UL_ITEM = /^(\s*)([-*+])\s+(.*)$/;
const OL_ITEM = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP = /^\s*\|?[\s:|-]+\|?\s*$/;

/**
 * Parse Markdown into blocks.
 *
 * `streaming` marks the input as possibly incomplete: the parser then refuses to
 * emit a construct it cannot prove is finished and returns it in `pending` instead.
 * That is what keeps a growing table or code block from flickering through broken
 * states.
 */
export function parseMarkdown(input: string, streaming = false): ParseResult {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  let pending = "";
  let isPartial = false;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    // Blank line: never part of a block.
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    // --- fenced code ------------------------------------------------------
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const language = fence[2] || undefined;
      const body: string[] = [];
      let cursor = index + 1;
      let closed = false;
      while (cursor < lines.length) {
        const candidate = lines[cursor] ?? "";
        if (FENCE.test(candidate) && candidate.trim().startsWith(marker[0]!.repeat(3))) {
          closed = true;
          break;
        }
        body.push(candidate);
        cursor += 1;
      }
      if (!closed) {
        if (streaming) {
          // Hold the whole fence back: rendering a code block that is still being
          // written makes the text jump as it grows.
          pending = lines.slice(index).join("\n");
          isPartial = true;
          break;
        }
        // Finished stream but never closed: render what we got rather than nothing.
        blocks.push({ type: "code", ...(language ? { language } : {}), text: body.join("\n") });
        index = lines.length;
        continue;
      }
      blocks.push({ type: "code", ...(language ? { language } : {}), text: body.join("\n") });
      index = cursor + 1;
      continue;
    }

    // --- heading ----------------------------------------------------------
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, content: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }

    // --- horizontal rule --------------------------------------------------
    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    // --- table ------------------------------------------------------------
    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_SEP.test(lines[index + 1] ?? "")) {
      const table = parseTable(lines, index, streaming);
      if (table) {
        // Stream only the rows that are provably complete. The trailing row of a
        // still-arriving table is held in `pending`, so the rendered column count
        // never flaps — but rows already received stay on screen.
        if (table.block.rows.length > 0 || !table.incomplete) {
          blocks.push(table.block);
        }
        if (table.incomplete) {
          pending = lines.slice(table.pendingFrom).join("\n");
          isPartial = true;
          break;
        }
        index = table.next;
        continue;
      }
    }

    // --- blockquote -------------------------------------------------------
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      let cursor = index;
      while (cursor < lines.length && QUOTE.test(lines[cursor] ?? "")) {
        quoted.push(QUOTE.exec(lines[cursor] ?? "")![1] ?? "");
        cursor += 1;
      }
      const inner = parseMarkdown(quoted.join("\n"), streaming && cursor >= lines.length);
      if (inner.blocks.length > 0) blocks.push({ type: "blockquote", blocks: inner.blocks });
      // A quote still being written keeps its tail pending.
      if (streaming && cursor >= lines.length && inner.pending) {
        pending = quoted.join("\n");
        isPartial = true;
        break;
      }
      index = cursor;
      continue;
    }

    // --- lists ------------------------------------------------------------
    const list = parseList(lines, index, streaming);
    if (list) {
      if (list.incomplete) {
        pending = lines.slice(index).join("\n");
        isPartial = true;
        break;
      }
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    // --- paragraph --------------------------------------------------------
    const paragraph: string[] = [];
    let cursor = index;
    while (cursor < lines.length) {
      const candidate = lines[cursor] ?? "";
      if (
        candidate.trim() === "" ||
        HEADING.test(candidate) ||
        HR.test(candidate) ||
        FENCE.test(candidate) ||
        QUOTE.test(candidate) ||
        UL_ITEM.test(candidate) ||
        OL_ITEM.test(candidate)
      ) {
        break;
      }
      paragraph.push(candidate);
      cursor += 1;
    }
    const text = paragraph.join("\n");
    // A trailing double-space means a hard break; keep the paragraph but drop it.
    blocks.push({ type: "paragraph", content: parseInline(text.replace(/ {2}$/, "")) });
    index = cursor === index ? index + 1 : cursor;
  }

  // Drop the trailing-inline-marker cleanup that used to live here: removing the
  // whole paragraph because its last character was an unfinished `**` made correct
  // prose disappear and reappear mid-stream, which reads far worse than briefly
  // showing a literal asterisk. Inline markers render as text until they close.
  return { blocks, pending, isPartial };
}

/** Balanced-pair check for inline markers; returns the unmatched marker or null. */
export function countUnclosed(text: string): string | null {
  for (const marker of ["**", "__", "`", "~~"]) {
    const occurrences = text.split(marker).length - 1;
    if (occurrences % 2 === 1) return marker;
  }
  // A single `[` without `]` is also an unfinished link.
  const opens = (text.match(/\[/g) ?? []).length;
  const closes = (text.match(/\]/g) ?? []).length;
  if (opens > closes) return "[";
  return null;
}

interface TableResult {
  block: Extract<MarkdownBlock, { type: "table" }>;
  next: number;
  incomplete: boolean;
  /** First line index that belongs to the still-arriving tail. */
  pendingFrom: number;
}

function parseTable(lines: string[], start: number, streaming: boolean): TableResult | null {
  const headerLine = lines[start] ?? "";
  const separator = lines[start + 1] ?? "";
  const splitRow = (line: string): string[] => {
    const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    // Split on unescaped pipes so `a \| b` stays one cell.
    const cells: string[] = [];
    let current = "";
    for (let i = 0; i < inner.length; i += 1) {
      const char = inner[i]!;
      if (char === "\\" && inner[i + 1] === "|") {
        current += "|";
        i += 1;
        continue;
      }
      if (char === "|") {
        cells.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    cells.push(current.trim());
    return cells;
  };

  const align: TableAlign[] = splitRow(separator).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const header = splitRow(headerLine).map(parseInline);
  const rows: InlineNode[][][] = [];

  let cursor = start + 2;
  /** Line index of the last row seen, i.e. the row that may still be growing. */
  let lastRowStart = -1;
  while (cursor < lines.length) {
    const candidate = lines[cursor] ?? "";
    if (candidate.trim() === "" || !TABLE_ROW.test(candidate)) break;
    lastRowStart = cursor;
    rows.push(splitRow(candidate).map(parseInline));
    cursor += 1;
  }

  // A table is only terminated by a blank line or a non-row line. If the input ends
  // while a row is still open, that last row may still grow — holding it back keeps
  // the rendered column count stable without hiding the rows already received.
  const atEnd = cursor >= lines.length;
  if (streaming && atEnd && lastRowStart !== -1) {
    rows.pop();
    return {
      block: { type: "table", header, rows, align },
      next: lastRowStart,
      incomplete: true,
      pendingFrom: lastRowStart,
    };
  }

  return {
    block: { type: "table", header, rows, align },
    next: cursor,
    incomplete: false,
    pendingFrom: cursor,
  };
}

interface ListResult {
  block: Extract<MarkdownBlock, { type: "list" }>;
  next: number;
  incomplete: boolean;
}

function parseList(lines: string[], start: number, streaming: boolean): ListResult | null {
  const first = lines[start] ?? "";
  const firstUnordered = UL_ITEM.exec(first);
  const firstOrdered = OL_ITEM.exec(first);
  if (!firstUnordered && !firstOrdered) return null;

  const ordered = Boolean(firstOrdered);
  const startNumber = firstOrdered ? Number.parseInt(firstOrdered[2]!, 10) : 1;
  const items: ListItemNode[] = [];
  let cursor = start;
  /** A loose list item whose text may still continue (no blank line yet). */
  let openItem = false;

  while (cursor < lines.length) {
    const line = lines[cursor] ?? "";
    if (line.trim() === "") {
      // Blank line: the list may continue (loose list) or end.
      const ahead = lines[cursor + 1] ?? "";
      if (UL_ITEM.test(ahead) || OL_ITEM.test(ahead) || /^\s{2,}\S/.test(ahead)) {
        openItem = true;
        cursor += 1;
        continue;
      }
      break;
    }
    const bullet = ordered ? OL_ITEM.exec(line) : UL_ITEM.exec(line);
    if (bullet && bullet[1] === "") {
      openItem = true;
      items.push({ content: parseInline(bullet[3] ?? "") });
      cursor += 1;
      continue;
    }
    // Continuation line (indented) belongs to the previous item.
    if (items.length > 0 && /^\s{2,}\S/.test(line)) {
      const last = items[items.length - 1]!;
      const extra = line.trim();
      const previousText = inlineToText(last.content);
      last.content = parseInline(`${previousText} ${extra}`);
      cursor += 1;
      continue;
    }
    break;
  }

  const atEnd = cursor >= lines.length;
  if (streaming && atEnd && openItem) {
    // The list may still receive items; keep it, but the renderer will re-parse.
    return { block: { type: "list", ordered, start: startNumber, items }, next: cursor, incomplete: false };
  }

  return { block: { type: "list", ordered, start: startNumber, items }, next: cursor, incomplete: false };
}

function inlineToText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => (node.children ? inlineToText(node.children) : node.text))
    .join("");
}

/**
 * Inline parsing: code spans win over everything, then links, then emphasis.
 * Deliberately linear — regex alternation with nested groups mis-parses
 * `**a `b` c**`, which models write often.
 */
export function parseInline(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";
  let i = 0;

  const flush = (): void => {
    if (buffer !== "") {
      nodes.push({ type: "text", text: buffer });
      buffer = "";
    }
  };

  while (i < input.length) {
    const rest = input.slice(i);

    // Code span: `...` — highest precedence.
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      nodes.push({ type: "code", text: code[1]! });
      i += code[0].length;
      continue;
    }

    // Link: [label](href)
    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush();
      nodes.push({ type: "link", text: link[1] || link[2]!, href: link[2]!, children: parseInline(link[1] ?? "") });
      i += link[0].length;
      continue;
    }

    // Strong: **...** or __...__
    const strong = /^(\*\*|__)([\s\S]+?)\1/.exec(rest);
    if (strong) {
      flush();
      nodes.push({ type: "strong", text: strong[2]!, children: parseInline(strong[2]!) });
      i += strong[0].length;
      continue;
    }

    // Strikethrough: ~~...~~
    const del = /^~~([\s\S]+?)~~/.exec(rest);
    if (del) {
      flush();
      nodes.push({ type: "del", text: del[1]!, children: parseInline(del[1]!) });
      i += del[0].length;
      continue;
    }

    // Emphasis: *...* or _..._ (single marker, not part of a word for `_`)
    const em = /^\*([^*\n]+)\*/.exec(rest) ?? /^_([^_\n]+)_/.exec(rest);
    if (em) {
      flush();
      nodes.push({ type: "em", text: em[1]!, children: parseInline(em[1]!) });
      i += em[0].length;
      continue;
    }

    buffer += input[i];
    i += 1;
  }

  flush();
  return mergeAdjacentText(nodes);
}

/** Adjacent text nodes are merged so the renderer emits fewer nested Text nodes. */
function mergeAdjacentText(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.type === "text" && last?.type === "text") {
      last.text += node.text;
      continue;
    }
    out.push(node);
  }
  return out;
}

/** Plain-text projection, used for search, titles and tests. */
export function blocksToPlainText(blocks: MarkdownBlock[]): string {
  const inline = (nodes: InlineNode[]): string =>
    nodes.map((node) => (node.children ? inline(node.children) : node.text)).join("");
  return blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
        case "paragraph":
          return inline(block.content);
        case "code":
          return block.text;
        case "list":
          return block.items.map((item) => inline(item.content)).join("\n");
        case "blockquote":
          return blocksToPlainText(block.blocks);
        case "table":
          return [block.header, ...block.rows].map((row) => row.map(inline).join(" | ")).join("\n");
        case "hr":
          return "---";
        default:
          return "";
      }
    })
    .join("\n\n")
    .trim();
}
