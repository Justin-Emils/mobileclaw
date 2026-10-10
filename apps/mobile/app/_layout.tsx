import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { RuntimeProvider } from "@/ui/runtime-provider";
import { strings } from "@/ui/strings";
import { theme } from "@/ui/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <RuntimeProvider>
        <StatusBar style="light" />
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
          {/* A screen with no entry here falls back to its file name, so this route's
              header read "conversations" on a device until it was registered. */}
          <Stack.Screen name="conversations" options={{ title: strings.conversations.title }} />
          <Stack.Screen name="screen-probe" options={{ title: strings.probe.title }} />
          <Stack.Screen name="screenshots" options={{ title: strings.shots.title }} />
        </Stack>
      </RuntimeProvider>
    </SafeAreaProvider>
  );
}
