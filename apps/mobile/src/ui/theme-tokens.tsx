import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Design tokens, in two palettes, with the hooks that select between them.
 *
 * ## Why this replaced a plain object
 *
 * The app was dark-only and `theme` was a module constant. That constant is read inside
 * `StyleSheet.create(...)`, which runs **once, at module load**, so swapping the palette would have
 * changed nothing on screen: every style object would already hold the old colours. Reactivity had to
 * become part of the shape of the tokens rather than something bolted on.
 *
 * ## The shape, and why this one
 *
 * `createThemedStyles` precomputes a style set per palette and `useThemedStyles` picks one. The
 * alternatives were worse here:
 *
 *  - **Inline styles on every element** would allocate on each render and would move ~12 files' worth
 *    of layout out of `StyleSheet`, where it is at least validated once.
 *  - **`useMemo(() => StyleSheet.create(…), [theme])`** re-creates and re-registers every style
 *    object on each switch — cheap, but work that can simply not happen.
 *
 * Precomputing works because the palettes are known at build time: there are exactly two.
 */

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentSoft: string;
  danger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  success: string;
  tool: string;
}

export interface Theme {
  colors: ThemeColors;
  radius: { sm: number; md: number; lg: number; pill: number };
  space: (units: number) => number;
  font: { mono: "monospace" };
  statusBar: "light" | "dark";
}

/** The original palette, unchanged. Tuned against a device; drift here is invisible in review. */
const darkColors: ThemeColors = {
  background: "#0b0f14",
  surface: "#121822",
  surfaceAlt: "#182130",
  border: "#22303f",
  text: "#e8eef6",
  textMuted: "#93a4b8",
  textFaint: "#64748b",
  accent: "#4c8dff",
  accentSoft: "#1d3a63",
  danger: "#ef5d6b",
  dangerSoft: "#3a1c22",
  warning: "#f0b429",
  warningSoft: "#3a2f14",
  success: "#3fc78a",
  tool: "#1b2735",
};

/**
 * The light palette.
 *
 * The accents are **not** the same hexes on a pale background: `#4c8dff` on white is about 2.6:1,
 * below the 4.5:1 body text needs, so each hue is darkened until it is readable rather than kept to
 * match. The `*Soft` entries move the other way — light washes instead of dark ones, because they sit
 * behind dark text.
 */
const lightColors: ThemeColors = {
  background: "#f5f7fa",
  surface: "#ffffff",
  surfaceAlt: "#eaeef4",
  border: "#d3dae3",
  text: "#0f1620",
  textMuted: "#495565",
  textFaint: "#6a7686",
  accent: "#1b5cc4",
  accentSoft: "#d7e3f9",
  danger: "#ae222c",
  dangerSoft: "#fbdfe1",
  warning: "#7d5800",
  warningSoft: "#faebc8",
  success: "#16724a",
  tool: "#eef1f6",
};

const shared = {
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
  space: (units: number): number => units * 4,
  font: { mono: "monospace" as const },
};

export const darkTheme: Theme = { colors: darkColors, ...shared, statusBar: "light" };
export const lightTheme: Theme = { colors: lightColors, ...shared, statusBar: "dark" };

/** What the user chose. `system` follows the phone. */
export type ThemeMode = "system" | "light" | "dark";

/** What a mode resolved to. `system` is never itself a resolved value. */
export type ResolvedMode = "light" | "dark";

/** The palette for a mode. Components should use the hooks so they re-render. */
export function themeFor(mode: ResolvedMode): Theme {
  return mode === "light" ? lightTheme : darkTheme;
}

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedMode;
  theme: Theme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "system",
  resolved: "dark",
  theme: darkTheme,
  setMode: () => {},
});

export function ThemeProvider({
  mode,
  systemMode,
  setMode,
  children,
}: {
  mode: ThemeMode;
  systemMode: ResolvedMode;
  setMode: (mode: ThemeMode) => void;
  children: ReactNode;
}) {
  const value = useMemo<ThemeContextValue>(() => {
    const resolved: ResolvedMode = mode === "system" ? systemMode : mode;
    return { mode, resolved, theme: themeFor(resolved), setMode };
  }, [mode, systemMode, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/**
 * Build one style set per palette, once, and let `useThemedStyles` hand back the current one.
 *
 * The factory runs exactly twice, at module load. A style that depends on something other than the
 * palette — a measured width, a font scale — does not belong in here.
 */
export function createThemedStyles<T>(factory: (theme: Theme) => T): (mode: ResolvedMode) => T {
  const light = factory(lightTheme);
  const dark = factory(darkTheme);
  return (mode) => (mode === "light" ? light : dark);
}

/** The current palette's styles, from a value built by `createThemedStyles`. */
export function useThemedStyles<T>(styles: (mode: ResolvedMode) => T): T {
  const { resolved } = useTheme();
  return styles(resolved);
}

/** Colour for a transcript entry status. Takes the palette so it follows the theme. */
export function statusColor(colors: ThemeColors, status: string): string {
  switch (status) {
    case "ok":
      return colors.success;
    case "error":
      return colors.danger;
    case "denied":
      return colors.warning;
    default:
      return colors.textMuted;
  }
}

/** Colour for a risk level badge. Takes the palette, for the same reason as `statusColor`. */
export function riskColor(colors: ThemeColors, risk: string): string {
  switch (risk) {
    case "read":
      return colors.success;
    case "write":
      return colors.accent;
    case "network":
      return colors.accent;
    case "execute":
      return colors.warning;
    case "system":
      return colors.danger;
    default:
      return colors.textMuted;
  }
}
