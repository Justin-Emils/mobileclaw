import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "expo-router";
import { useRuntime } from "@/ui/runtime-provider";
import { strings } from "@/ui/strings";
import { theme } from "@/ui/theme";

/**
 * The diagnostic log, on screen and shareable.
 *
 * ## Why this screen has to exist
 *
 * The log is written to the app's private directory, which nothing else on the phone can read, and
 * a release build bridges no `console` output to logcat. Without a way out, the log would be
 * exactly as invisible as the failure it was added to explain.
 *
 * So the two actions here are the point of the screen: **copy out** and **clear**. Clear matters
 * because the useful capture is usually "start clean, reproduce once, then share" — a log that
 * already contains yesterday makes the one interesting run hard to find.
 *
 * Read-only by design. Nothing here edits or filters the log; a filtered view would be a second
 * place for the truth to differ from the file.
 */
export default function LogsScreen() {
  const runtime = useRuntime();
  const [text, setText] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  /** Where the log is and whether writing it works, so "empty" can explain itself. */
  const [status, setStatus] = useState<
    { path: string; exists: boolean; lines: number; bytes?: number; lastError: string } | undefined
  >(undefined);
  /**
   * Whether the app is protected from being frozen, and whether the user can see that.
   *
   * On this screen because it is the "what is the app doing" screen, and because the answer is
   * invisible from inside the app: the foreground service's notification is the platform's own
   * indicator, and on Android 13+ it stays hidden until `POST_NOTIFICATIONS` is granted.
   */
  const [background, setBackground] = useState<
    { serviceRunning: boolean; notificationsGranted: boolean | undefined } | undefined
  >(undefined);
  /** Set briefly after a copy, so the action is visibly acknowledged. */
  const [copied, setCopied] = useState(false);
  /** What the export action reported: where the file went, or why it could not. */
  const [exported, setExported] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!runtime) return;
    try {
      setText(await runtime.runLog());
      setStatus(await runtime.runLogStatus());
      setBackground(await runtime.backgroundStatus());
      setError(undefined);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, [runtime]);

  // Re-read on focus, not just on mount: the notification permission is granted in *system
  // settings*, so the user comes back to this screen to find out whether it worked.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    void load();
  }, [load]);

  const onShare = useCallback(async () => {
    try {
      // `title` is required on Android's chooser.
      await Share.share({ message: text ?? "", title: strings.logs.title });
    } catch {
      // The user dismissing the share sheet is not an error worth reporting.
    }
  }, [text]);

  /**
   * Copy the whole log to the clipboard.
   *
   * This exists next to Share because it is the more reliable of the two on a phone where the log
   * is being read: the share sheet's targets vary by ROM and some of them truncate, while the
   * clipboard takes the text verbatim and the user can paste it wherever the answer needs to go.
   * The acknowledgement is deliberately on screen rather than a toast, which is easy to miss.
   */
  const onCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(text ?? "");
      setCopied(true);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, [text]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const onClear = useCallback(async () => {
    await runtime?.clearRunLog();
    await load();
  }, [runtime, load]);

  const empty = text !== undefined && text.trim() === "";

  return (
    <View style={styles.root}>
      <View style={styles.actions}>
        <Pressable style={styles.button} onPress={() => void load()}>
          <Text style={styles.buttonText}>{strings.logs.refresh}</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.primary]} onPress={() => void onCopy()}>
          <Text style={[styles.buttonText, styles.primaryText]}>
            {copied ? strings.logs.copied : strings.logs.copy}
          </Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => void onShare()}>
          <Text style={styles.buttonText}>{strings.logs.share}</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => void onClear()}>
          <Text style={styles.buttonText}>{strings.logs.clear}</Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>{strings.logs.hint}</Text>

      {/* The background-running answer, above everything else, because it is the question the
          notification was supposed to answer and cannot once the permission is missing. */}
      {background ? (
        <View style={styles.backgroundBox}>
          <Text style={styles.backgroundText}>
            {strings.logs.background(background.serviceRunning, background.notificationsGranted)}
          </Text>
          {background.notificationsGranted === false ? (
            <Pressable
              style={styles.inlineButton}
              onPress={() => void runtime?.requestNotificationPermission().then(() => load())}
            >
              <Text style={styles.buttonText}>{strings.logs.grantNotifications}</Text>
            </Pressable>
          ) : null}
          {/*
            Copies the log to shared storage so a development machine can read it over USB.
            Deliberately in the interface rather than hidden: on a release build the app's own
            directory is unreadable from `adb shell`, so without this a device-only bug can only be
            read off the screen by hand.
          */}
          <Pressable
            style={styles.inlineButton}
            onPress={() => {
              void (async () => {
                try {
                  const destination = await runtime?.exportRunLog();
                  setExported(
                    destination === undefined ? strings.logs.exportUnavailable : strings.logs.exported(destination),
                  );
                } catch (problem) {
                  setExported(strings.logs.exportFailed(problem instanceof Error ? problem.message : String(problem)));
                }
              })();
            }}
          >
            <Text style={styles.buttonText}>{strings.logs.exportLog}</Text>
          </Pressable>
          {exported ? <Text style={styles.backgroundText}>{exported}</Text> : null}
        </View>
      ) : null}

      {/* Shown above the log rather than hidden behind a details toggle: when the log is empty,
          this line is the entire diagnosis. */}
      {status ? (
        <Text style={styles.status}>
          {strings.logs.status(status.path, status.exists, status.lines, status.bytes, status.lastError)}
        </Text>
      ) : null}

      {text === undefined ? (
        <ActivityIndicator style={styles.loading} color={theme.colors.accent} />
      ) : empty ? (
        <Text style={styles.empty}>{strings.logs.empty}</Text>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.log} selectable>
            {text}
          </Text>
        </ScrollView>
      )}

      {error ? <Text style={styles.error}>{strings.logs.failed(error)}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  actions: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  primary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  buttonText: { color: theme.colors.text, fontSize: 13 },
  primaryText: { color: theme.colors.background, fontWeight: "600" },
  hint: {
    color: theme.colors.textMuted,
    fontSize: 12,
    paddingHorizontal: 12,
    paddingBottom: 8,
    lineHeight: 17,
  },
  status: {
    color: theme.colors.textFaint,
    fontSize: 11,
    fontFamily: "monospace",
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  backgroundBox: {
    marginHorizontal: 12,
    marginBottom: 10,
    padding: 10,
    borderRadius: 8,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    gap: 8,
  },
  backgroundText: { color: theme.colors.text, fontSize: 12, lineHeight: 18 },
  inlineButton: {
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: theme.colors.accent,
  },
  loading: { marginTop: 32 },
  empty: { color: theme.colors.textMuted, textAlign: "center", marginTop: 32, paddingHorizontal: 24 },
  scroll: { flex: 1, marginHorizontal: 12, marginBottom: 12 },
  scrollContent: { paddingBottom: 24 },
  // Monospace, and small: the value of this screen is being able to read many lines at once and
  // copy them out verbatim, not comfortable prose.
  log: { color: theme.colors.text, fontSize: 11, fontFamily: "monospace", lineHeight: 16 },
  error: { color: theme.colors.danger, padding: 12 },
});
