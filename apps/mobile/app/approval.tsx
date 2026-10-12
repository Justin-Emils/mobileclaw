import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { strings } from "@/ui/strings";
import { theme } from "@/ui/theme";

/**
 * Where an approval answer lands.
 *
 * ## Why this screen exists at all
 *
 * The notification's buttons cannot reach JavaScript directly — an Android notification action is a
 * `PendingIntent`, which only fires an `Intent`. So the answer comes back as
 * `mobileclaw://approval?id=…&approved=…`, and a URL that matches no route makes Expo Router render
 * its **"Unmatched Route"** screen: the user answers the question and is shown a page-not-found
 * error, which is exactly what happened on a device.
 *
 * ## Why it does nothing but redirect
 *
 * The answer is applied by `RuntimeProvider`, which subscribes to the same `Linking` events and holds
 * the shared `ApprovalBroker`. This route only has to exist so the router has somewhere to arrive,
 * then get out of the way — resolving the answer here as well would apply it twice.
 *
 * The redirect is immediate rather than showing anything: the user pressed a button on a
 * notification, and the app opening onto the conversation is the outcome they asked for. A screen
 * that lingered would look like a step they had to dismiss.
 */
export default function ApprovalRedirect() {
  useEffect(() => {
    // `replace`, not `push`: this route is plumbing, and going "back" to it would be meaningless.
    router.replace("/");
  }, []);

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
