import { describe, expect, it } from "vitest";
import { buildTableGrid, columnTextAlign } from "@/ui/render/markdown-view";
import { parseInline, parseMarkdown, type InlineNode } from "@/ui/render/markdown";

/**
 * The render layer used to be untestable because it is made of components. These two
 * helpers carry the part that can be wrong invisibly: how a model's pipe table becomes a
 * fixed-width grid.
 *
 * Models emit ragged tables constantly -- a missing trailing cell, a stray `|` that
 * splits a cell in two, a row longer than the header. Without normalisation a short row
 * shifts every later column, so the numbers end up under the wrong heading and the table
 * looks plausible while being wrong. That is worse than showing raw markdown.
 */

/** Build a table block the way the parser would, from raw markdown. */
function parseTableBlock(markdown: string): {
  header: InlineNode[][];
  rows: InlineNode[][][];
  align: (("left" | "center" | "right") | null)[];
} {
  const block = parseMarkdown(markdown).blocks.find((candidate) => candidate.type === "table");
  if (!block || block.type !== "table") throw new Error("expected a table");
  return { header: block.header, rows: block.rows, align: block.align };
}

describe("buildTableGrid", () => {
  it("pads a short row to the header width", () => {
    // A missing trailing cell must not shift anything: the row gets an empty cell.
    const grid = buildTableGrid(parseTableBlock("| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |"));
    expect(grid.columns).toBe(3);
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0]).toHaveLength(3);
    expect(grid.rows[0]?.[2]).toEqual([]);
  });

  it("truncates a row longer than the header", () => {
    // Extra cells would overflow the grid; the header defines the width.
    const grid = buildTableGrid(parseTableBlock("| a | b |\n| --- | --- |\n| 1 | 2 | 3 | 4 |"));
    expect(grid.rows[0]).toHaveLength(2);
  });

  it("gives every row the same width so columns stay aligned", () => {
    const grid = buildTableGrid(
      parseTableBlock(
        ["| h1 | h2 | h3 |", "| --- | --- | --- |", "| 1 | 2 | 3 |", "| 4 |", "| 5 | 6 | 7 |"].join("\n"),
      ),
    );
    expect(grid.rows.map((row) => row.length)).toEqual([3, 3, 3]);
  });

  it("pads the alignment list to the column count", () => {
    // A separator row with fewer markers than the header used to leave later columns
    // with `undefined`, which the component read as "not right/centre" by accident.
    const grid = buildTableGrid({ header: [[], [], []], rows: [], align: ["right"] });
    expect(grid.align).toEqual(["right", null, null]);
  });

  it("preserves an explicitly empty cell rather than replacing it", () => {
    const grid = buildTableGrid(parseTableBlock("| a | b |\n| --- | --- |\n| | x |"));
    expect(grid.rows[0]?.[0]).toEqual([]);
    expect(grid.rows[0]?.[1]).not.toEqual([]);
  });

  it("keeps a row of the right size for a table with no body rows", () => {
    const grid = buildTableGrid({ header: [[], []], rows: [], align: [] });
    expect(grid.columns).toBe(2);
    expect(grid.rows).toEqual([]);
  });

  it("carries inline formatting through to the grid", () => {
    // The cells are inline node lists, not strings: **bold** must survive into a cell.
    const grid = buildTableGrid(parseTableBlock("| a |\n| --- |\n| **bold** |"));
    expect(grid.rows[0]?.[0]?.some((node) => node.type === "strong")).toBe(true);
  });

  it("treats an escaped pipe as one cell, not two", () => {
    const grid = buildTableGrid(parseTableBlock("| a \\| b | c |\n| --- | --- |\n| 1 | 2 |"));
    expect(grid.columns).toBe(2);
  });
});

describe("columnTextAlign", () => {
  it("maps each alignment and defaults to left", () => {
    const align = ["right", "center", "left", null] as const;
    expect(columnTextAlign([...align], 0)).toBe("right");
    expect(columnTextAlign([...align], 1)).toBe("center");
    expect(columnTextAlign([...align], 2)).toBe("left");
    expect(columnTextAlign([...align], 3)).toBe("left");
  });

  it("defaults to left past the end of the alignment list", () => {
    expect(columnTextAlign(["right"], 5)).toBe("left");
  });
});

describe("parseInline (used for every cell)", () => {
  it("keeps a numeric-looking cell as one text node", () => {
    expect(parseInline("1.2 GB")).toEqual([{ type: "text", text: "1.2 GB" }]);
  });

  it("does not treat a bare asterisk in a cell as emphasis", () => {
    // Sizes like "2 * 3" appear in tables and must not become italics.
    expect(parseInline("2 * 3").every((node) => node.type === "text")).toBe(true);
  });
});
