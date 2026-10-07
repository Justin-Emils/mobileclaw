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
import { Link } from "expo-router";
import type { AgentEvent, TranscriptEntry } from "@mobileclaw/core";
import { useRuntime, useRuntimeState } from "@/ui/runtime-provider";
import { ApprovalSheet } from "@/ui/approval-sheet";
import { ToolCard } from "@/ui/tool-card";
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
  const abortRef = useRef<AbortController | undefined>(undefined);
  const listRef = useRef<FlatList<Bubble>>(null);

  const runtime = state.runtime;
  const ready = state.status === "ready" && runtime !== undefined;

  useEffect(() => {
    if (!ready || !state.error) return;
    setBubbles((current) => [
      ...current,
      {
        id: "boot-warning",
        role: "notice",
        level: "warn",
        text: `Offline demo mode: ${state.error}`,
      },
    ]);
  }, [ready, state.error]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!runtime || text === "" || running) return;

    setDraft("");
    setRunning(true);
    setStatus("");
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
              ? "No API key yet. Open Settings → API key, paste a key and tap Save key (typing alone does not store it). Settings → Self-check confirms it landed."
              : raw.includes("HTTP 401") || raw.includes("HTTP 403")
                ? `${raw} — the key was rejected. Check it against your provider's dashboard.`
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
            setBubbles((current) => [
              ...current,
              { id: `n_${Date.now()}`, role: "notice", level: "warn", text: `Stopped after ${result.steps} steps.` },
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
  }, []);

  const data = useMemo(() => bubbles, [bubbles]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.headerModel} numberOfLines={1}>
          {runtime ? `${runtime.providerInfo().label} · ${runtime.providerInfo().model}` : "starting…"}
        </Text>
        <View style={styles.headerActions}>
          <Pressable onPress={newChat} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>New</Text>
          </Pressable>
          <Link href="/settings" asChild>
            <Pressable style={styles.headerButton}>
              <Text style={styles.headerButtonText}>Settings</Text>
            </Pressable>
          </Link>
        </View>
      </View>

      {!ready ? (
        <View style={styles.center}>
          {state.status === "error" ? (
            <Text style={styles.error}>{state.error}</Text>
          ) : (
            <>
              <ActivityIndicator color={theme.colors.accent} />
              <Text style={styles.muted}>loading capabilities…</Text>
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
              <Text style={styles.emptyTitle}>Your phone, with hands.</Text>
              <Text style={styles.muted}>
                Try: “整理我的下载目录并按类型归档”, “找出所有大于 10MB 的日志”, “把下载里的
                notes.md 内容总结成一条待办”.
              </Text>
            </View>
          }
        />
      )}

      {status !== "" ? <Text style={styles.status}>{status}</Text> : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Ask MobileClaw to do something on this phone…"
          placeholderTextColor={theme.colors.textFaint}
          multiline
          editable={ready && !running}
          onSubmitEditing={() => void send()}
          returnKeyType="send"
        />
        {running ? (
          <Pressable style={[styles.send, styles.stop]} onPress={stop}>
            <Text style={styles.sendText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.send, !ready || draft.trim() === "" ? styles.sendDisabled : null]}
            onPress={() => void send()}
            disabled={!ready || draft.trim() === ""}
          >
            <Text style={styles.sendText}>Run</Text>
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
      <Text style={styles.sectionLabel}>Tool activity</Text>
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
  return (
    <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : null]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={styles.bubbleText}>
          {bubble.text}
          {bubble.streaming && bubble.text === "" ? "…" : ""}
        </Text>
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
      setStatus(`step ${event.step}`);
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
      setStatus(`denied: ${event.name}`);
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
  toolList: { gap: theme.space(2), marginBottom: theme.space(2) },
  sectionLabel: {
    color: theme.colors.textFaint,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  status: { color: theme.colors.textFaint, fontSize: 11, paddingHorizontal: theme.space(4), paddingBottom: theme.space(1) },
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
