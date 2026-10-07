import { memo, useMemo } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { InlineNode, ListItemNode, MarkdownBlock } from "@/ui/render/markdown";
import { parseMarkdown } from "@/ui/render/markdown";
import { theme } from "@/ui/theme";

/**
 * Markdown renderer for assistant messages.
 *
 * The parsed blocks come from `@/ui/render/markdown`, which is pure and unit-tested;
 * this file only maps them onto React Native views. Everything is memoised because a
 * streaming answer re-renders on every token — without memoisation each chunk would
 * re-parse and re-mount the whole message, which is what makes naive markdown
 * rendering feel sluggish on a phone.
 */

export interface MarkdownProps {
  text: string;
  /** True while tokens are still arriving; enables the incomplete-text strategy. */
  streaming?: boolean;
  /** Base text colour, so the same renderer works inside bubbles and notices. */
  color?: string;
}

export const MarkdownText = memo(function MarkdownText({
  text,
  streaming = false,
  color,
}: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(text, streaming), [text, streaming]);
  const baseColor = color ?? theme.colors.text;

  if (blocks.blocks.length === 0) {
    // Nothing renderable yet (e.g. a code fence still arriving). Showing the raw
    // tail as monospace text keeps the answer visibly progressing.
    if (text.trim() === "") return null;
    return (
      <Text style={[styles.paragraph, { color: theme.colors.textMuted, fontFamily: theme.font.mono }]}>
        {blocks.pending || text}
      </Text>
    );
  }

  return (
    <View>
      {blocks.blocks.map((block, index) => (
        <BlockView key={index} block={block} color={baseColor} first={index === 0} />
      ))}
      {streaming && blocks.pending ? (
        <Text style={[styles.paragraph, { color: baseColor, fontFamily: theme.font.mono, opacity: 0.75 }]}>
          {blocks.pending}
        </Text>
      ) : null}
    </View>
  );
});

