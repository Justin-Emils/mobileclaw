import { describe, expect, it } from "vitest";
import { blocksToPlainText, countUnclosed, parseInline, parseMarkdown } from "@/ui/render/markdown";

describe("parseInline", () => {
  it("parses bold, emphasis, code, strikethrough and links", () => {
    const nodes = parseInline("plain **bold** _em_ `code` ~~gone~~ [site](https://x.dev)");
    const types = nodes.map((node) => node.type);
    expect(types).toEqual(["text", "strong", "text", "em", "text", "code", "text", "del", "text", "link"]);
    expect(nodes.find((node) => node.type === "strong")?.text).toBe("bold");
    expect(nodes.find((node) => node.type === "link")?.href).toBe("https://x.dev");
    expect(nodes.find((node) => node.type === "link")?.text).toBe("site");
  });

  it("lets a code span win over emphasis inside it", () => {
    // Models write `**a `b` c**` often; a naive alternation regex mangles it.
    const nodes = parseInline("**a `b` c**");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type).toBe("strong");
    const inner = nodes[0]?.children ?? [];
    expect(inner.map((node) => node.type)).toEqual(["text", "code", "text"]);
    expect(inner.find((node) => node.type === "code")?.text).toBe("b");
  });

  it("merges adjacent text and leaves unbalanced markers literal", () => {
    const merged = parseInline("a**b**c");
    expect(merged.map((node) => node.type)).toEqual(["text", "strong", "text"]);
    expect(parseInline("2 * 3 = 6").every((node) => node.type === "text")).toBe(true);
  });

  it("keeps a URL intact with underscores and query strings", () => {
    const nodes = parseInline("[a](https://x.dev/a_b?c=1&d=2)");
    expect(nodes[0]?.href).toBe("https://x.dev/a_b?c=1&d=2");
  });
});

describe("parseMarkdown blocks", () => {
  it("parses headings, paragraphs and rules", () => {
    const { blocks } = parseMarkdown("# Title\n\ntext\n\n---\n\nmore");
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "hr", "paragraph"]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
  });

  it("parses fenced code with a language and preserves its body verbatim", () => {
    const md = "text\n\n```ts\nconst a = 1;\n\nif (a) {}\n```\n\nafter";
    const { blocks } = parseMarkdown(md);
    const code = blocks.find((block) => block.type === "code");
    expect(code).toMatchObject({ type: "code", language: "ts" });
    expect(code?.type === "code" ? code.text : "").toContain("const a = 1;");
    expect(blocks.at(-1)?.type).toBe("paragraph");
  });

  it("parses unordered and ordered lists, including continuations", () => {
    const { blocks } = parseMarkdown("- one\n- two\n  continued\n\n1. first\n2. second");
    const lists = blocks.filter((block) => block.type === "list");
    expect(lists).toHaveLength(2);
    expect(lists[0]).toMatchObject({ type: "list", ordered: false });
    expect(lists[1]).toMatchObject({ type: "list", ordered: true, start: 1 });
    const first = lists[0]?.type === "list" ? lists[0].items : [];
    expect(first).toHaveLength(2);
    expect(blocksToPlainText([lists[0]!])).toContain("two continued");
  });

  it("records a non-1 start for ordered lists", () => {
    const { blocks } = parseMarkdown("3. three\n4. four");
    expect(blocks[0]).toMatchObject({ type: "list", ordered: true, start: 3 });
  });

  it("parses blockquotes", () => {
    const { blocks } = parseMarkdown("> quoted line\n> second line");
    expect(blocks[0]?.type).toBe("blockquote");
    expect(blocksToPlainText(blocks)).toContain("quoted line");
  });

  it("parses a GFM table with alignment", () => {
    const md = [
      "Here's the situation:",
      "",
      "| Folder | State | Size |",
      "| :--- | :---: | ---: |",
      "| Telegram | app-owned | 1.2 GB |",
      "| MyStuff | yours | 3 MB |",
      "",
      "and the plan changed.",
    ].join("\n");
    const { blocks, pending, isPartial } = parseMarkdown(md);
    expect(isPartial).toBe(false);
    expect(pending).toBe("");
    const table = blocks.find((block) => block.type === "table");
    expect(table).toBeDefined();
    if (table?.type !== "table") throw new Error("expected a table");
    expect(table.header.map((cell) => blocksToPlainText([{ type: "paragraph", content: cell }]))).toEqual([
      "Folder",
      "State",
      "Size",
    ]);
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.rows).toHaveLength(2);
  });

  it("keeps an escaped pipe inside a single cell", () => {
    const { blocks } = parseMarkdown("| a \\| b | c |\n| --- | --- |\n| 1 | 2 |");
    const table = blocks.find((block) => block.type === "table");
    if (table?.type !== "table") throw new Error("expected a table");
    expect(table.header).toHaveLength(2);
    expect(blocksToPlainText([{ type: "paragraph", content: table.header[0]! }])).toBe("a | b");
  });
});

