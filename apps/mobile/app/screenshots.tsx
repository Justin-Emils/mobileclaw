import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRuntime } from "@/ui/runtime-provider";
import { strings } from "@/ui/strings";
import { theme } from "@/ui/theme";
import {
  RETENTION_CHOICES,
  retentionMs,
  type ScreenshotFile,
} from "@/runtime/screenshots";

/**
 * The screenshots the agent took of other apps.
 *
 * ## Why this screen has to exist
 *
 * Those pictures live in an app-internal directory so the system gallery never indexes them and no
 * other app can read them. The cost is that *nothing else on the phone will ever show or tidy
 * them*: a screenshot the app cannot display is a file written and never read. This screen is the
 * other half of that decision.
 *
 * ## Two kinds of deletion, two different rules
 *
 * The user asked for exactly this split, and it is worth stating because it looks inconsistent:
 *
 *  - **Expired ones delete themselves, silently.** A retention window nobody enforces is not a
 *    policy, it is a wish. Asking for confirmation on a timer would train the user to tap through
 *    it, which is worse than not asking.
 *  - **Deleting by hand always asks.** These are the evidence of what an agent did to other
 *    people's conversations, and a mis-tap cannot be undone.
 *
 * ## `expired` is shown, not implied
 *
 * Each row says whether it is already past the window. Otherwise the retention setting would be a
 * number with no observable meaning, and the only way to learn what "3 days" does would be to
 * wait three days.
 */
