import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { TranscriptEntry } from "@mobileclaw/core";
import { safeStringify } from "@mobileclaw/core";
import { statusColor, theme } from "@/ui/theme";
import { strings } from "@/ui/strings";

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

/** 工具状态的显示名：内核用小写英文，界面用中文。 */
function statusLabel(status: ToolEntry["status"]): string {
  switch (status) {
    case "running":
      return strings.tool.statusRunning;
    case "ok":
      return strings.tool.statusOk;
    case "error":
      return strings.tool.statusError;
    case "denied":
      return strings.tool.statusDenied;
    default:
      return status;
  }
}

/**
 * One tool call in the transcript.
 *
 * Collapsed by default with a one-line summary, because a run can produce a dozen
 * calls; the user expands the one they care about. Input and output are both
 * shown so the user can audit exactly what left the device.
 */
export function ToolCard({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const color = statusColor(entry.status);
  const title = entry.summary ?? entry.name;

  return (
    <Pressable style={styles.card} onPress={() => setOpen((value) => !value)}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={styles.name} numberOfLines={1}>
          {entry.name}
        </Text>
        <Text style={styles.summary} numberOfLines={1}>
          {title === entry.name ? "" : title}
        </Text>
        <Text style={[styles.status, { color }]}>{statusLabel(entry.status)}</Text>
        {entry.durationMs !== undefined ? (
          <Text style={styles.duration}>{Math.round(entry.durationMs)}ms</Text>
        ) : null}
      </View>

      {open ? (
        <View style={styles.body}>
          <Text style={styles.label}>{strings.tool.input}</Text>
          <Text style={styles.code}>{safeStringify(entry.input, 2)}</Text>
          {entry.output !== undefined ? (
            <>
              <Text style={styles.label}>{strings.tool.output}</Text>
              <Text style={styles.code}>{entry.output}</Text>
            </>
          ) : null}
          {entry.error !== undefined ? (
            <>
              <Text style={styles.label}>{strings.tool.error}</Text>
              <Text style={[styles.code, { color: theme.colors.danger }]}>{entry.error}</Text>
            </>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.tool,
    borderRadius: theme.radius.md,
    borderColor: theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2.5),
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { color: theme.colors.text, fontSize: 12, fontWeight: "600", fontFamily: theme.font.mono },
  summary: { color: theme.colors.textMuted, fontSize: 11, flex: 1 },
  status: { fontSize: 10, textTransform: "uppercase" },
  duration: { color: theme.colors.textFaint, fontSize: 10 },
  body: {
    padding: theme.space(3),
    gap: theme.space(1),
    borderTopColor: theme.colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  label: {
    color: theme.colors.textFaint,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: theme.space(1),
  },
  code: { color: theme.colors.text, fontSize: 11, fontFamily: theme.font.mono, lineHeight: 16 },
});
