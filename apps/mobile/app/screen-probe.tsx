import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ScreenProbeRecord, ScreenProbeStatus } from "@mobileclaw/capabilities";
import { useRuntime } from "@/ui/runtime-provider";
import { strings } from "@/ui/strings";
import { createThemedStyles, type ThemeColors, useTheme, useThemedStyles } from "@/ui/theme-tokens";

/**
 * Which installed apps can actually be automated through the semantic tree.
 *
 * The question cannot be answered from documentation — whether an app publishes a readable
 * accessibility tree depends on its version, the particular screen, and the account's state.
 * So the phone answers it: open the app, read the screen, record the verdict, and keep it.
 *
 * Three things shape this screen:
 *
 *  - **The user picks.** Probing every installed app would open each one in turn, which takes
 *    a long time and looks like the phone is being taken over. Ticking boxes keeps that a
 *    deliberate act.
 *  - **The probe is slow on purpose.** Each entry is launched and then given two seconds to
 *    settle, because reading too early records "publishes nothing" for an app that was merely
 *    still starting — a false negative that then gets cached.
 *  - **Results are grouped by what they mean, not by count.** A protected screen and an empty
 *    one both report zero elements, and they call for opposite next moves; the advice line
 *    under each status is the part that makes the table useful.
 */
export default function ScreenProbeScreen() {
  const styles = useThemedStyles(themedStyles);
  const { theme } = useTheme();
  const runtime = useRuntime();

  const [apps, setApps] = useState<{ packageId: string; label: string }[]>([]);
  const [inventory, setInventory] = useState<ScreenProbeRecord[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [shizukuReady, setShizukuReady] = useState<boolean | undefined>(undefined);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [lastRun, setLastRun] = useState<ScreenProbeRecord[]>();
  const abort = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(async () => {
    const [installed, cached] = await Promise.all([runtime.listInstalledApps(), runtime.probeInventory()]);
    setApps(installed);
    setInventory(cached);
    setLoading(false);
  }, [runtime]);

  useEffect(() => {
    void refresh();
    // Whether the privileged backend is up decides whether this screen can do anything, so it
    // is asked rather than assumed: without it every probe would fail one app at a time.
    void (async () => {
      const diagnostics = await runtime.diagnostics();
      setShizukuReady(diagnostics.automation?.available ?? false);
    })();
  }, [refresh, runtime]);

  const toggle = useCallback((packageId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(packageId)) next.delete(packageId);
      else next.add(packageId);
      return next;
    });
  }, []);

  const run = useCallback(async () => {
    const targets = [...selected];
    if (targets.length === 0) return;
    const controller = new AbortController();
    abort.current = controller;
    setLastRun(undefined);
    setProgress({ done: 0, total: targets.length });

    try {
      const report = await runtime.probeScreens(
        targets,
        {},
        {
          signal: controller.signal,
          onProgress: (event) => setProgress({ done: event.index, total: event.total }),
        },
      );
      setLastRun(report.records);
    } catch {
      // A cancelled run still wrote whatever it managed to probe, so the inventory below is
      // the authority on what happened rather than this list.
    } finally {
      abort.current = undefined;
      setProgress(undefined);
      await refresh();
    }
  }, [refresh, runtime, selected]);

  const stop = useCallback(() => {
    abort.current?.abort();
  }, []);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return apps;
    return apps.filter(
      (app) => app.label.toLowerCase().includes(needle) || app.packageId.toLowerCase().includes(needle),
    );
  }, [apps, filter]);

  const cachedPackages = useMemo(
    () => new Set(inventory.map((record) => record.packageId)),
    [inventory],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.accent} />
        <Text style={styles.note}>{strings.probe.intro}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.note}>{strings.probe.intro}</Text>

      {shizukuReady === false ? <Text style={styles.warning}>{strings.probe.needShizuku}</Text> : null}
      {apps.length === 0 ? <Text style={styles.warning}>{strings.probe.noApps}</Text> : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{strings.probe.pickTitle}</Text>
        <Text style={styles.hint}>{strings.probe.pickHint}</Text>
        <TextInput
          style={styles.input}
          value={filter}
          onChangeText={setFilter}
          placeholder={strings.probe.filterPlaceholder}
          placeholderTextColor={theme.colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <ScrollView style={styles.list} nestedScrollEnabled>
          {filtered.map((app) => {
            const isSelected = selected.has(app.packageId);
            const probed = cachedPackages.has(app.packageId);
            return (
              <Pressable
                key={app.packageId}
                style={[styles.row, isSelected ? styles.rowSelected : null]}
                onPress={() => toggle(app.packageId)}
              >
                <View style={[styles.check, isSelected ? styles.checkOn : null]}>
                  {isSelected ? <Text style={styles.checkMark}>✓</Text> : null}
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.appLabel} numberOfLines={1}>
                    {app.label || app.packageId}
                  </Text>
                  <Text style={styles.appPackage} numberOfLines={1}>
                    {app.packageId}
                    {probed ? " · 已探测" : ""}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.actions}>
          <Text style={styles.selected}>{strings.probe.selected(selected.size)}</Text>
          {progress ? (
            <Pressable style={[styles.button, styles.stopButton]} onPress={stop}>
              <Text style={styles.stopText}>{strings.probe.stop}</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.button, selected.size === 0 ? styles.disabled : null]}
              disabled={selected.size === 0}
              onPress={() => void run()}
            >
              <Text style={styles.buttonText}>{strings.probe.run}</Text>
            </Pressable>
          )}
        </View>
        {progress ? (
          <View style={styles.progressRow}>
            <ActivityIndicator color={theme.colors.accent} size="small" />
            <Text style={styles.note}>
              {strings.probe.running(progress.done + 1, progress.total)}
            </Text>
          </View>
        ) : null}
        <Text style={styles.faint}>{strings.probe.settleNote}</Text>
      </View>

      {lastRun && lastRun.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{strings.probe.resultTitle}</Text>
          {lastRun.map((record) => (
            <ProbeRow key={`run-${record.packageId}`} record={record} />
          ))}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{strings.probe.inventoryTitle}</Text>
        <Text style={styles.hint}>{strings.probe.inventoryHint}</Text>
        {inventory.length === 0 ? (
          <Text style={styles.note}>{strings.probe.emptyInventory}</Text>
        ) : (
          inventory.map((record) => (
            <ProbeRow
              key={record.packageId}
              record={record}
              onForget={() => void runtime.forgetProbe(record.packageId).then(refresh)}
            />
          ))
        )}
      </View>
    </ScrollView>
  );
}

/** Status wording and the advice that makes the count mean something. */
const STATUS: Record<ScreenProbeStatus, { label: string; advice: string; tone: "good" | "warn" | "bad" }> = {
  readable: { label: strings.probe.statusReadable, advice: strings.probe.adviceReadable, tone: "good" },
  "labels-only": {
    label: strings.probe.statusLabelsOnly,
    advice: strings.probe.adviceLabelsOnly,
    tone: "warn",
  },
  empty: { label: strings.probe.statusEmpty, advice: strings.probe.adviceEmpty, tone: "warn" },
  blocked: { label: strings.probe.statusBlocked, advice: strings.probe.adviceBlocked, tone: "bad" },
  failed: { label: strings.probe.statusFailed, advice: strings.probe.adviceFailed, tone: "bad" },
};

/**
 * Tone colour for a probe result.
 *
 * A function of the palette, not a module constant: a constant would freeze whichever palette was
 * loaded first, which is the defect this whole change removes.
 */
function toneColor(colors: ThemeColors, tone: "good" | "warn" | "bad"): string {
  return tone === "good" ? colors.accent : tone === "warn" ? colors.warning : colors.danger;
}

function ProbeRow({ record, onForget }: { record: ScreenProbeRecord; onForget?: () => void }) {
  const styles = useThemedStyles(themedStyles);
  const { theme } = useTheme();
  const status = STATUS[record.status];
  return (
    <View style={styles.resultRow}>
      <View style={styles.resultHead}>
        <Text style={styles.appLabel} numberOfLines={1}>
          {record.label || record.packageId}
        </Text>
        <View style={[styles.statusPill, { borderColor: toneColor(theme.colors, status.tone) }]}>
          <Text style={[styles.statusText, { color: toneColor(theme.colors, status.tone) }]}>{status.label}</Text>
        </View>
      </View>
      <Text style={styles.appPackage} numberOfLines={1}>
        {record.packageId}
        {record.status === "failed" ? "" : ` · 元素 ${record.elements} / 可点 ${record.pressable}`}
      </Text>
      <Text style={styles.advice}>{record.error ? record.error : status.advice}</Text>
      {record.note ? <Text style={styles.faint}>{record.note}</Text> : null}
      {onForget ? (
        <Pressable onPress={onForget} style={styles.forget}>
          <Text style={styles.forgetText}>{strings.probe.forget}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const themedStyles = createThemedStyles((theme) => {
  const colors = theme.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    content: { padding: theme.space(4), gap: theme.space(6), paddingBottom: theme.space(12) },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.space(3), padding: theme.space(6) },
    section: { gap: theme.space(3) },
    sectionTitle: {
      color: colors.textFaint,
      fontSize: 11,
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    hint: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
    note: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
    faint: { color: colors.textFaint, fontSize: 11, lineHeight: 16 },
    warning: {
      color: colors.warning,
      fontSize: 12,
      lineHeight: 18,
      backgroundColor: colors.warningSoft ?? colors.surfaceAlt,
      padding: theme.space(3),
      borderRadius: theme.radius.md,
    },
    input: {
      backgroundColor: colors.surface,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.space(3),
      paddingVertical: theme.space(2.5),
      color: colors.text,
      fontSize: 14,
    },
    list: { maxHeight: 280 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.space(3),
      paddingVertical: theme.space(2.5),
      paddingHorizontal: theme.space(2),
      borderRadius: theme.radius.md,
    },
    rowSelected: { backgroundColor: colors.surfaceAlt },
    check: {
      width: 20,
      height: 20,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    checkMark: { color: "#fff", fontSize: 13, fontWeight: "700" },
    rowText: { flexShrink: 1 },
    appLabel: { color: colors.text, fontSize: 14 },
    appPackage: { color: colors.textFaint, fontSize: 11, fontFamily: theme.font.mono },
    actions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    selected: { color: colors.textMuted, fontSize: 12 },
    button: {
      backgroundColor: colors.accent,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.space(5),
      paddingVertical: theme.space(2.5),
    },
    buttonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
    disabled: { opacity: 0.4 },
    stopButton: { backgroundColor: colors.dangerSoft },
    stopText: { color: colors.danger, fontWeight: "600", fontSize: 13 },
    progressRow: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
    resultRow: {
      backgroundColor: colors.surface,
      borderRadius: theme.radius.md,
      padding: theme.space(3),
      gap: theme.space(1),
    },
    resultHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space(2) },
    statusPill: {
      borderWidth: 1,
      borderRadius: theme.radius.pill,
      paddingHorizontal: theme.space(2),
      paddingVertical: 1,
    },
    statusText: { fontSize: 10 },
    advice: { color: colors.text, fontSize: 12, lineHeight: 18 },
    forget: { alignSelf: "flex-start", paddingTop: theme.space(1) },
    forgetText: { color: colors.accent, fontSize: 12 },
  });
});
