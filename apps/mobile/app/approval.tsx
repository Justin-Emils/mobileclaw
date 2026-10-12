import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { approvalOrigin } from "@/runtime/approval-origin";
import { useRuntimeState } from "@/ui/runtime-provider";
import { strings } from "@/ui/strings";
import { theme } from "@/ui/theme";

/**
 * Where an approval answer lands.
 *
 * ## Why this screen exists
 *
 * The notification's buttons cannot reach JavaScript directly — an Android notification action is a
 * `PendingIntent`, which only fires an `Intent` — so the answer comes back as
 * `mobileclaw://approval?id=…&approved=…`. A URL matching no route makes Expo Router render its
 * **"Unmatched Route"** screen, so answering a question showed the user a page-not-found error.
 *
 * ## Why it goes back rather than forward
 *
 * The first version redirected to `/`, and **`/` with no `?id=` is a new conversation** — so answering
 * a question about the run in front of the user replaced it with an empty chat. The conversation the
 * user was on is remembered by `approval-origin`, and this returns to it.
 *
 * ## Why it waits
 *
 * The answer is applied by `RuntimeProvider`, which subscribes to the same `Linking` events and holds
 * the shared `ApprovalBroker`; resolving it here as well would apply it twice. The redirect therefore
 * waits until the runtime exists — on a cold start the app was launched *by* the button press, so
 * there is a moment where nothing can be said about it yet.
 */
export default function ApprovalRedirect() {
  const { runtime, status } = useRuntimeState();

  useEffect(() => {
    if (status === "loading") return;
    const id = approvalOrigin()?.conversationId;
    // `replace`, not `push`: this route is plumbing, and going "back" to it would be meaningless.
    router.replace(id ? { pathname: "/", params: { id } } : "/");
  }, [status, runtime]);

  return (
    <View style={styles.container}>
      <ActivityIndicator color={theme.colors.accent} />
      <Text style={styles.text}>{strings.approval.handling}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.background,
    gap: 12,
  },
  text: { color: theme.colors.textFaint, fontSize: 13 },
});
