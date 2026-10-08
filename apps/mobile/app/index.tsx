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
import { Link, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import type { AgentEvent, ChatMessage, TranscriptEntry } from "@mobileclaw/core";
import { useRuntime, useRuntimeState } from "@/ui/runtime-provider";
import { ApprovalSheet } from "@/ui/approval-sheet";
import { ToolCard } from "@/ui/tool-card";
import { renderContent } from "@/ui/render";
import type { AllFilesAccessReport } from "@/runtime/services/permissions";
import { toBubbles as toTranscriptBubbles } from "@/ui/conversation-view";
import { strings } from "@/ui/strings";
import { theme } from "@/ui/theme";

interface Bubble {  id: string;
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
const PERMISSION_PROMPT_FLAG = "storage.permissionPrompted";

export default function ChatScreen() {
  const state = useRuntimeState();
  const params = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const { setParams } = router;
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [tools, setTools] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(params.id);
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
  /** Top inset, so the keyboard offset accounts for the status bar under edge-to-edge. */
  const insets = useSafeAreaInsets();
  /** Guards the hydrate effect against a slower load overwriting a newer one. */
  const hydrateToken = useRef(0);
  /** The conversation id already loaded into `bubbles`, so it loads once. */
  const hydratedRef = useRef<string | undefined>(undefined);
  /** Set in-memory so the permission dialog cannot fire twice in one mount. */
  const permissionAsked = useRef(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const listRef = useRef<FlatList<Bubble>>(null);

  const runtime = state.runtime;
  const ready = state.status === "ready" && runtime !== undefined;

  /**
   * Restore a stored conversation.
   *
   * The store was always written on every run (`onConversation`), but nothing ever
   * read it back, so every launch started from an empty transcript. This is the
   * missing half.
   */
  useEffect(() => {
    if (!ready || !runtime) return;
    const id = params.id;
    if (!id) return;
    // A ref, not state: re-hydrating on every bubble append would fight the stream.
    if (hydratedRef.current === id) return;

    const token = ++hydrateToken.current;
    void runtime.loadConversation(id).then((conversation) => {
      if (token !== hydrateToken.current) return;
      if (!conversation) {
        // Deleted from the list, or a stale deep link: fall back to a fresh chat.
        setConversationId(undefined);
        setParams({});
        return;
      }
      hydratedRef.current = id;
      setConversationId(conversation.id);
      setBubbles(toBubbles(conversation.messages));
      setTools(conversation.entries);
    });
  }, [ready, runtime, params.id, setParams]);

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

  /**
   * Ask for the dialog-based storage permissions once, on first launch.
   *
   * `MANAGE_EXTERNAL_STORAGE` has no dialog, but `READ_EXTERNAL_STORAGE` /
   * `WRITE_EXTERNAL_STORAGE` do, and on Android 12 and below those are what actually
   * gate reading a file. Nothing requested them before, so the app was denied shared
   * storage while appearing to have asked for it.
   *
   * Guarded by a persisted flag: a system dialog that reappears on every launch is
   * worse than one the user has to find in settings.
   */
  useEffect(() => {
    if (!ready || !runtime || storageAccess?.status !== "denied" || permissionAsked.current) return;
    permissionAsked.current = true;
    void (async () => {
      const stored = await runtime.getFlag(PERMISSION_PROMPT_FLAG).catch(() => undefined);
      if (stored === "1") return;
      const outcome = await runtime.requestStoragePermissions().catch(() => undefined);
      await runtime.setFlag(PERMISSION_PROMPT_FLAG, "1").catch(() => undefined);
      if (outcome && !outcome.granted && !outcome.notNeeded) {
        setBubbles((current) => [
          ...current,
          {
            id: "perm-notice",
            role: "notice",
            level: "warn",
            text: `${strings.settings.runtimeHint}${strings.settings.runtimeMissing}`,
          },
        ]);
      }
      const report = await runtime.checkStorageAccess().catch(() => undefined);
      if (report) setStorageAccess(report);
    })();
  }, [ready, runtime, storageAccess?.status]);

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
        onConversation: (conversation) => {
          setConversationId(conversation.id);
          // Keep the URL in step so a reload lands back in this conversation.
          setParams({ id: conversation.id });
        },
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
    hydratedRef.current = undefined;
    setBubbles([]);
    setTools([]);
    setCanContinue(false);
    // Drop the id from the URL too, or the hydrate effect would reload the old one.
    setParams({});
  }, [setParams]);

  const data = useMemo(() => bubbles, [bubbles]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      // Android needs `padding` here, not `undefined`.
      //
      // With `behavior={undefined}` this view did nothing on Android, which used to be fine
      // because the platform resized the window itself (`adjustResize`). At targetSdk 35+
      // edge-to-edge is always on, and that resize no longer happens -- so the keyboard
      // covered the composer with nothing compensating, and the user could not see what they
      // were typing. Reproduced on Android 16 / API 36.
      behavior="padding"
      keyboardVerticalOffset={insets.top}
    >
      <View style={styles.header}>
        <Text style={styles.headerModel} numberOfLines={1}>
          {runtime ? `${runtime.providerInfo().label} · ${runtime.providerInfo().model}` : strings.chat.starting}
        </Text>
        <View style={styles.headerActions}>
          <Link href="/conversations" asChild>
            <Pressable style={styles.headerButton}>
              <Text style={styles.headerButtonText}>{strings.conversations.open}</Text>
            </Pressable>
          </Link>
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
          // Without `handled`, a tap meant to dismiss the keyboard is swallowed instead of
          // reaching the button under it -- which reads as "the app ignored my tap".
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
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
  /** Briefly show "已复制" after a copy, so the tap has visible feedback. */
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const copy = useCallback((value: string) => {
    void Clipboard.setStringAsync(value);
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1400);
  }, []);

  if (bubble.role === "notice") {
    const color =
      bubble.level === "error"
        ? theme.colors.danger
        : bubble.level === "warn"
          ? theme.colors.warning
          : theme.colors.textMuted;
    return (
      <View style={styles.notice}>
        <Text selectable style={[styles.noticeText, { color }]}>
          {bubble.text}
        </Text>
      </View>
    );
  }
  const mine = bubble.role === "user";
  const textColor = theme.colors.text;
  return (
    <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : null]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        {renderContent(mine ? "plain" : "markdown", bubble.text, {
          streaming: bubble.streaming,
          color: textColor,
          onCopyCode: copy,
        })}
        {bubble.streaming && bubble.text === "" ? (
          <Text style={[styles.bubbleText, { color: theme.colors.textMuted }]}>…</Text>
        ) : null}
        {/* Whole-message copy. Selecting text by hand is possible now, but on a phone
            it is fiddly, and "copy the whole answer" is the common intent. */}
        {bubble.text !== "" && !bubble.streaming ? (
          <Pressable
            onPress={() => copy(bubble.text)}
            hitSlop={8}
            style={[styles.bubbleAction, mine ? styles.bubbleActionMine : null]}
          >
            <Text style={styles.bubbleActionText}>
              {copied ? strings.code.copied : strings.code.copyAction}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Project a stored conversation onto the transcript.
 *
 * Delegates to `@/ui/conversation-view` so the projection is unit-tested; see the
 * notes there for why tool messages and empty assistant turns are skipped.
 */
function toBubbles(messages: ChatMessage[]): Bubble[] {
  return toTranscriptBubbles(messages);
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
  bubbleAction: { alignSelf: "flex-end", marginTop: theme.space(2), paddingVertical: theme.space(1) },
  bubbleActionMine: { alignSelf: "flex-end" },
  bubbleActionText: { color: theme.colors.textMuted, fontSize: 11, fontWeight: "600" },
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