export default function ScreenshotsScreen() {
  const runtime = useRuntime();

  const [files, setFiles] = useState<Array<ScreenshotFile & { expired: boolean }>>([]);
  const [bytes, setBytes] = useState(0);
  const [retention, setRetention] = useState(runtime.screenshotRetentionDays());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const store = runtime.screenshots();

  const refresh = useCallback(
    async (days = retention) => {
      if (!store) {
        setLoading(false);
        return;
      }
      try {
        const listing = await store.listing(retentionMs(days));
        setFiles(listing);
        const usage = await store.usage();
        setBytes(usage.bytes);
      } catch {
        // A directory that cannot be read is reported as empty plus the explanation below, not as
        // an error dialog: on a fresh install there is genuinely nothing there.
        setFiles([]);
        setBytes(0);
      }
      setLoading(false);
    },
    [store, retention],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const chooseRetention = useCallback(
    async (days: number) => {
      setRetention(days);
      await runtime.updateConfig({ screenshotRetentionDays: days });
      await refresh(days);
    },
    [refresh, runtime],
  );

  const sizeLabel = (value: number) =>
    value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;

  const removeOne = useCallback(
    (file: ScreenshotFile) => {
      const name = file.path.split("/").pop() ?? file.path;
      Alert.alert(strings.shots.confirmTitle, strings.shots.confirmOne(name), [
        { text: strings.shots.cancel, style: "cancel" },
        {
          text: strings.shots.confirmDelete,
          style: "destructive",
          onPress: () => {
            void (async () => {
              setBusy(true);
              try {
                await store?.remove(file.path);
                setNotice(strings.shots.deleted(1, sizeLabel(file.sizeBytes ?? 0)));
                await refresh();
              } catch (error) {
                setNotice(strings.shots.failed(error instanceof Error ? error.message : String(error)));
              }
              setBusy(false);
            })();
          },
        },
      ]);
    },
    [refresh, store],
  );

  const clearAll = useCallback(() => {
    Alert.alert(strings.shots.confirmTitle, strings.shots.confirmAll(files.length), [
      { text: strings.shots.cancel, style: "cancel" },
      {
        text: strings.shots.confirmClear,
        style: "destructive",
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              const result = await store?.clearAll();
              setNotice(strings.shots.cleared(result?.deleted ?? 0, sizeLabel(result?.freedBytes ?? 0)));
              await refresh();
            } catch (error) {
              setNotice(strings.shots.failed(error instanceof Error ? error.message : String(error)));
            }
            setBusy(false);
          })();
        },
      },
    ]);
  }, [files.length, refresh, store]);

  const expiredCount = files.filter((file) => file.expired).length;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  if (!store) {
    return (
      <View style={styles.center}>
        <Text style={styles.hint}>{strings.shots.needDir}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{strings.shots.title}</Text>
        <Text style={styles.hint}>{strings.shots.intro}</Text>
        <Text style={styles.usage}>{strings.shots.usage(files.length, sizeLabel(bytes))}</Text>
        {expiredCount > 0 ? (
          <Text style={styles.warning}>{strings.shots.expiredNote(expiredCount)}</Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{strings.shots.retentionTitle}</Text>
        <Text style={styles.hint}>{strings.shots.retentionHint}</Text>
        <View style={styles.choices}>
          {RETENTION_CHOICES.map((days) => {
            const active = days === retention;
            return (
              <Pressable
                key={days}
                onPress={() => void chooseRetention(days)}
                style={[styles.choice, active && styles.choiceActive]}
              >
                <Text style={[styles.choiceText, active && styles.choiceTextActive]}>
                  {days === 0 ? strings.shots.retentionForever : strings.shots.retentionDays(days)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      {files.length === 0 ? (
        <Text style={styles.hint}>{strings.shots.empty}</Text>
      ) : (
        <View style={styles.section}>
          {files.map((file) => (
            <View key={file.path} style={styles.row}>
              <Image source={{ uri: file.path }} style={styles.thumb} resizeMode="cover" />
              <View style={styles.rowBody}>
                <Text style={styles.rowTime}>
                  {file.modifiedMs === Number.POSITIVE_INFINITY || !Number.isFinite(file.modifiedMs)
                    ? strings.shots.timeUnknown
                    : new Date(file.modifiedMs).toLocaleString()}
                </Text>
                <Text style={styles.faint}>
                  {sizeLabel(file.sizeBytes ?? 0)}
                  {file.expired ? " · 已过期" : ""}
                </Text>
              </View>
              <Pressable
                onPress={() => removeOne(file)}
                disabled={busy}
                style={styles.deleteButton}
                accessibilityRole="button"
              >
                <Text style={styles.deleteText}>{strings.shots.deleteOne}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {files.length > 0 ? (
        <Pressable onPress={clearAll} disabled={busy} style={styles.clearButton}>
          <Text style={styles.clearText}>{strings.shots.clearAll}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.space(4), gap: theme.space(6), paddingBottom: theme.space(12) },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space(6) },
  section: { gap: theme.space(3) },
  sectionTitle: {
    color: theme.colors.textFaint,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  hint: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
  faint: { color: theme.colors.textFaint, fontSize: 11, lineHeight: 16 },
  usage: { color: theme.colors.text, fontSize: 13, fontWeight: "600" },
  warning: { color: theme.colors.warning, fontSize: 12, lineHeight: 18 },
  notice: { color: theme.colors.success, fontSize: 12, lineHeight: 18 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) },
  choice: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  choiceActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  choiceText: { color: theme.colors.textMuted, fontSize: 12 },
  choiceTextActive: { color: theme.colors.text, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    padding: theme.space(2),
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  thumb: { width: 56, height: 96, borderRadius: theme.radius.sm, backgroundColor: theme.colors.surfaceAlt },
  rowBody: { flex: 1, gap: theme.space(1) },
  rowTime: { color: theme.colors.text, fontSize: 12 },
  deleteButton: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.danger,
    backgroundColor: theme.colors.dangerSoft,
  },
  deleteText: { color: theme.colors.danger, fontSize: 12, fontWeight: "600" },
  clearButton: {
    alignItems: "center",
    paddingVertical: theme.space(3),
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.danger,
    backgroundColor: theme.colors.dangerSoft,
  },
  clearText: { color: theme.colors.danger, fontSize: 13, fontWeight: "600" },
});
