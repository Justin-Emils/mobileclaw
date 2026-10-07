/**
 * Design tokens.
 *
 * Kept as plain objects rather than a theme library: the app is dark-only for
 * now, and a single source of truth avoids the "which Stylesheet wins" problem
 * when the chat list and tool cards share spacing.
 */
export const theme = {
  colors: {
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
    success: "#3fc78a",
    tool: "#1b2735",
  },
  radius: {
    sm: 8,
    md: 12,
    lg: 18,
    pill: 999,
  },
  space: (units: number): number => units * 4,
  font: {
    mono: "monospace" as const,
  },
} as const;

/** Colour for a transcript entry status. */
export function statusColor(status: string): string {
  switch (status) {
    case "ok":
      return theme.colors.success;
    case "error":
      return theme.colors.danger;
    case "denied":
      return theme.colors.warning;
    default:
      return theme.colors.textMuted;
  }
}

/** Colour for a risk level badge. */
export function riskColor(risk: string): string {
  switch (risk) {
    case "read":
      return theme.colors.success;
    case "write":
      return theme.colors.accent;
    case "network":
      return theme.colors.accent;
    case "execute":
      return theme.colors.warning;
    case "system":
      return theme.colors.danger;
    default:
      return theme.colors.textMuted;
  }
}
