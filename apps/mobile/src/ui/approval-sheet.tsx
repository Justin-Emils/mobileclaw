import { useEffect, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { CONFIRM_PLAN_TOOL } from "@mobileclaw/capabilities";
import type { ApprovalBroker, PendingApproval } from "@/runtime/approval";
import type { Point } from "@/ui/point-mapping";
import { PointPicker } from "@/ui/point-picker";
import { riskLabel, strings } from "@/ui/strings";
import { riskColor, theme } from "@/ui/theme";

/**
 * The permission prompt.
 *
 * Approvals are blocking by design: the agent loop is parked on a promise while this
 * modal is open, so the sheet always shows which tool, which risk and which paths are
 * involved.
 *
 * Two things here are not decoration:
 *
 *  - A tool declaring `neverRemember` gets no "always allow" button, and the gate
 *    refuses the grant even if something asks for it. Changing what is on the screen is
 *    a decision per press; the explanation appears where the button would have been,
 *    because a button vanishing with no reason reads as a bug.
 *  - A tool declaring `pickPoint` cannot be approved until the user has placed the
 *    point. The model cannot see the screen, so a tap without one of these would run on
 *    a coordinate nobody chose.
 */
export function ApprovalSheet({ approvals }: { approvals?: ApprovalBroker }) {
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [picking, setPicking] = useState(false);
  const [point, setPoint] = useState<Point>();

  useEffect(() => {
    if (!approvals) return;
    const sync = (): void => setPending(approvals.pending());
    sync();
    return approvals.subscribe(sync);
  }, [approvals]);

  // A new request means a new decision: carrying a point over from the previous one
  // would silently aim at a coordinate chosen for a different screen.
  const currentId = pending[0]?.id;
  useEffect(() => {
    setPoint(undefined);
    setPicking(false);
  }, [currentId]);

  const current = pending[0];
  if (!approvals || !current) return null;

  const neverRemember = current.request.definition?.neverRemember === true;
  const pick = current.request.definition?.pickPoint;
  const requestInput = current.request.input as Record<string, unknown> | undefined;
  const image =
    pick && requestInput && typeof requestInput[pick.image] === "string"
      ? (requestInput[pick.image] as string)
      : undefined;

  const answer = (approved: boolean, remember: boolean, extra?: Record<string, unknown>): void => {
    approvals.answer(current.id, {
      approved,
      ...(remember ? { remember: true } : {}),
      ...(extra ? { input: extra } : {}),
    });
  };

  /**
   * The task restatement.
   *
   * A different question from every other entry in this queue, and it is asked first, so it
   * gets its own body rather than being rendered as a tool call with unusual arguments. The
   * permission sheet asks "may this step run?"; this asks "is this the thing you wanted?" —
   * and it is the only prompt in the app whose answer can save the user from eight correctly
   * executed, entirely wrong steps.
   */
  if (current.request.tool === CONFIRM_PLAN_TOOL) {
    const plan = (current.request.input ?? {}) as {
      restatement?: string;
      steps?: string[];
      apps?: string[];
      changes?: string[];
      stepEstimate?: number;
    };
    const changes = plan.changes ?? [];
    const estimate = typeof plan.stepEstimate === "number" ? plan.stepEstimate : undefined;
    return (
      <Modal transparent animationType="fade" visible onRequestClose={() => answer(false, false)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.kicker}>{strings.plan.kicker}</Text>
            <Text style={styles.planRestatement}>{plan.restatement ?? current.detail}</Text>

            {plan.steps && plan.steps.length > 0 ? (
              <View style={styles.planBlock}>
                <Text style={styles.planBlockTitle}>{strings.plan.stepsTitle}</Text>
                {plan.steps.map((step, index) => (
                  <Text key={`${index}-${step}`} style={styles.planStep}>
                    {index + 1}. {step}
                  </Text>
                ))}
              </View>
            ) : null}

            {plan.apps && plan.apps.length > 0 ? (
              <View style={styles.planBlock}>
                <Text style={styles.planBlockTitle}>{strings.plan.appsTitle}</Text>
                <Text style={styles.planApps}>{plan.apps.join(" · ")}</Text>
              </View>
            ) : null}

            {changes.length > 0 ? (
              <View style={styles.planBlock}>
                <Text style={[styles.planBlockTitle, styles.planDanger]}>
                  {strings.plan.changesTitle}
                </Text>
                {changes.map((change, index) => (
                  <Text key={`${index}-${change}`} style={[styles.planStep, styles.planDanger]}>
                    • {change}
                  </Text>
                ))}
                <Text style={styles.planNote}>{strings.plan.changesNote}</Text>
              </View>
            ) : (
              <View style={styles.planBlock}>
                <Text style={styles.planBlockTitle}>{strings.plan.readOnlyTitle}</Text>
                <Text style={styles.planNote}>{strings.plan.readOnlyNote}</Text>
              </View>
            )}

            {estimate !== undefined ? (
              // Shown because it is a cost, and because it can exceed the configured limit:
              // a run that quietly takes four times the steps the settings screen promises is
              // the kind of thing a user only discovers on a bill.
              <View style={styles.planBlock}>
                <Text style={styles.planBlockTitle}>{strings.plan.costTitle}</Text>
                <Text style={styles.planStep}>{strings.plan.costEstimate(estimate)}</Text>
                <Text style={styles.planNote}>{strings.plan.costNote}</Text>
              </View>
            ) : null}

            <View style={styles.actions}>
              <Pressable style={[styles.button, styles.deny]} onPress={() => answer(false, false)}>
                <Text style={styles.denyText}>{strings.plan.cancel}</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.always]} onPress={() => answer(true, false)}>
                <Text style={styles.alwaysText}>{strings.plan.confirm}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    );
  }

  /** The chosen point, expressed in the field names the tool declared. */
  const chosenInput =
    pick && point ? { [pick.x]: point.x, [pick.y]: point.y } : undefined;
  const needsPoint = Boolean(pick) && !point;

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

          {image ? (
            <View style={styles.evidenceBox}>
              <Image source={{ uri: image }} style={styles.evidence} resizeMode="contain" />
              <Pressable style={[styles.button, styles.pick]} onPress={() => setPicking(true)}>
                <Text style={styles.pickText}>{strings.automation.pickFromCapture}</Text>
              </Pressable>
              <Text style={styles.pointReadout}>
                {point
                  ? strings.automation.pickCoordinates(
                      Math.round(point.x * 100),
                      Math.round(point.y * 100),
                    )
                  : strings.automation.pickNeedsPoint}
              </Text>
            </View>
          ) : null}

          <ScrollView style={styles.detailBox} contentContainerStyle={styles.detailContent}>
            <Text style={styles.detailText}>{current.detail}</Text>
            {current.request.paths && current.request.paths.length > 0 ? (
              <Text style={styles.paths}>{current.request.paths.join("\n")}</Text>
            ) : null}
          </ScrollView>

          {neverRemember ? (
            <Text style={styles.neverRemember}>{strings.approval.neverRememberNote}</Text>
          ) : null}

          {pending.length > 1 ? (
            <Text style={styles.queue}>{strings.approval.moreWaiting(pending.length - 1)}</Text>
          ) : null}

          <View style={styles.actions}>
            <Pressable style={[styles.button, styles.deny]} onPress={() => answer(false, false)}>
              <Text style={styles.denyText}>{strings.approval.deny}</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.once, needsPoint ? styles.disabled : null]}
              disabled={needsPoint}
              onPress={() => answer(true, false, chosenInput)}
            >
              <Text style={styles.onceText}>{strings.approval.allowOnce}</Text>
            </Pressable>
            {neverRemember ? null : (
              <Pressable
                style={[styles.button, styles.always, needsPoint ? styles.disabled : null]}
                disabled={needsPoint}
                onPress={() => answer(true, true, chosenInput)}
              >
                <Text style={styles.alwaysText}>{strings.approval.allowAlways}</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {image && pick ? (
        <PointPicker
          visible={picking}
          image={image}
          onConfirm={(next) => {
            setPoint(next);
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      ) : null}
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
  evidenceBox: { gap: theme.space(2) },
  evidence: {
    width: "100%",
    aspectRatio: 9 / 19,
    maxHeight: 220,
    borderRadius: theme.radius.md,
    borderColor: theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pointReadout: { color: theme.colors.textMuted, fontSize: 12 },
  detailBox: {
    maxHeight: 160,
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.md,
  },
  detailContent: { padding: theme.space(3), gap: theme.space(2) },
  detailText: { color: theme.colors.text, fontSize: 13, fontFamily: theme.font.mono },
  paths: { color: theme.colors.textMuted, fontSize: 12, fontFamily: theme.font.mono },
  neverRemember: { color: theme.colors.warning, fontSize: 12, lineHeight: 18 },
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
  pick: { backgroundColor: theme.colors.surfaceAlt },
  pickText: { color: theme.colors.text, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  planRestatement: { color: theme.colors.text, fontSize: 16, fontWeight: "600", lineHeight: 24 },
  planBlock: { gap: theme.space(1.5) },
  planBlockTitle: {
    color: theme.colors.textFaint,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  planStep: { color: theme.colors.text, fontSize: 13, lineHeight: 20 },
  planApps: { color: theme.colors.textMuted, fontSize: 12, fontFamily: theme.font.mono },
  planDanger: { color: theme.colors.warning },
  planNote: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
});
