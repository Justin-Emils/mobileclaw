import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import { RuntimeProvider } from "@/ui/runtime-provider";
import { strings } from "@/ui/strings";
import { useTheme } from "@/ui/theme-tokens";
import { ThemePreferenceProvider } from "@/ui/theme-preference";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      {/*
        The theme wraps the runtime, not the other way round: RuntimeProvider boots SQLite and the
        secret store, and the palette has to be known before the first frame is painted. See the note
        in theme-preference.tsx.
      */}
      <ThemePreferenceProvider storage={SecureStore}>
        <ThemedStack />
      </ThemePreferenceProvider>
    </SafeAreaProvider>
  );
}

/**
 * The navigator, themed.
 *
 * Split out because useTheme has to be called inside the provider, and RootLayout is the component
 * that renders it.
 */
function ThemedStack() {
  const { theme } = useTheme();
  return (
    <RuntimeProvider>
      {/* The light palette needs dark status-bar icons and vice versa, so this follows the theme
          instead of being pinned to "light" as it was when the app was dark-only. */}
      <StatusBar style={theme.statusBar} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.background },
          headerTitleStyle: { color: theme.colors.text },
          headerTintColor: theme.colors.accent,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: strings.app.name }} />
        <Stack.Screen name="settings" options={{ title: strings.settings.title }} />
        <Stack.Screen name="permissions" options={{ title: strings.permissions.title }} />
        {/* A screen with no entry here falls back to its file name, so this route's header read
            "conversations" on a device until it was registered. */}
        <Stack.Screen name="conversations" options={{ title: strings.conversations.title }} />
        <Stack.Screen name="screen-probe" options={{ title: strings.probe.title }} />
        <Stack.Screen name="screenshots" options={{ title: strings.shots.title }} />
        <Stack.Screen name="logs" options={{ title: strings.logs.title }} />
        {/* Where a notification button's answer lands before it redirects back. See app/approval.tsx. */}
        <Stack.Screen name="approval" options={{ headerShown: false }} />
      </Stack>
    </RuntimeProvider>
  );
}