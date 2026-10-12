import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { ThemeProvider, type ResolvedMode, type ThemeMode } from "@/ui/theme-tokens";

/**
 * The theme preference, persisted, wrapping the app.
 *
 * ## Where it is stored, and why not in the app's config
 *
 * The theme has to be known BEFORE the runtime exists: the first frame is painted before
 * bootstrapRuntime resolves, and a palette that arrives late paints one set of colours and then swaps
 * them. expo-secure-store is the only durable storage available that early, and while a colour
 * preference is not a secret it is small and already wired.
 */

const THEME_KEY = "mobileclaw.theme";

/** The slice of expo-secure-store this needs, injected so it can be faked in a test. */
export interface ThemeStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

function isMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function ThemePreferenceProvider({
  storage,
  children,
}: {
  storage: ThemeStorage;
  children: ReactNode;
}) {
  // useColorScheme is the platform's own answer, and it changes while the app runs if the user flips
  // the system setting -- which is what "follow the phone's theme" has to mean.
  const systemMode: ResolvedMode = useColorScheme() === "light" ? "light" : "dark";
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void storage
      .getItemAsync(THEME_KEY)
      .then((stored) => {
        if (!cancelled && isMode(stored)) setModeState(stored);
      })
      .catch(() => {
        // A store that cannot be read is not a reason to refuse to render; the default stands.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [storage]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next);
      void storage.setItemAsync(THEME_KEY, next).catch(() => {
        // The change still applies for this session; failing to persist it is not worth an error.
      });
    },
    [storage],
  );

  // Nothing renders until the stored preference is known, so the app never paints one palette and then
  // swaps to the other a frame later.
  if (!loaded) return null;

  return (
    <ThemeProvider mode={mode} systemMode={systemMode} setMode={setMode}>
      {children}
    </ThemeProvider>
  );
}