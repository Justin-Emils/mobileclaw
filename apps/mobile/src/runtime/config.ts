import type { PermissionConfig } from "@mobileclaw/core";

/** Persisted provider settings; the API key lives in SecureStore, not here. */
export interface ProviderConfig {
  /** OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1 */
  baseUrl: string;
  model: string;
  temperature: number;
  maxSteps: number;
  /** Short label shown in the UI, e.g. "DeepSeek". */
  label: string;
}

export interface AppConfig {
  provider: ProviderConfig;
  permissions: PermissionConfig;
  /**
   * Roots the agent may touch. On Android these come from the native module when
   * all-files access is granted, otherwise they are the app's own directories.
   */
  roots: string[];
  useMockProvider: boolean;
  systemPrompt?: string;
  /**
   * Base URL of a self-hosted SearXNG instance, when the user has one.
   *
   * Empty means "use the built-in backend". Empty is not "no search": the fallback needs
   * no configuration at all, so this field is a *preference*, and the transcript records
   * which backend actually answered rather than assuming.
   */
  searxngBaseUrl?: string;
}

export const DEFAULT_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    keysUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keysUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-3.5-sonnet",
    keysUrl: "https://openrouter.ai/keys",
  },
  {
    id: "ollama",
    label: "Ollama (LAN)",
    baseUrl: "http://192.168.1.10:11434/v1",
    model: "qwen2.5:7b",
    keysUrl: "https://ollama.com/download",
  },
  {
    id: "custom",
    label: "Custom endpoint",
    baseUrl: "https://",
    model: "",
    keysUrl: "",
  },
];

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  /** Where the user creates a key; opened from Settings. */
  keysUrl: string;
}

/**
 * Permission defaults chosen for a phone agent: reading is frictionless, anything that
 * writes, executes or leaves the device prompts.
 *
 * `system` is deliberately **not** in `alwaysAskRisks`. It used to be, which forced a
 * prompt for `system_open` — bringing an app to the front, the most innocuous step of any
 * cross-app task. Prompting for navigation is what teaches a user to tap through prompts,
 * and that is the state in which the prompts that matter stop being read. The tools that
 * inject input (`screen_type`, `screen_tap_element`, `screen_find` with a tap,
 * `system_share`) ask every single time on their own account, via `alwaysAsk` plus
 * `neverRemember`, so they do not depend on this list.
 */
export const DEFAULT_PERMISSIONS: PermissionConfig = {
  defaultMode: "ask",
  riskModes: {
    read: "allow",
    network: "allow",
    write: "ask",
    execute: "ask",
    system: "ask",
  },
  rules: [
    // Never let the model delete outside the sandbox silently; the organize tool
    // already forces a prompt (alwaysAsk), this is belt and braces.
    { tool: "shizuku_run", decision: "deny" },
  ],
  alwaysAskRisks: ["execute"],
};

export const DEFAULT_CONFIG: AppConfig = {
  provider: {
    baseUrl: DEFAULT_PRESETS[0]!.baseUrl,
    model: DEFAULT_PRESETS[0]!.model,
    temperature: 0.2,
    maxSteps: 12,
    label: DEFAULT_PRESETS[0]!.label,
  },
  permissions: DEFAULT_PERMISSIONS,
  roots: [],
  useMockProvider: false,
};

/** Merge a stored config over the defaults, tolerating older shapes. */
export function mergeConfig(stored: unknown): AppConfig {
  if (typeof stored !== "object" || stored === null) return DEFAULT_CONFIG;
  const input = stored as Partial<AppConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...input,
    provider: { ...DEFAULT_CONFIG.provider, ...(input.provider ?? {}) },
    permissions: {
      ...DEFAULT_PERMISSIONS,
      ...(input.permissions ?? {}),
      riskModes: {
        ...DEFAULT_PERMISSIONS.riskModes,
        ...(input.permissions?.riskModes ?? {}),
      },
    },
    roots: Array.isArray(input.roots) ? input.roots : [],
  };
}
