import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Link, useFocusEffect } from "expo-router";
import type { AgentEvent, TranscriptEntry } from "@mobileclaw/core";
import { useRuntime, useRuntimeState } from "@/ui/runtime-provider";
import { ApprovalSheet } from "@/ui/approval-sheet";
import { ToolCard } from "@/ui/tool-card";
import { renderContent } from "@/ui/render";
import type { AllFilesAccessReport } from "@/runtime/services/permissions";
import { strings } from "@/ui/strings";
import { theme } from "@/ui/theme";

interface Bubble {
  id: string;
  role: "user" | "assistant" | "notice";
  text: string;
  streaming?: boolean;
  level?: "info" | "warn" | "error";
}

/**
 * The chat screen.
 *
 * Rendering model: transcript entries become bubbles/tool cards in order, while
 * the in-flight assistant message is a separate bubble updated by stream deltas.
 * Keeping them separate means a long answer renders incrementally without
 * rewriting the whole list.
 */
export default function ChatScreen() {
  const state = useRuntimeState();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [tools, setTools] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [status, setStatus] = useState<string>("");
  /** Set when a run stopped at the step limit, so the UI can offer to resume. */
  const [canContinue, setCanContinue] = useState(false);
  /**
   * Whether shared storage is actually readable.
   *
   * Surfaced as a banner because the failure is otherwise invisible and actively
   * misleading: without all-files access every shared-storage folder lists as empty,
   * so the agent reports "no files" and the user blames the agent.
   */
  const [storageAccess, setStorageAccess] = useState<AllFilesAccessReport | undefined>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const listRef = useRef<FlatList<Bubble>>(null);

  const runtime = state.runtime;
  const ready = state.status === "ready" && runtime !== undefined;

  // Re-probe on focus: the user grants access in system settings and comes back.
  useFocusEffect(
    useCallback(() => {
      if (!ready || !runtime) return;
      let cancelled = false;
      void runtime.checkStorageAccess().then((report) => {
        if (!cancelled) setStorageAccess(report);
      });
      return () => {
        cancelled = true;
      };
    }, [ready, runtime]),
  );

  useEffect(() => {
    if (!ready || !state.error) return;
    setBubbles((current) => [
      ...current,
      {
        id: "boot-warning",
        role: "notice",
        level: "warn",
        text: `${strings.chat.offlineDemo}: ${state.error}`,
      },
    ]);
  }, [ready, state.error]);

  /**
   * Send one user turn. `override` lets the "continue" button send a canned
   * message through the same path instead of duplicating the run logic.
   */
  const send = useCallback(async (override?: string) => {
    const text = (override ?? draft).trim();
    if (!runtime || text === "" || running) return;

    setDraft("");
    setRunning(true);
    setStatus("");
    setCanContinue(false);
    const userBubble: Bubble = { id: `u_${Date.now()}`, role: "user", text };
    const assistantId = `a_${Date.now()}`;
    setBubbles((current) => [
      ...current,
      userBubble,
      { id: assistantId, role: "assistant", text: "", streaming: true },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;
    const toolsThisRun: TranscriptEntry[] = [];

    try {
      const stream = runtime.send(text, {
        ...(conversationId ? { conversationId } : {}),
        signal: controller.signal,
        onConversation: (conversation) => setConversationId(conversation.id),
      });

      while (true) {
        const step = await stream.next();
        if (step.done) {
          const result = step.value;
          if (result.error) {
            const raw = result.error.message;
            // Turn the two failures a new user actually hits into instructions
            // rather than a dead end. A missing key is a setup step, not a bug.
            const text = raw.includes("no API key configured")
              ? strings.errors.missingApiKey
              : raw.includes("HTTP 401") || raw.includes("HTTP 403")
                ? strings.errors.unauthorized(raw)
                : raw;
            setBubbles((current) => [
              ...current,
              {
                id: `e_${Date.now()}`,
                role: "notice",
                level: "error",
                text,
              },
            ]);
          }
          if (result.stopReason === "step_limit") {
            // Offer the way out, not just the bad news: the work so far is in the
            // conversation, so continuing is one message away.
            setCanContinue(true);
            setBubbles((current) => [
              ...current,
              { id: `n_${Date.now()}`, role: "notice", level: "warn", text: strings.chat.stoppedAfter(result.steps) },
            ]);
          }
          break;
        }
        applyEvent(step.value, assistantId, setBubbles, toolsThisRun, setTools, setStatus);
      }
    } catch (error) {
      setBubbles((current) => [
        ...current,
        {
          id: `e_${Date.now()}`,
          role: "notice",
          level: "error",
          text: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      abortRef.current = undefined;
      setRunning(false);
      setBubbles((current) =>
        current.map((bubble) => (bubble.id === assistantId ? { ...bubble, streaming: false } : bubble)),
      );
      setStatus("");
    }
  }, [conversationId, draft, running, runtime]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    runtime?.stop();
  }, [runtime]);

  const newChat = useCallback(() => {
    setConversationId(undefined);
    setBubbles([]);
    setTools([]);
    setCanContinue(false);
  }, []);

  const data = useMemo(() => bubbles, [bubbles]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.headerModel} numberOfLines={1}>
          {runtime ? `${runtime.providerInfo().label} · ${runtime.providerInfo().model}` : strings.chat.starting}
        </Text>
        <View style={styles.headerActions}>
          <Pressable onPress={newChat} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>{strings.common.new}</Text>
          </Pressable>
          <Link href="/settings" asChild>
            <Pressable style={styles.headerButton}>
              <Text style={styles.headerButtonText}>{strings.common.settings}</Text>
            </Pressable>
          </Link>
        </View>
      </View>

      {/* Android grants all-files access only via system settings, and without it
          every shared-storage folder lists as empty -- so the agent looks broken
          when it is merely unauthorised. Say so before the user blames the agent. */}
      {storageAccess && storageAccess.status !== "granted" ? (
        <View style={styles.storageBanner}>
          <Text style={styles.storageBannerTitle}>{strings.settings.diagStorageAccess}</Text>
          <Text style={styles.storageBannerBody}>{strings.settings.storageDenied}</Text>
          <Pressable style={styles.storageBannerButton} onPress={() => void runtime?.openStorageSettings()}>
            <Text style={styles.storageBannerButtonText}>{strings.settings.openStorageSettings}</Text>
          </Pressable>
        </View>
      ) : null}

      {!ready ? (
        <View style={styles.center}>
          {state.status === "error" ? (
            <Text style={styles.error}>{state.error}</Text>
          ) : (
            <>
              <ActivityIndicator color={theme.colors.accent} />
              <Text style={styles.muted}>{strings.chat.loadingCapabilities}</Text>
            </>
          )}
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListHeaderComponent={tools.length > 0 ? <ToolCardList tools={tools} /> : null}
          renderItem={({ item }) => <BubbleView bubble={item} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{strings.chat.emptyTitle}</Text>
              <Text style={styles.muted}>{strings.chat.emptyBody}</Text>
            </View>
          }
        />
      )}

      {status !== "" ? <Text style={styles.status}>{status}</Text> : null}

      {canContinue && !running ? (
        <Pressable style={styles.continueBar} onPress={() => void send(strings.chat.continueMessage)}>
          <Text style={styles.continueText}>{strings.chat.continueRun}</Text>
          <Text style={styles.continueHint}>{strings.chat.continueHint}</Text>
        </Pressable>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={strings.chat.placeholder}
          placeholderTextColor={theme.colors.textFaint}
          multiline
          editable={ready && !running}
          onSubmitEditing={() => void send()}
          returnKeyType="send"
        />
        {running ? (
          <Pressable style={[styles.send, styles.stop]} onPress={stop}>
            <Text style={styles.sendText}>{strings.common.stop}</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.send, !ready || draft.trim() === "" ? styles.sendDisabled : null]}
            onPress={() => void send()}
            disabled={!ready || draft.trim() === ""}
          >
            <Text style={styles.sendText}>{strings.common.run}</Text>
          </Pressable>
        )}
      </View>

      <ApprovalSheet approvals={runtime?.approvals} />
    </KeyboardAvoidingView>
  );
}

function ToolCardList({ tools }: { tools: TranscriptEntry[] }) {
  return (
    <View style={styles.toolList}>
      <Text style={styles.sectionLabel}>{strings.chat.toolActivity}</Text>
      {tools.map((entry) =>
        entry.kind === "tool" ? <ToolCard key={entry.id} entry={entry} /> : null,
      )}
    </View>
  );
}

function BubbleView({ bubble }: { bubble: Bubble }) {
  if (bubble.role === "notice") {
    const color =
      bubble.level === "error"
        ? theme.colors.danger
        : bubble.level === "warn"
          ? theme.colors.warning
          : theme.colors.textMuted;
    return (
      <View style={styles.notice}>
        <Text style={[styles.noticeText, { color }]}>{bubble.text}</Text>
      </View>
    );
  }
  const mine = bubble.role === "user";
  const textColor = mine ? theme.colors.text : theme.colors.text;
  return (
    <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : null]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        {renderContent(mine ? "plain" : "markdown", bubble.text, {
          streaming: bubble.streaming,
          color: textColor,
        })}
        {bubble.streaming && bubble.text === "" ? (
          <Text style={[styles.bubbleText, { color: theme.colors.textMuted }]}>…</Text>
        ) : null}
      </View>
    </View>
  );
}

/** Fold one agent event into React state. */
function applyEvent(
  event: AgentEvent,
  assistantId: string,
  setBubbles: React.Dispatch<React.SetStateAction<Bubble[]>>,
  toolsThisRun: TranscriptEntry[],
  setTools: React.Dispatch<React.SetStateAction<TranscriptEntry[]>>,
  setStatus: React.Dispatch<React.SetStateAction<string>>,
): void {
  switch (event.type) {
    case "text":
      setBubbles((current) =>
        current.map((bubble) =>
          bubble.id === assistantId ? { ...bubble, text: bubble.text + event.delta } : bubble,
        ),
      );
      break;
    case "step":
      setStatus(strings.chat.step(event.step));
      break;
    case "tool_start": {
      const entry: TranscriptEntry = {
        kind: "tool",
        id: event.callId,
        at: Date.now(),
        callId: event.callId,
        name: event.name,
        input: event.input,
        ...(event.summary ? { summary: event.summary } : {}),
        status: "running",
      };
      toolsThisRun.push(entry);
      setTools([...toolsThisRun]);
      setStatus(`${event.name}…`);
      break;
    }
    case "tool_end": {
      const index = toolsThisRun.findIndex((entry) => entry.kind === "tool" && entry.callId === event.callId);
      if (index >= 0) {
        toolsThisRun[index] = {
          ...(toolsThisRun[index] as Extract<TranscriptEntry, { kind: "tool" }>),
          status: event.status,
          durationMs: event.durationMs,
          ...(event.output !== undefined ? { output: event.output } : {}),
          ...(event.error !== undefined ? { error: event.error } : {}),
        };
        setTools([...toolsThisRun]);
      }
      break;
    }
    case "denied":
      setStatus(strings.chat.denied(event.name));
      break;
    case "done":
      setStatus("");
      break;
    default:
      break;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2),
    borderBottomColor: theme.colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerModel: { color: theme.colors.textMuted, fontSize: 12, flexShrink: 1 },
  headerActions: { flexDirection: "row", gap: theme.space(2) },
  headerButton: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1.5),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
  },
  headerButtonText: { color: theme.colors.text, fontSize: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.space(3) },
  listContent: { padding: theme.space(4), gap: theme.space(3) },
  empty: { paddingTop: theme.space(16), gap: theme.space(3) },
  emptyTitle: { color: theme.colors.text, fontSize: 20, fontWeight: "600" },
  muted: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 20 },
  error: { color: theme.colors.danger, fontSize: 13, padding: theme.space(4), textAlign: "center" },
  bubbleRow: { flexDirection: "row" },
  bubbleRowMine: { justifyContent: "flex-end" },
  bubble: { maxWidth: "88%", borderRadius: theme.radius.lg, padding: theme.space(3.5) },
  bubbleMine: { backgroundColor: theme.colors.accentSoft },
  bubbleTheirs: { backgroundColor: theme.colors.surface },
  bubbleText: { color: theme.colors.text, fontSize: 15, lineHeight: 22 },
  notice: {
    borderLeftColor: theme.colors.border,
    borderLeftWidth: 2,
    paddingLeft: theme.space(3),
    paddingVertical: theme.space(1),
  },
  noticeText: { fontSize: 12, lineHeight: 18 },
  storageBanner: {
    backgroundColor: theme.colors.warningSoft,
    borderColor: theme.colors.warning,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.md,
    marginHorizontal: theme.space(4),
    marginBottom: theme.space(2),
    padding: theme.space(3),
    gap: theme.space(1),
  },
  storageBannerTitle: { color: theme.colors.warning, fontSize: 13, fontWeight: "700" },
  storageBannerBody: { color: theme.colors.text, fontSize: 12, lineHeight: 18 },
  storageBannerButton: {
    alignSelf: "flex-start",
    marginTop: theme.space(2),
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.accentSoft,
  },
  storageBannerButtonText: { color: theme.colors.text, fontSize: 12, fontWeight: "600" },
  toolList: { gap: theme.space(2), marginBottom: theme.space(2) },
  sectionLabel: {
    color: theme.colors.textFaint,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  status: { color: theme.colors.textFaint, fontSize: 11, paddingHorizontal: theme.space(4), paddingBottom: theme.space(1) },
  continueBar: {
    marginHorizontal: theme.space(3),
    marginBottom: theme.space(2),
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3),
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.accentSoft,
    borderColor: theme.colors.accent,
    borderWidth: 1,
    gap: theme.space(1),
  },
  continueText: { color: theme.colors.text, fontWeight: "600", fontSize: 14 },
  continueHint: { color: theme.colors.textMuted, fontSize: 11 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.space(2),
    padding: theme.space(3),
    borderTopColor: theme.colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    maxHeight: 140,
    minHeight: 44,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2.5),
    color: theme.colors.text,
    fontSize: 15,
  },
  send: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3),
  },
  sendDisabled: { opacity: 0.4 },
  stop: { backgroundColor: theme.colors.danger },
  sendText: { color: "#fff", fontWeight: "600", fontSize: 14 },
});