describe("streaming: incomplete constructs are held back", () => {
  it("does not render an unclosed code fence", () => {
    const { blocks, pending, isPartial } = parseMarkdown("before\n\n```ts\nconst a =", true);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph"]);
    expect(isPartial).toBe(true);
    expect(pending).toContain("```ts");
  });

  it("renders the fence once it closes", () => {
    const { blocks, isPartial } = parseMarkdown("before\n\n```ts\nconst a = 1;\n```", true);
    expect(isPartial).toBe(false);
    expect(blocks.some((block) => block.type === "code")).toBe(true);
  });

  it("drops a half-written table row so the column count stays stable", () => {
    // Row 2 is still arriving; rendering it would show the wrong number of cells.
    const partial = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |", true);
    const table = partial.blocks.find((block) => block.type === "table");
    if (table?.type !== "table") throw new Error("expected a table");
    expect(table.rows).toHaveLength(1);
    expect(partial.isPartial).toBe(true);

    const complete = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |", false);
    const full = complete.blocks.find((block) => block.type === "table");
    if (full?.type !== "table") throw new Error("expected a table");
    expect(full.rows).toHaveLength(2);
  });

  it("shows an unfinished bold marker as literal text while streaming", () => {
    // Deliberate trade-off: holding the paragraph back made correct prose disappear
    // and reappear, which reads worse than briefly showing the asterisks. The next
    // chunk re-parses and the marker resolves. A finished stream keeps it literal.
    const streaming = parseMarkdown("no loose files at all **", true);
    expect(blocksToPlainText(streaming.blocks)).toBe("no loose files at all **");

    const resolved = parseMarkdown("no loose files at all **really**", true);
    const strong = resolved.blocks[0];
    expect(strong?.type).toBe("paragraph");
    if (strong?.type !== "paragraph") throw new Error("expected a paragraph");
    expect(strong.content.some((node) => node.type === "strong")).toBe(true);
  });

  it("streams growing text without dropping finished blocks", () => {
    const chunks = ["# Header", "\n\nparagraph one", "\n\nsecond para"];
    let text = "";
    const seen: string[] = [];
    for (const chunk of chunks) {
      text += chunk;
      seen.push(blocksToPlainText(parseMarkdown(text, true).blocks));
    }
    expect(seen[0]).toContain("Header");
    expect(seen[1]).toContain("paragraph one");
    expect(seen[2]).toContain("second para");
    // Earlier content must never vanish as later chunks arrive.
    expect(seen[2]).toContain("Header");
  });

  it("reports unclosed inline markers", () => {
    expect(countUnclosed("text **")).toBe("**");
    expect(countUnclosed("text **bold**")).toBeNull();
    expect(countUnclosed("a `code")).toBe("`");
    expect(countUnclosed("see [link")).toBe("[");
    expect(countUnclosed("plain text")).toBeNull();
  });
});

describe("blocksToPlainText", () => {
  it("flattens every block type", () => {
    const md = "# H\n\npara\n\n- a\n- b\n\n```js\ncode\n```\n\n| x | y |\n| --- | --- |\n| 1 | 2 |";
    const text = blocksToPlainText(parseMarkdown(md).blocks);
    expect(text).toContain("H");
    expect(text).toContain("a");
    expect(text).toContain("code");
    expect(text).toContain("1 | 2");
  });
});