const BlockView = memo(function BlockView({
  block,
  color,
  first,
}: {
  block: MarkdownBlock;
  color: string;
  first: boolean;
}) {
  switch (block.type) {
    case "heading":
      return (
        <Text
          style={[
            headingStyle(block.level),
            { color: theme.colors.text, marginTop: first ? 0 : theme.space(3) },
          ]}
        >
          <Inline nodes={block.content} color={theme.colors.text} />
        </Text>
      );

    case "paragraph":
      return (
        <Text style={[styles.paragraph, { color, marginTop: first ? 0 : theme.space(2.5) }]}>
          <Inline nodes={block.content} color={color} />
        </Text>
      );

    case "code":
      return (
        <View style={styles.codeBlock}>
          {block.language ? <Text style={styles.codeLang}>{block.language}</Text> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Text style={styles.codeText} selectable>
              {block.text}
            </Text>
          </ScrollView>
        </View>
      );

    case "list":
      return (
        <View style={{ marginTop: first ? 0 : theme.space(2) }}>
          {block.items.map((item, index) => (
            <ListItem
              key={index}
              item={item}
              marker={
                block.ordered ? `${block.start + index}.` : "•"
              }
              color={color}
            />
          ))}
        </View>
      );

    case "blockquote":
      return (
        <View style={[styles.quote, { marginTop: first ? 0 : theme.space(2.5) }]}>
          {block.blocks.map((inner, index) => (
            <BlockView key={index} block={inner} color={theme.colors.textMuted} first={index === 0} />
          ))}
        </View>
      );

    case "table":
      return <TableView block={block} />;

    case "hr":
      return <View style={[styles.hr, { marginTop: first ? 0 : theme.space(3) }]} />;

    default:
      return null;
  }
});

const ListItem = memo(function ListItem({
  item,
  marker,
  color,
}: {
  item: ListItemNode;
  marker: string;
  color: string;
}) {
  return (
    <View style={styles.listRow}>
      <Text style={[styles.listMarker, { color: theme.colors.textMuted }]}>{marker}</Text>
      <Text style={[styles.paragraph, styles.listContent, { color }]}>
        <Inline nodes={item.content} color={color} />
      </Text>
    </View>
  );
});

/**
 * Tables scroll horizontally rather than wrapping: a wrapped table row is
 * unreadable, and phone widths make anything past two columns overflow. This is the
 * construct the app previously printed as raw `| Folder | State |` source.
 */
const TableView = memo(function TableView({
  block,
}: {
  block: Extract<MarkdownBlock, { type: "table" }>;
}) {
  const columns = block.header.length;
  const cellStyle = (index: number) => {
    const align = block.align[index] ?? null;
    return align === "right" ? styles.cellRight : align === "center" ? styles.cellCenter : undefined;
  };
  const textAlign = (index: number): "left" | "center" | "right" =>
    block.align[index] === "right" ? "right" : block.align[index] === "center" ? "center" : "left";

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      style={styles.tableScroll}
      contentContainerStyle={styles.tableContent}
    >
      <View style={styles.table}>
        <View style={[styles.tableRow, styles.tableHeaderRow]}>
          {block.header.map((cell, index) => (
            <View key={index} style={[styles.cell, cellStyle(index)]}>
              <Text style={[styles.headerCellText, { textAlign: textAlign(index) }]}>
                <Inline nodes={cell} color={theme.colors.text} />
              </Text>
            </View>
          ))}
        </View>
        {block.rows.map((row, rowIndex) => (
          <View key={rowIndex} style={[styles.tableRow, rowIndex % 2 === 1 ? styles.tableRowAlt : null]}>
            {Array.from({ length: columns }).map((_, cellIndex) => {
              const cell = row[cellIndex] ?? [];
              return (
                <View key={cellIndex} style={[styles.cell, cellStyle(cellIndex)]}>
                  <Text style={[styles.cellText, { textAlign: textAlign(cellIndex) }]}>
                    <Inline nodes={cell} color={theme.colors.text} />
                  </Text>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
});

/** Inline nodes become nested <Text>, which is how RN does rich text. */
const Inline = memo(function Inline({
  nodes,
  color,
}: {
  nodes: InlineNode[];
  color: string;
}) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case "strong":
            return (
              <Text key={index} style={[styles.strong, { color: theme.colors.text }]}>
                {node.children ? <Inline nodes={node.children} color={theme.colors.text} /> : node.text}
              </Text>
            );
          case "em":
            return (
              <Text key={index} style={styles.em}>
                {node.children ? <Inline nodes={node.children} color={color} /> : node.text}
              </Text>
            );
          case "del":
            return (
              <Text key={index} style={styles.del}>
                {node.children ? <Inline nodes={node.children} color={color} /> : node.text}
              </Text>
            );
          case "code":
            return (
              <Text key={index} style={styles.inlineCode}>
                {node.text}
              </Text>
            );
          case "link":
            return (
              <Text
                key={index}
                style={styles.link}
                onPress={() => {
                  if (node.href) void Linking.openURL(node.href).catch(() => undefined);
                }}
              >
                {node.text}
              </Text>
            );
          default:
            return (
              <Text key={index} style={{ color }}>
                {node.text}
              </Text>
            );
        }
      })}
    </>
  );
});

function headingStyle(level: number) {
  switch (level) {
    case 1:
      return styles.h1;
    case 2:
      return styles.h2;
    case 3:
      return styles.h3;
    default:
      return styles.h4;
  }
}

/** Copy affordance: long-press any code block to select it. */
export const CopyHint = memo(function CopyHint() {
  return (
    <Pressable>
      <Text style={styles.copyHint}>长按可复制</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  paragraph: { fontSize: 15, lineHeight: 23 },
  h1: { fontSize: 21, fontWeight: "700", lineHeight: 29 },
  h2: { fontSize: 19, fontWeight: "700", lineHeight: 27 },
  h3: { fontSize: 17, fontWeight: "600", lineHeight: 25 },
  h4: { fontSize: 15, fontWeight: "600", lineHeight: 23 },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through", color: theme.colors.textFaint },
  link: { color: theme.colors.accent, textDecorationLine: "underline" },
  inlineCode: {
    fontFamily: theme.font.mono,
    fontSize: 13.5,
    color: theme.colors.warning,
    backgroundColor: theme.colors.background,
  },
  codeBlock: {
    marginTop: theme.space(2.5),
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.md,
    borderColor: theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(3),
  },
  codeLang: {
    color: theme.colors.textFaint,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: theme.space(1),
  },
  codeText: { fontFamily: theme.font.mono, fontSize: 12.5, lineHeight: 19, color: theme.colors.text },
  copyHint: { color: theme.colors.textFaint, fontSize: 10, marginTop: theme.space(1) },
  listRow: { flexDirection: "row", alignItems: "flex-start", marginTop: theme.space(1) },
  listMarker: { fontSize: 15, lineHeight: 23, minWidth: 20, fontVariant: ["tabular-nums"] },
  listContent: { flex: 1 },
  quote: {
    borderLeftColor: theme.colors.accent,
    borderLeftWidth: 3,
    paddingLeft: theme.space(3),
    paddingVertical: theme.space(1),
  },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border },
  tableScroll: { marginTop: theme.space(2.5) },
  tableContent: { paddingRight: theme.space(2) },
  table: {
    borderColor: theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.sm,
    overflow: "hidden",
  },
  tableRow: { flexDirection: "row" },
  tableHeaderRow: { backgroundColor: theme.colors.surfaceAlt },
  tableRowAlt: { backgroundColor: "rgba(255,255,255,0.02)" },
  cell: {
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(2.5),
    borderRightColor: theme.colors.border,
    borderRightWidth: StyleSheet.hairlineWidth,
    minWidth: 88,
    maxWidth: 260,
    justifyContent: "center",
  },
  cellRight: { justifyContent: "center" },
  cellCenter: { justifyContent: "center" },
  headerCellText: { color: theme.colors.text, fontSize: 13, fontWeight: "700", lineHeight: 19 },
  cellText: { color: theme.colors.text, fontSize: 13, lineHeight: 19 },
});
