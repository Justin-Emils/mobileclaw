import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { RuntimeProvider } from "@/ui/runtime-provider.js";
import { theme } from "@/ui/theme.js";

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
          <Stack.Screen name="index" options={{ title: "MobileClaw" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
          <Stack.Screen name="permissions" options={{ title: "Permissions" }} />
        </Stack>
      </RuntimeProvider>
    </SafeAreaProvider>
  );
}
