import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Link } from "expo-router";
import { useRuntime, useRuntimeState } from "@/ui/runtime-provider";
import { DEFAULT_PRESETS, type AppConfig } from "@/runtime/config";
import { strings } from "@/ui/strings";
import { theme } from "@/ui/theme";

type Diagnostics = Awaited<ReturnType<ReturnType<typeof useRuntime>["diagnostics"]>>;

/**
 * Provider and capability settings.
 *
 * The API key never round-trips through the config object: it goes straight to
 * SecureStore and the runtime keeps it in memory only.
 */
export default function SettingsScreen() {
  const state = useRuntimeState();
  const runtime = useRuntime();

  const [config, setConfig] = useState<AppConfig>(() => runtime.getConfig());
  const [apiKey, setApiKey] = useState("");
  const [keyLoaded, setKeyLoaded] = useState(() => runtime.hasApiKey());
  const [probe, setProbe] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [diag, setDiag] = useState<Diagnostics | undefined>();
  const [diagBusy, setDiagBusy] = useState(false);

  useEffect(() => {
    setConfig(runtime.getConfig());
    setKeyLoaded(runtime.hasApiKey());
  }, [runtime]);

  const patch = useCallback(
    async (next: Partial<AppConfig>) => {
      const updated = await runtime.updateConfig(next);
      setConfig(updated);
    },
    [runtime],
  );

  const saveKey = useCallback(async () => {
    if (apiKey.trim() === "") {
      Alert.alert(strings.settings.nothingToSaveTitle, strings.settings.nothingToSaveBody);
      return;
    }
    setBusy(true);
    try {
      // setApiKey re-reads the value from storage and reports what it found, so a
      // store that accepts writes but loses them is caught here rather than as a
      // mystery "no API key" during a later chat turn.
      const outcome = await runtime.setApiKey(apiKey);
      setKeyLoaded(runtime.hasApiKey());
      if (outcome.stored) setApiKey("");
      const diag = await runtime.diagnostics();
      setDiag(diag);
      Alert.alert(
        outcome.stored ? strings.settings.savedTitle : strings.settings.notSavedTitle,
        outcome.stored
          ? strings.settings.savedBody(outcome.detail)
          : strings.settings.notSavedBody(outcome.detail),
      );
    } catch (error) {
      Alert.alert(
        strings.settings.saveFailedTitle,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(false);
    }
  }, [apiKey, runtime]);

  const test = useCallback(async () => {
    setBusy(true);
    setProbe(strings.settings.testing);
    try {
      const result = await runtime.checkProvider();
      setProbe(result.ok ? strings.settings.testOk(result.message) : strings.settings.testFailed(result.message));
    } catch (error) {
      setProbe(strings.settings.testFailed(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }, [runtime]);

  const runDiagnostics = useCallback(async () => {
    setDiagBusy(true);
    try {
      setDiag(await runtime.diagnostics());
    } catch (error) {
      setProbe(strings.settings.selfCheckFailed(error instanceof Error ? error.message : String(error)));
    } finally {
      setDiagBusy(false);
    }
  }, [runtime]);

  const plugins = runtime.pluginStatus();
  const tools = runtime.toolNames();

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {state.degraded ? (
        <View style={styles.warnBox}>
          <Text style={styles.warnTitle}>{strings.settings.offlineWarningTitle}</Text>
          <Text style={styles.warnText}>{state.error}</Text>
        </View>
      ) : null}

      <Section title={strings.settings.modelProvider}>
        <View style={styles.chips}>
          {DEFAULT_PRESETS.map((preset) => (
            <Pressable
              key={preset.id}
              style={[styles.chip, config.provider.baseUrl === preset.baseUrl ? styles.chipActive : null]}
              onPress={() =>
                void patch({
                  provider: {
                    ...config.provider,
                    baseUrl: preset.baseUrl,
                    model: preset.model,
                    label: preset.label,
                  },
                })
              }
            >
              <Text style={styles.chipText}>{preset.label}</Text>
            </Pressable>
          ))}
        </View>

        <Field label={strings.settings.baseUrl}>
          <TextInput
            style={styles.input}
            value={config.provider.baseUrl}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(value) => void patch({ provider: { ...config.provider, baseUrl: value } })}
          />
        </Field>
        <Field label={strings.settings.model}>
          <TextInput
            style={styles.input}
            value={config.provider.model}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(value) => void patch({ provider: { ...config.provider, model: value } })}
          />
        </Field>
        <Field label={strings.settings.maxSteps}>
          <TextInput
            style={styles.input}
            value={String(config.provider.maxSteps)}
            keyboardType="number-pad"
            onChangeText={(value) => {
              const parsed = Number.parseInt(value, 10);
              if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 50) {
                void patch({ provider: { ...config.provider, maxSteps: parsed } });
              }
            }}
          />
        </Field>
        <Field label={strings.settings.temperature}>
          <TextInput
            style={styles.input}
            value={String(config.provider.temperature)}
            keyboardType="decimal-pad"
            onChangeText={(value) => {
              const parsed = Number.parseFloat(value);
              if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2) {
                void patch({ provider: { ...config.provider, temperature: parsed } });
              }
            }}
          />
        </Field>
      </Section>

      <Section title={strings.settings.apiKeySection}>
        <View style={[styles.statusBox, keyLoaded ? styles.statusOk : styles.statusBad]}>
          <Text style={[styles.statusText, keyLoaded ? styles.statusTextOk : styles.statusTextBad]}>
            {keyLoaded ? strings.settings.apiKeyLoaded : strings.settings.apiKeyMissing}
          </Text>
        </View>
        <Text style={styles.hint}>{strings.settings.apiKeyHint}</Text>
        <TextInput
          style={styles.input}
          value={apiKey}
          onChangeText={setApiKey}
          placeholder={strings.settings.apiKeyPlaceholder}
          placeholderTextColor={theme.colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <View style={styles.row}>
          <Pressable style={[styles.button, busy ? styles.buttonDisabled : null]} onPress={() => void saveKey()} disabled={busy}>
            <Text style={styles.buttonText}>{strings.settings.saveKey}</Text>
          </Pressable>
          <Pressable style={[styles.buttonGhost, busy ? styles.buttonDisabled : null]} onPress={() => void test()} disabled={busy}>
            <Text style={styles.buttonGhostText}>{strings.settings.testConnection}</Text>
          </Pressable>
        </View>
        {probe !== "" ? <Text style={styles.hint}>{probe}</Text> : null}
      </Section>

      <Section title={strings.settings.selfCheck}>
        <Text style={styles.hint}>{strings.settings.selfCheckHint}</Text>
        <Pressable
          style={[styles.buttonGhost, diagBusy ? styles.buttonDisabled : null]}
          onPress={() => void runDiagnostics()}
          disabled={diagBusy}
        >
          <Text style={styles.buttonGhostText}>
            {diagBusy ? strings.settings.checking : strings.settings.runSelfCheck}
          </Text>
        </Pressable>
        {diagBusy && diag === undefined ? <ActivityIndicator color={theme.colors.accent} /> : null}
        {diag ? (
          <View style={styles.diagBox}>
            <DiagRow
              label={strings.settings.diagApiKey}
              value={
                diag.apiKeyPresent
                  ? strings.settings.diagApiKeyPresent(diag.apiKeyLength)
                  : strings.settings.diagApiKeyMissing
              }
              ok={diag.apiKeyPresent}
            />
            <DiagRow label={strings.settings.diagSecretStore} value={diag.secretStore.detail} ok={diag.secretStore.ok} />
            <DiagRow label={strings.settings.diagProvider} value={`${diag.provider.label} · ${diag.provider.model}`} ok />
            <DiagRow label={strings.settings.diagBaseUrl} value={diag.provider.baseUrl} ok />
            <DiagRow label={strings.settings.diagTools} value={strings.settings.diagToolsValue(diag.tools)} ok={diag.tools > 0} />
            <DiagRow
              label={strings.settings.diagPlugins}
              value={strings.settings.diagPluginsValue(
                diag.plugins.filter((plugin) => plugin.status === "loaded").length,
                diag.plugins.length,
              )}
              ok={diag.plugins.every((plugin) => plugin.status === "loaded")}
            />
            <DiagRow
              label={strings.settings.diagRoots}
              value={diag.roots.join("\n") || strings.settings.diagNone}
              ok={diag.roots.length > 0}
            />
            {diag.plugins
              .filter((plugin) => plugin.status !== "loaded")
              .map((plugin) => (
                <DiagRow key={plugin.name} label={plugin.name} value={plugin.error ?? plugin.status} ok={false} />
              ))}
          </View>
        ) : null}
      </Section>

      <Section title={strings.settings.capabilities}>
        <Link href="/permissions" asChild>
          <Pressable style={styles.buttonGhost}>
            <Text style={styles.buttonGhostText}>{strings.settings.openPermissions}</Text>
          </Pressable>
        </Link>
        <Text style={styles.hint}>
          {strings.settings.capabilitySummary(
            tools.length,
            plugins.filter((plugin) => plugin.status === "loaded").length,
          )}
        </Text>
        {plugins.map((plugin) => (
          <View key={plugin.name} style={styles.pluginRow}>
            <View style={[styles.dot, { backgroundColor: plugin.status === "loaded" ? theme.colors.success : theme.colors.danger }]} />
            <Text style={styles.pluginName}>{plugin.name}</Text>
            <Text style={styles.pluginMeta}>{plugin.status === "loaded" ? strings.settings.pluginToolCount(plugin.tools) : (plugin.error ?? plugin.status)}</Text>
          </View>
        ))}
      </Section>

      <Section title={strings.settings.agentBehaviour}>
        <Field label={strings.settings.systemPrompt}>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={config.systemPrompt ?? ""}
            multiline
            onChangeText={(value) => void patch({ systemPrompt: value === "" ? undefined : value })}
            placeholder={strings.settings.systemPromptPlaceholder}
            placeholderTextColor={theme.colors.textFaint}
          />
        </Field>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

/** One line of the self-check panel: label, value, and a pass/fail marker. */
function DiagRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <View style={styles.diagRow}>
      <Text style={[styles.diagMark, { color: ok ? theme.colors.success : theme.colors.danger }]}>
        {ok ? "✓" : "✗"}
      </Text>
      <Text style={styles.diagLabel}>{label}</Text>
      <Text style={styles.diagValue}>{value}</Text>
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
  field: { gap: theme.space(1.5) },
  label: { color: theme.colors.textMuted, fontSize: 12 },
  input: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2.5),
    color: theme.colors.text,
    fontSize: 14,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) },
  chip: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
  },
  chipActive: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent, borderWidth: 1 },
  chipText: { color: theme.colors.text, fontSize: 12 },
  row: { flexDirection: "row", gap: theme.space(2), flexWrap: "wrap" },
  button: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2.5),
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  buttonGhost: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2.5),
  },
  buttonGhostText: { color: theme.colors.text, fontWeight: "600", fontSize: 13 },
  hint: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
  strong: { color: theme.colors.text, fontWeight: "600" },
  statusBox: {
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2.5),
    borderWidth: 1,
  },
  statusOk: { backgroundColor: "rgba(63,199,138,0.12)", borderColor: theme.colors.success },
  statusBad: { backgroundColor: theme.colors.dangerSoft, borderColor: theme.colors.danger },
  statusText: { fontSize: 13, fontWeight: "600" },
  statusTextOk: { color: theme.colors.success },
  statusTextBad: { color: theme.colors.danger },
  diagBox: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.space(3),
    gap: theme.space(2),
  },
  diagRow: { flexDirection: "row", alignItems: "flex-start", gap: theme.space(2) },
  diagMark: { fontSize: 12, fontWeight: "700", width: 14 },
  diagLabel: { color: theme.colors.textMuted, fontSize: 12, width: 96 },
  diagValue: { color: theme.colors.text, fontSize: 12, flex: 1, fontFamily: theme.font.mono },
  pluginRow: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pluginName: { color: theme.colors.text, fontSize: 12, fontFamily: theme.font.mono, flex: 1 },
  pluginMeta: { color: theme.colors.textMuted, fontSize: 11 },
  warnBox: {
    backgroundColor: theme.colors.dangerSoft,
    borderRadius: theme.radius.md,
    padding: theme.space(3),
    gap: theme.space(1),
  },
  warnTitle: { color: theme.colors.danger, fontWeight: "600", fontSize: 13 },
  warnText: { color: theme.colors.text, fontSize: 12 },
});
