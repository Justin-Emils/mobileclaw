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
        </Stack>
      </RuntimeProvider>
    </SafeAreaProvider>
  );
}
