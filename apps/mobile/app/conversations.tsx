import { useCallback, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Link, useFocusEffect, useRouter } from "expo-router";
import { useRuntime, useRuntimeState } from "@/ui/runtime-provider";
import { strings } from "@/ui/strings";
import { theme } from "@/ui/theme";

type Summary = { id: string; title: string; updatedAt: number };

/**
 * Past conversations.
 *
 * The store was always populated — the agent saves the conversation on every run —
 * but nothing ever read it back, so closing the app lost the thread. This screen plus
 * the `id` parameter on the chat route is the missing half.
 *
 * Reloaded on focus rather than once on mount, so deleting an entry and returning
 * from a chat both show current data.
 */
export default function ConversationsScreen() {
  const state = useRuntimeState();
  const runtime = state.runtime;
  const router = useRouter();
  const [items, setItems] = useState<Summary[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    if (!runtime) return;
    try {
      const list = await runtime.listConversations();
      // Newest first: the one you want is almost always the last one you used.
      setItems([...list].sort((a, b) => b.updatedAt - a.updatedAt));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [runtime]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const remove = useCallback(
    (item: Summary) => {
      if (!runtime) return;
      Alert.alert(strings.conversations.deleteTitle, item.title, [
        { text: strings.common.cancel, style: "cancel" },
        {
          text: strings.common.remove,
          style: "destructive",
          onPress: () => {
            void runtime.deleteConversation(item.id).then(() => reload());
          },
        },
      ]);
    },
    [runtime, reload],
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Link href="/" asChild>
          <Pressable style={styles.headerButton}>
            <Text style={styles.headerButtonText}>{strings.common.back}</Text>
          </Pressable>
        </Link>
        <Text style={styles.title}>{strings.conversations.title}</Text>
        <Pressable style={styles.headerButton} onPress={() => router.push("/")}>
          <Text style={styles.headerButtonText}>{strings.common.new}</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={items ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          items === undefined ? null : (
            <View style={styles.empty}>
              <Text style={styles.muted}>{strings.conversations.empty}</Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => router.push({ pathname: "/", params: { id: item.id } })}
            onLongPress={() => remove(item)}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title || strings.conversations.untitled}
              </Text>
              <Text style={styles.rowMeta}>{formatWhen(item.updatedAt)}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
      <Text style={styles.hint}>{strings.conversations.hint}</Text>
    </View>
  );
}

/** Relative time, so the list stays scannable without reading dates. */
function formatWhen(timestamp: number): string {
  const delta = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return strings.conversations.justNow;
  if (delta < hour) return strings.conversations.minutesAgo(Math.floor(delta / minute));
  if (delta < day) return strings.conversations.hoursAgo(Math.floor(delta / hour));
  if (delta < 7 * day) return strings.conversations.daysAgo(Math.floor(delta / day));
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(4),
    paddingBottom: theme.space(2),
    gap: theme.space(2),
  },
  title: { color: theme.colors.text, fontSize: 16, fontWeight: "600" },
  headerButton: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
  },
  headerButtonText: { color: theme.colors.text, fontSize: 13, fontWeight: "600" },
  list: { paddingHorizontal: theme.space(4), paddingBottom: theme.space(6) },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.space(3),
    borderBottomColor: theme.colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: theme.space(2),
  },
  rowText: { flex: 1, gap: theme.space(1) },
  rowTitle: { color: theme.colors.text, fontSize: 15 },
  rowMeta: { color: theme.colors.textFaint, fontSize: 11 },
  chevron: { color: theme.colors.textFaint, fontSize: 20 },
  empty: { paddingVertical: theme.space(8), alignItems: "center" },
  muted: { color: theme.colors.textMuted, fontSize: 13, textAlign: "center", lineHeight: 20 },
  error: { color: theme.colors.danger, fontSize: 13, paddingHorizontal: theme.space(4) },
  hint: {
    color: theme.colors.textFaint,
    fontSize: 11,
    textAlign: "center",
    paddingBottom: theme.space(4),
  },
});
