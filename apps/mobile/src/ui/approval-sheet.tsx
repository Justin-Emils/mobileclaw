import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ApprovalBroker, PendingApproval } from "@/runtime/approval";
import { riskLabel, strings } from "@/ui/strings";
import { riskColor, theme } from "@/ui/theme";

/**
 * The permission prompt.
 *
 * Approvals are blocking by design: the agent loop is parked on a promise while
 * this modal is open, so the sheet always shows which tool, which risk and which
 * paths are involved. "Always allow" only affects the current session — a
 * phone agent should not accumulate silent, permanent grants.
 */
export function ApprovalSheet({ approvals }: { approvals?: ApprovalBroker }) {
  const [pending, setPending] = useState<PendingApproval[]>([]);

  useEffect(() => {
    if (!approvals) return;
    const sync = (): void => setPending(approvals.pending());
    sync();
    return approvals.subscribe(sync);
  }, [approvals]);

  const current = pending[0];
  if (!approvals || !current) return null;

  const answer = (approved: boolean, remember: boolean): void => {
    approvals.answer(current.id, { approved, ...(remember ? { remember: true } : {}) });
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => answer(false, false)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.kicker}>{strings.approval.kicker}</Text>
          <View style={styles.titleRow}>
            <Text style={styles.title}>{current.request.tool}</Text>
            <View style={[styles.risk, { borderColor: riskColor(current.request.risk) }]}>
              <Text style={[styles.riskText, { color: riskColor(current.request.risk) }]}>
                {riskLabel(current.request.risk)}
              </Text>
            </View>
          </View>

          <Text style={styles.reason}>{current.request.reason ?? strings.approval.defaultReason}</Text>

          <ScrollView style={styles.detailBox} contentContainerStyle={styles.detailContent}>
            <Text style={styles.detailText}>{current.detail}</Text>
            {current.request.paths && current.request.paths.length > 0 ? (
              <Text style={styles.paths}>{current.request.paths.join("\n")}</Text>
            ) : null}
          </ScrollView>

          {pending.length > 1 ? (
            <Text style={styles.queue}>{strings.approval.moreWaiting(pending.length - 1)}</Text>
          ) : null}

          <View style={styles.actions}>
            <Pressable style={[styles.button, styles.deny]} onPress={() => answer(false, false)}>
              <Text style={styles.denyText}>{strings.approval.deny}</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.once]} onPress={() => answer(true, false)}>
              <Text style={styles.onceText}>{strings.approval.allowOnce}</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.always]} onPress={() => answer(true, true)}>
              <Text style={styles.alwaysText}>{strings.approval.allowAlways}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.space(4),
  },
  sheet: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.space(5),
    gap: theme.space(3),
    borderColor: theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  kicker: {
    color: theme.colors.textFaint,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  title: { color: theme.colors.text, fontSize: 18, fontWeight: "600" },
  risk: {
    borderWidth: 1,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space(2),
    paddingVertical: 2,
  },
  riskText: { fontSize: 11, textTransform: "uppercase" },
  reason: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 19 },
  detailBox: {
    maxHeight: 160,
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.md,
  },
  detailContent: { padding: theme.space(3), gap: theme.space(2) },
  detailText: { color: theme.colors.text, fontSize: 13, fontFamily: theme.font.mono },
  paths: { color: theme.colors.textMuted, fontSize: 12, fontFamily: theme.font.mono },
  queue: { color: theme.colors.warning, fontSize: 12 },
  actions: { flexDirection: "row", gap: theme.space(2), justifyContent: "flex-end", flexWrap: "wrap" },
  button: {
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2.5),
    borderRadius: theme.radius.md,
  },
  deny: { backgroundColor: theme.colors.dangerSoft },
  denyText: { color: theme.colors.danger, fontWeight: "600" },
  once: { backgroundColor: theme.colors.surfaceAlt },
  onceText: { color: theme.colors.text, fontWeight: "600" },
  always: { backgroundColor: theme.colors.accent },
  alwaysText: { color: "#fff", fontWeight: "600" },
});
