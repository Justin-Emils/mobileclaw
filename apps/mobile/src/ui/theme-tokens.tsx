import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Design tokens, as a **registry of named themes**, with the hooks that select between them.
 *
 * ## Why a registry rather than two palettes
 *
 * The first version of this module hard-coded a light palette and a dark one, and `ResolvedMode` was
 * the union `"light" | "dark"`. That shape bakes the number of themes into every type: a third theme
 * would mean editing the union, the resolver, and the style factory — and `createThemedStyles` would
 * have to gain a branch for it. Components would keep compiling while silently rendering the wrong
 * palette if any of those edits were missed.
 *
 * A registry inverts that. A theme is a value with an id; `createThemedStyles` builds one style set
 * **per entry in the registry** by iterating, so adding a theme is adding a value and nothing else.
 * The hooks resolve an id, so an unknown id degrades to a known theme instead of rendering undefined.
 *
 * ## Why reactivity had to be part of the shape
 *
 * The app was dark-only and `theme` was a module constant read inside `StyleSheet.create(...)`, which
 * runs **once, at module load**. Swapping the palette changed nothing on screen: every style object
 * already held the old colours, because the module was not re-evaluated.
 *
 * ## The shape chosen, and the alternatives
 *
 *  - **Inline styles on every element** would allocate on each render and move ~12 files' worth of
 *    layout out of `StyleSheet`, where it is at least validated once.
 *  - **`useMemo(() => StyleSheet.create(…), [theme])`** re-creates and re-registers every style object
 *    on each switch — cheap, but work that can simply not happen.
 *
 * Precomputing works because the registry is known at build time.
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

/** The parts of a theme that are numeric or structural rather than coloured. */
export interface ThemeMetrics {
  radius: { sm: number; md: number; lg: number; pill: number };
  space: (units: number) => number;
  font: { mono: "monospace" };
}

export interface Theme extends ThemeMetrics {
  colors: ThemeColors;
  /** What the platform bars should be, given this palette. */
  statusBar: "light" | "dark";
}

/**
 * One entry in the registry.
 *
 * `appearance` is what a theme *is*, for the platform's benefit: `useColorScheme` reports `"light"` or
 * `"dark"`, and the "follow the system" preference has to pick the registry entry that matches. A
 * theme with no obvious counterpart (a high-contrast or a coloured theme) simply declares the one it
 * most resembles.
 */
export interface ThemeDefinition {
  /** Stable key. Persisted in storage, so changing one orphans that user's preference. */
  id: string;
  /** Shown in the picker. Kept in the theme so a new theme brings its own name. */
  label: string;
  appearance: "light" | "dark";
  theme: Theme;
}

/** A collection of themes, addressed by id. */
export type ThemeRegistry = readonly ThemeDefinition[];

const sharedMetrics: ThemeMetrics = {
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
  space: (units: number): number => units * 4,
  font: { mono: "monospace" as const },
};

/**
 * The original palette, unchanged.
 *
 * Kept byte-for-byte rather than "tidied" while adding others: these values were tuned against a
 * device, and drift here would be invisible in review and obvious on a phone.
 */
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

export const darkTheme: Theme = { colors: darkColors, ...sharedMetrics, statusBar: "light" };
export const lightTheme: Theme = { colors: lightColors, ...sharedMetrics, statusBar: "dark" };

/**
 * The themes this build ships with.
 *
 * Adding a theme means adding an entry here — no union to extend, no branch to add anywhere else.
 */
export const BUILT_IN_THEMES: ThemeRegistry = [
  { id: "light", label: "浅色", appearance: "light", theme: lightTheme },
  { id: "dark", label: "深色", appearance: "dark", theme: darkTheme },
];

/**
 * The registry in force.
 *
 * Module-level rather than a React context because `createThemedStyles` runs at **module load**, before
 * any provider exists. `setThemeRegistry` exists so a host can install its own set before the app
 * renders; changing it afterwards would not rebuild the already-computed style tables.
 */
let registry: ThemeRegistry = BUILT_IN_THEMES;

export function setThemeRegistry(next: ThemeRegistry): void {
  if (next.length === 0) throw new Error("a theme registry cannot be empty");
  registry = next;
}

export function themeRegistry(): ThemeRegistry {
  return registry;
}

/** What the user chose. `"system"` follows the phone rather than naming a theme. */
export type ThemePreference = "system" | string;

/** The definition for an id, or the first entry when the id is unknown. */
export function themeDefinition(id: string | undefined): ThemeDefinition {
  const found = registry.find((entry) => entry.id === id);
  if (found) return found;
  // An unknown id is not worth crashing over: a theme removed by an update, or a preference written by
  // a newer build. Falling back keeps the app usable and the next write corrects it.
  const first = registry[0];
  if (!first) throw new Error("a theme registry cannot be empty");
  return first;
}

/** The theme for an id, falling back to the first registered. */
export function themeFor(id: string | undefined): Theme {
  return themeDefinition(id).theme;
}

/** The theme whose `appearance` matches the platform, for "follow the system". */
export function themeForAppearance(appearance: "light" | "dark"): ThemeDefinition {
  return registry.find((entry) => entry.appearance === appearance) ?? themeDefinition(undefined);
}

/**
 * A style set per registered theme, computed once.
 *
 * Returns a lookup rather than a single value, so callers stay ignorant of how many themes exist. The
 * factory runs once per entry, at module load; a style that depends on something other than the theme
 * — a measured width, a font scale — does not belong in here.
 *
 * Style sets are computed lazily on first request, so registering a theme that this file does not
 * import does not pay for a style table nobody asks for.
 */
export function createThemedStyles<T>(factory: (theme: Theme) => T): (themeId: string) => T {
  const cache = new Map<string, T>();
  return (themeId: string) => {
    const cached = cache.get(themeId);
    if (cached !== undefined) return cached;
    const built = factory(themeFor(themeId));
    cache.set(themeId, built);
    return built;
  };
}

interface ThemeContextValue {
  /** The user's setting, verbatim. */
  preference: ThemePreference;
  /** The resolved theme id, after "system" has been answered. */
  themeId: string;
  /** That theme's definition, including its label. */
  definition: ThemeDefinition;
  theme: Theme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  themeId: themeDefinition(undefined).id,
  definition: themeDefinition(undefined),
  theme: themeDefinition(undefined).theme,
  setPreference: () => {},
});

export function ThemeProvider({
  preference,
  systemAppearance,
  setPreference,
  children,
}: {
  preference: ThemePreference;
  /** The platform's own answer, which `"system"` defers to. */
  systemAppearance: "light" | "dark";
  setPreference: (preference: ThemePreference) => void;
  children: ReactNode;
}) {
  const value = useMemo<ThemeContextValue>(() => {
    const definition =
      preference === "system" ? themeForAppearance(systemAppearance) : themeDefinition(preference);
    return {
      preference,
      themeId: definition.id,
      definition,
      theme: definition.theme,
      setPreference,
    };
  }, [preference, systemAppearance, setPreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** The current theme's styles, from a lookup built by `createThemedStyles`. */
export function useThemedStyles<T>(styles: (themeId: string) => T): T {
  const { themeId } = useTheme();
  return styles(themeId);
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
