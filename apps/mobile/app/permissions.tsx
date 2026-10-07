import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { RISK_LEVELS, type RiskLevel } from "@mobileclaw/core";
import { useRuntime } from "@/ui/runtime-provider";
import { DEFAULT_PERMISSIONS, type AppConfig } from "@/runtime/config";
import { riskColor, theme } from "@/ui/theme";

type Mode = "allow" | "ask" | "deny";
const MODES: Mode[] = ["allow", "ask", "deny"];

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
      <Section
        title="Risk policy"
        hint="Read and network are safe defaults. Anything that writes, executes or touches another app prompts first."
      >
        {RISK_LEVELS.map((risk) => {
          const mode = config.permissions.riskModes?.[risk] ?? config.permissions.defaultMode;
          return (
            <View key={risk} style={styles.riskRow}>
              <View style={styles.riskLabel}>
                <View style={[styles.dot, { backgroundColor: riskColor(risk) }]} />
                <Text style={styles.riskText}>{risk}</Text>
              </View>
              <View style={styles.segment}>
                {MODES.map((candidate) => (
                  <Pressable
                    key={candidate}
                    style={[styles.segmentItem, mode === candidate ? styles.segmentActive : null]}
                    onPress={() => void setMode(risk, candidate)}
                  >
                    <Text style={[styles.segmentText, mode === candidate ? styles.segmentTextActive : null]}>
                      {candidate}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          );
        })}
        <Pressable style={styles.ghost} onPress={() => void resetDefaults()}>
          <Text style={styles.ghostText}>Reset to recommended defaults</Text>
        </Pressable>
      </Section>

      <Section
        title="Storage roots"
        hint="The path guard refuses anything outside these directories, whatever the model asks for. On Android, shared storage requires all-files access from system settings."
      >
        {config.roots.map((root) => (
          <View key={root} style={styles.rootRow}>
            <Text style={styles.rootText} numberOfLines={1}>
              {root}
            </Text>
            <Pressable onPress={() => void removeRoot(root)}>
              <Text style={styles.remove}>remove</Text>
            </Pressable>
          </View>
        ))}
        <View style={styles.rootAdd}>
          <TextInput
            style={[styles.input, styles.rootInput]}
            value={rootDraft}
            onChangeText={setRootDraft}
            placeholder="/storage/emulated/0/Documents"
            placeholderTextColor={theme.colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={styles.button} onPress={() => void addRoot()}>
            <Text style={styles.buttonText}>Add</Text>
          </Pressable>
        </View>
      </Section>

      <Section
        title="Registered tools"
        hint="Tools come from plugins; disabling a plugin removes its tools from the model's schema entirely."
      >
        <View style={styles.toolWrap}>
          {runtime.toolNames().map((name) => (
            <View key={name} style={styles.toolChip}>
              <Text style={styles.toolChipText}>{name}</Text>
            </View>
          ))}
        </View>
      </Section>

      <Section
        title="Hard limits worth knowing"
        hint="These are OS-level constraints, not settings."
      >
        <Text style={styles.note}>
          • All-files access has no permission dialog: the user must enable it in system settings, and Google
          Play does not accept an agent app for it — side-load, F-Droid or GitHub builds are the intended channels.
        </Text>
        <Text style={styles.note}>
          • Android 10+ forbids executing files from app storage, so bundled tools must ship as native libraries
          inside the APK. Shell access goes through Termux or Shizuku instead.
        </Text>
        <Text style={styles.note}>
          • Shizuku runs with shell identity (uid 2000), not root, and must be restarted after every reboot.
        </Text>
        <Text style={styles.note}>
          • Accessibility-based UI automation is disallowed for automation tools by Play policy, and Android 17's
          Advanced Protection Mode blocks it for non-accessibility apps.
        </Text>
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
