import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { RISK_LEVELS, type RiskLevel } from "@mobileclaw/core";
import { useRuntime } from "@/ui/runtime-provider";
import { DEFAULT_PERMISSIONS, type AppConfig } from "@/runtime/config";
import { riskLabel, strings } from "@/ui/strings";
import { riskColor, theme } from "@/ui/theme";

type Mode = "allow" | "ask" | "deny";
const MODES: Mode[] = ["allow", "ask", "deny"];

/** 三态按钮的中文标签。 */
const MODE_LABELS: Record<Mode, string> = {
  allow: strings.permissions.modeAllow,
  ask: strings.permissions.modeAsk,
  deny: strings.permissions.modeDeny,
};

/**
 * Permission matrix.
 *
 * Deliberately per-risk rather than per-tool: a phone agent's real question is
 * "may you write to my storage?" and "may you run commands?", not "may you call
 * fs_write". Per-tool session grants are handled by the approval sheet.
 */
export default function PermissionsScreen() {
  const runtime = useRuntime();
  const [config, setConfig] = useState<AppConfig>(() => runtime.getConfig());
  const [rootDraft, setRootDraft] = useState("");

  useEffect(() => {
    setConfig(runtime.getConfig());
  }, [runtime]);

  const patch = useCallback(
    async (next: Partial<AppConfig>) => {
      const updated = await runtime.updateConfig(next);
      setConfig(updated);
    },
    [runtime],
  );

  const setMode = useCallback(
    async (risk: RiskLevel, mode: Mode) => {
      const permissions = {
        ...config.permissions,
        riskModes: { ...config.permissions.riskModes, [risk]: mode },
      };
      await patch({ permissions });
    },
    [config.permissions, patch],
  );

  const addRoot = useCallback(async () => {
    const root = rootDraft.trim();
    if (root === "") return;
    setRootDraft("");
    await patch({ roots: [...new Set([...config.roots, root])] });
  }, [config.roots, patch, rootDraft]);

  const removeRoot = useCallback(
    async (root: string) => {
      await patch({ roots: config.roots.filter((value) => value !== root) });
    },
    [config.roots, patch],
  );

  const resetDefaults = useCallback(async () => {
    await patch({ permissions: DEFAULT_PERMISSIONS });
  }, [patch]);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Section title={strings.permissions.riskPolicy} hint={strings.permissions.riskPolicyHint}>
        {RISK_LEVELS.map((risk) => {
          const mode = config.permissions.riskModes?.[risk] ?? config.permissions.defaultMode;
          return (
            <View key={risk} style={styles.riskRow}>
              <View style={styles.riskLabel}>
                <View style={[styles.dot, { backgroundColor: riskColor(risk) }]} />
                <Text style={styles.riskText}>{riskLabel(risk)}</Text>
              </View>
              <View style={styles.segment}>
                {MODES.map((candidate) => (
                  <Pressable
                    key={candidate}
                    style={[styles.segmentItem, mode === candidate ? styles.segmentActive : null]}
                    onPress={() => void setMode(risk, candidate)}
                  >
                    <Text style={[styles.segmentText, mode === candidate ? styles.segmentTextActive : null]}>
                      {MODE_LABELS[candidate]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          );
        })}
        <Pressable style={styles.ghost} onPress={() => void resetDefaults()}>
          <Text style={styles.ghostText}>{strings.permissions.resetDefaults}</Text>
        </Pressable>
      </Section>

      <Section title={strings.permissions.roots} hint={strings.permissions.rootsHint}>
        {config.roots.map((root) => (
          <View key={root} style={styles.rootRow}>
            <Text style={styles.rootText} numberOfLines={1}>
              {root}
            </Text>
            <Pressable onPress={() => void removeRoot(root)}>
              <Text style={styles.remove}>{strings.common.remove}</Text>
            </Pressable>
          </View>
        ))}
        <View style={styles.rootAdd}>
          <TextInput
            style={[styles.input, styles.rootInput]}
            value={rootDraft}
            onChangeText={setRootDraft}
            placeholder={strings.permissions.rootsPlaceholder}
            placeholderTextColor={theme.colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={styles.button} onPress={() => void addRoot()}>
            <Text style={styles.buttonText}>{strings.common.add}</Text>
          </Pressable>
        </View>
      </Section>

      <Section title={strings.permissions.registeredTools} hint={strings.permissions.registeredToolsHint}>
        <View style={styles.toolWrap}>
          {runtime.toolNames().map((name) => (
            <View key={name} style={styles.toolChip}>
              <Text style={styles.toolChipText}>{name}</Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title={strings.permissions.limits} hint={strings.permissions.limitsHint}>
        <Text style={styles.note}>{strings.permissions.limitAllFiles}</Text>
        <Text style={styles.note}>{strings.permissions.limitExec}</Text>
        <Text style={styles.note}>{strings.permissions.limitShizuku}</Text>
        <Text style={styles.note}>{strings.permissions.limitAccessibility}</Text>
      </Section>
    </ScrollView>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.space(4), gap: theme.space(6), paddingBottom: theme.space(12) },
  section: { gap: theme.space(3) },
  sectionTitle: {
    color: theme.colors.textFaint,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  hint: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
  riskRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space(3) },
  riskLabel: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  dot: { width: 8, height: 8, borderRadius: 4 },
  riskText: { color: theme.colors.text, fontSize: 13 },
  segment: {
    flexDirection: "row",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.pill,
    padding: 2,
  },
  segmentItem: { paddingHorizontal: theme.space(3), paddingVertical: theme.space(1.5), borderRadius: theme.radius.pill },
  segmentActive: { backgroundColor: theme.colors.accentSoft },
  segmentText: { color: theme.colors.textMuted, fontSize: 12 },
  segmentTextActive: { color: theme.colors.text, fontWeight: "600" },
  ghost: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  ghostText: { color: theme.colors.text, fontSize: 12 },
  rootRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space(3),
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2.5),
  },
  rootText: { color: theme.colors.text, fontSize: 12, fontFamily: theme.font.mono, flexShrink: 1 },
  remove: { color: theme.colors.danger, fontSize: 12 },
  rootAdd: { flexDirection: "row", gap: theme.space(2) },
  input: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2.5),
    color: theme.colors.text,
    fontSize: 14,
  },
  rootInput: { flex: 1, fontFamily: theme.font.mono, fontSize: 12 },
  button: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(4),
    justifyContent: "center",
  },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  toolWrap: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) },
  toolChip: {
    backgroundColor: theme.colors.tool,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space(2.5),
    paddingVertical: theme.space(1.5),
  },
  toolChipText: { color: theme.colors.textMuted, fontSize: 11, fontFamily: theme.font.mono },
  note: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
});
