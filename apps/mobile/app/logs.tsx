import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useRuntime } from "@/ui/runtime-provider";
import { strings } from "@/ui/strings";
import { theme } from "@/ui/theme";

/**
 * The diagnostic log, on screen and shareable.
 *
 * ## Why this screen has to exist
 *
 * The log is written to the app's private directory, which nothing else on the phone can read, and
 * a release build bridges no `console` output to logcat. Without a way out, the log would be
 * exactly as invisible as the failure it was added to explain.
 *
 * So the two actions here are the point of the screen: **copy out** and **clear**. Clear matters
 * because the useful capture is usually "start clean, reproduce once, then share" — a log that
 * already contains yesterday makes the one interesting run hard to find.
 *
 * Read-only by design. Nothing here edits or filters the log; a filtered view would be a second
 * place for the truth to differ from the file.
 */
export default function LogsScreen() {
  const runtime = useRuntime();
  const [text, setText] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!runtime) return;
    try {
      setText(await runtime.runLog());
      setError(undefined);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load]);

  const onShare = useCallback(async () => {
    try {
      await Share.share({ message: text ?? "" });
    } catch {
      // The user dismissing the share sheet is not an error worth reporting.
    }
  }, [text]);

  const onClear = useCallback(async () => {
    await runtime?.clearRunLog();
    await load();
  }, [runtime, load]);

  const empty = text !== undefined && text.trim() === "";

  return (
    <View style={styles.root}>
      <View style={styles.actions}>
        <Pressable style={styles.button} onPress={() => void load()}>
          <Text style={styles.buttonText}>{strings.logs.refresh}</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.primary]} onPress={() => void onShare()}>
          <Text style={[styles.buttonText, styles.primaryText]}>{strings.logs.share}</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => void onClear()}>
          <Text style={styles.buttonText}>{strings.logs.clear}</Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>{strings.logs.hint}</Text>

      {text === undefined ? (
        <ActivityIndicator style={styles.loading} color={theme.colors.accent} />
      ) : empty ? (
        <Text style={styles.empty}>{strings.logs.empty}</Text>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.log} selectable>
            {text}
          </Text>
        </ScrollView>
      )}

      {error ? <Text style={styles.error}>{strings.logs.failed(error)}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  actions: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  primary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  buttonText: { color: theme.colors.text, fontSize: 13 },
  primaryText: { color: theme.colors.background, fontWeight: "600" },
  hint: {
    color: theme.colors.textMuted,
    fontSize: 12,
    paddingHorizontal: 12,
    paddingBottom: 8,
    lineHeight: 17,
  },
  loading: { marginTop: 32 },
  empty: { color: theme.colors.textMuted, textAlign: "center", marginTop: 32, paddingHorizontal: 24 },
  scroll: { flex: 1, marginHorizontal: 12, marginBottom: 12 },
  scrollContent: { paddingBottom: 24 },
  // Monospace, and small: the value of this screen is being able to read many lines at once and
  // copy them out verbatim, not comfortable prose.
  log: { color: theme.colors.text, fontSize: 11, fontFamily: "monospace", lineHeight: 16 },
  error: { color: theme.colors.danger, padding: 12 },
});
