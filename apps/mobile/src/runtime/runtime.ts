import {
  Agent,
  type AgentEvent,
  type AgentRunResult,
  Context,
  DEFAULT_SYSTEM_PROMPT,
  KeyValueConversationStore,
  OpenAiCompatibleProvider,
  PermissionGate,
  PluginHost,
  ToolRegistry,
  type Conversation,
  type ConversationStore,
  type FileSystemService,
  type HttpService,
  type KeyValueStore,
  type LlmProvider,
  type ShellService,
  type SystemService,
  createId,
} from "@mobileclaw/core";
import { capabilityPlugins, type CapabilityDeps } from "@mobileclaw/capabilities";
import { ApprovalBroker } from "./approval";
import { AsyncEventQueue } from "./event-queue";
import { DEFAULT_CONFIG, mergeConfig, type AppConfig } from "./config";
import { API_KEY_SECRET, type SecretStore } from "./services/secrets";
import {
  probeAllFilesAccess,
  type AllFilesAccessReport,
} from "./services/permissions";
import { openAllFilesSettings } from "./services/settings-launcher";
import { APP_PACKAGE } from "./services/app-info";
import { describeWorkspace, workspacePath } from "./workspace";

export interface RuntimeDeps {
  config: unknown;
  secrets: SecretStore;
  kv: KeyValueStore;
  fs: FileSystemService;
  shell: ShellService;
  http: HttpService;
  system: SystemService;
  /**
   * Transport for the model provider. Injecting the transport (rather than a
   * whole provider) keeps `providerInfo()` consistent with the config while
   * still letting tests drive the real request/response mapping offline.
   */
  fetchImpl?: typeof globalThis.fetch;
  approvals?: ApprovalBroker;
  /**
   * App-owned directory that holds every conversation's workspace.
   *
   * Required rather than defaulted: guessing it would silently scatter workspaces
   * somewhere unintended. The bootstrap passes the platform's documents directory.
   */
  workspaceBaseDir: string;
  /** Extra lines appended to the system prompt (device facts, roots, date). */
  environment?: () => string | Promise<string>;
  /** Persist config changes made through the UI. */
  onConfigChange?: (config: AppConfig) => Promise<void> | void;
}

/**
 * The application-facing facade: owns the plugin host, the tool registry, the
 * permission gate and the agent, and exposes exactly what the UI needs.
 *
 * Deliberately free of React so it can be unit tested and so the UI can be
 * swapped without touching agent behaviour.
 */
export class MobileClawRuntime {
  readonly approvals: ApprovalBroker;
  readonly store: ConversationStore;
  /**
   * The permission gate, exposed alongside `store` and `approvals`.
   *
   * Read-only for callers; tests assert that an approval granted in one conversation
   * is not visible in another, which is a property of this object rather than of any
   * single return value.
   */
  readonly permissions: PermissionGate;
  readonly registry = new ToolRegistry();
  readonly host: PluginHost;
  readonly ctx: Context;

  private config: AppConfig;
  private apiKey = "";
  private provider: LlmProvider;
  private agent: Agent;
  private readonly deps: RuntimeDeps;
  private readonly controller = new Map<string, AbortController>();

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
    this.config = mergeConfig(deps.config);
    this.approvals = deps.approvals ?? new ApprovalBroker();
    this.store = new KeyValueConversationStore(deps.kv);
    this.ctx = new Context({ label: "mobileclaw" });
    this.host = new PluginHost(this.ctx, this.registry);
    // Pass the bound handler, not the broker: the gate needs a plain function so
    // it can also be replaced by a headless approver in tests.
    this.permissions = new PermissionGate(this.config.permissions, this.approvals.request);
    this.provider = this.createProvider();
    this.agent = this.createAgent();
  }

  /** Async bootstrap: load the API key, register capabilities, then reflect them. */
  async start(): Promise<void> {
    this.apiKey = (await this.deps.secrets.get(API_KEY_SECRET)) ?? "";
    await this.loadCapabilities();
    this.provider = this.createProvider();
    this.agent = this.createAgent();
    await this.publishState();
  }

  /** Load (or reload) every capability bundle the app ships. */
  async loadCapabilities(): Promise<void> {
    this.registry.clear();
    const deps: CapabilityDeps = {
      fs: this.deps.fs,
      shell: this.deps.shell,
      http: this.deps.http,
      system: this.deps.system,
    };
    // Publish the platform services first: the host rejects a plugin whose
    // `inject` list is unmet, so they must exist before the bundles load.
    this.ctx.provideAll({
      fs: deps.fs,
      shell: deps.shell,
      http: deps.http,
      system: deps.system,
    });
    await this.host.loadAll(capabilityPlugins(deps));
  }

  /* --------------------------------------------------------------- settings */

  getConfig(): AppConfig {
    return structuredCloneSafe(this.config);
  }

  async updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    const next = mergeConfig({ ...this.config, ...patch });
    this.config = next;
    this.permissions.update(next.permissions);
    // Always rebuild: the provider is a projection of the config, so keeping a
    // stale instance would make providerInfo() disagree with the settings screen.
    this.provider = this.createProvider();
    this.agent = this.createAgent();
    await this.deps.onConfigChange?.(this.getConfig());
    return this.getConfig();
  }

  /**
   * Persist the key, then read it back and adopt whatever storage actually holds.
   *
   * The read-back is the point. Trusting the in-memory value after a successful
   * `set` hides a store that accepts writes but loses them, which then shows up
   * far away as "no API key configured" during a chat turn. Adopting the read-back
   * value means the runtime can only ever be as configured as the device really is.
   */
  async setApiKey(key: string): Promise<{ stored: boolean; detail: string }> {
    const trimmed = key.trim();
    if (trimmed === "") {
      await this.deps.secrets.delete(API_KEY_SECRET);
    } else {
      await this.deps.secrets.set(API_KEY_SECRET, trimmed);
    }

    const readBack = await this.deps.secrets.get(API_KEY_SECRET);
    this.apiKey = readBack ?? "";
    this.provider = this.createProvider();
    this.agent = this.createAgent();
    await this.publishState();

    if (trimmed === "") {
      return { stored: true, detail: "key cleared" };
    }
    if (this.apiKey === "") {
      return {
        stored: false,
        detail: "the secret store accepted the key but returned nothing on read-back",
      };
    }
    if (this.apiKey !== trimmed) {
      return { stored: false, detail: "the secret store returned a different value on read-back" };
    }
    return { stored: true, detail: `stored (${this.apiKey.length} chars)` };
  }

  /** Re-read the key from storage; used by the self-check and after resume. */
  async reloadApiKey(): Promise<boolean> {
    const stored = (await this.deps.secrets.get(API_KEY_SECRET)) ?? "";
    this.apiKey = stored;
    this.provider = this.createProvider();
    this.agent = this.createAgent();
    return stored !== "";
  }

  hasApiKey(): boolean {
    return this.apiKey !== "";
  }

  /**
   * Capability self-check, surfaced in Settings.
   *
   * The API-key round trip is the important part: it writes a probe value to the
   * secret store and reads it back, so a store that silently fails (a missing
   * native module, a Keystore problem) is reported as a storage fault instead of
   * showing up later as "no API key configured" during a chat turn.
   */
  async diagnostics(): Promise<{
    apiKeyPresent: boolean;
    apiKeyLength: number;
    secretStore: { ok: boolean; detail: string };
    provider: { id: string; label: string; model: string; baseUrl: string };
    roots: string[];
    tools: number;
    plugins: { name: string; status: string; tools: number; error?: string }[];
    storageAccess: AllFilesAccessReport;
  }> {
    const secretStore = await this.probeSecretStore();
    // Probed on every call rather than cached: the user can grant access in system
    // settings and come straight back, and a cached "denied" would then be a lie.
    const storageAccess = await this.checkStorageAccess();
    return {
      apiKeyPresent: this.apiKey !== "",
      apiKeyLength: this.apiKey.length,
      secretStore,
      provider: {
        ...this.providerInfo(),
        baseUrl: this.config.provider.baseUrl,
      },
      roots: [...this.config.roots],
      tools: this.registry.names().length,
      plugins: this.pluginStatus(),
      storageAccess,
    };
  }

  /**
   * Whether shared storage is genuinely readable, with the evidence.
   *
   * Without all-files access an Android app still sees directory *names* in shared
   * storage while every file inside reads as non-existent, so the agent concluded
   * folders were empty. This distinguishes "empty" from "not allowed to look".
   */
  async checkStorageAccess(): Promise<AllFilesAccessReport> {
    return probeAllFilesAccess(this.deps.fs);
  }

  /** Open the system screen where all-files access is toggled for this app. */
  async openStorageSettings(): Promise<{ opened: boolean; detail: string }> {
    return openAllFilesSettings(APP_PACKAGE);
  }

  /**
   * This conversation's own output directory, creating it on first use.
   *
   * Rooted in the app's documents directory: it needs no permission, survives a
   * restart, and is trivially removable. See runtime/workspace.ts for why the
   * workspace bounds where new files go rather than what may be read.
   */
  private workspaceFor(conversationId: string): string {
    const path = workspacePath(this.deps.workspaceBaseDir, conversationId);
    // Best-effort: the driver skips creation when the directory already exists, and a
    // failure here surfaces later as a normal tool error rather than crashing a run.
    void this.deps.fs.mkdir(path).catch(() => undefined);
    return path;
  }

  /** Write a probe value, read it back, then restore the real key untouched. */
  private async probeSecretStore(): Promise<{ ok: boolean; detail: string }> {
    const probeKey = "diagnostics.probe";
    const token = `probe_${Date.now()}`;
    try {
      await this.deps.secrets.set(probeKey, token);
      const readBack = await this.deps.secrets.get(probeKey);
      await this.deps.secrets.delete(probeKey);
      if (readBack !== token) {
        return {
          ok: false,
          detail: `wrote a value but read back ${readBack === undefined ? "nothing" : "a different value"}`,
        };
      }
      // Also report what the *real* key looks like in storage, which is the value
      // a cold start would load — not just what this session happens to hold.
      const persistedKey = (await this.deps.secrets.get(API_KEY_SECRET)) ?? "";
      if (this.apiKey !== "" && persistedKey === "") {
        return {
          ok: false,
          detail: "the round trip works, but the saved API key is not in storage (it would be lost on restart)",
        };
      }
      return {
        ok: true,
        detail: `write/read/delete round trip succeeded; API key in storage: ${persistedKey ? `${persistedKey.length} chars` : "none"}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  providerInfo(): { id: string; label: string; model: string } {
    return { id: this.provider.id, label: this.provider.label, model: this.provider.model };
  }

  /** Connectivity/auth probe for the settings screen. */
  async checkProvider(): Promise<{ ok: boolean; message: string }> {
    return this.provider.ping();
  }

  toolNames(): string[] {
    return this.registry.names();
  }

  pluginStatus(): { name: string; status: string; tools: number; error?: string }[] {
    return this.host.list().map((entry) => ({
      name: entry.name,
      status: entry.status,
      tools: entry.toolNames.length,
      ...(entry.error ? { error: entry.error.message } : {}),
    }));
  }

  /* ---------------------------------------------------------- conversations */

  async listConversations(): Promise<{ id: string; title: string; updatedAt: number }[]> {
    return this.store.list();
  }

  async loadConversation(id: string): Promise<Conversation | undefined> {
    return this.store.load(id);
  }

  async deleteConversation(id: string): Promise<void> {
    await this.store.delete(id);
  }

  createConversationId(): string {
    return createId("conv");
  }

  /* ------------------------------------------------------------------- runs */

  /**
   * Stream one user turn as it happens.
   *
   * The agent pushes events synchronously while it awaits providers and tools, so
   * a small queue bridges push→pull: the UI receives each delta immediately
   * instead of waiting for the whole run to finish.
   */
  async *send(
    input: string,
    options: {
      conversationId?: string;
      signal?: AbortSignal;
      onConversation?: (conversation: Conversation) => void;
    } = {},
  ): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    const runId = createId("run");
    const controller = new AbortController();
    this.controller.set(runId, controller);
    const onAbort = (): void => {
      controller.abort();
      // Unblock any modal waiting for the user: the run is over.
      this.approvals.flush({ approved: false });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const queue = new AsyncEventQueue();
    let finished = false;
    let result: AgentRunResult | undefined;
    let failure: unknown;

    const runPromise = this.agent
      .run({
        input,
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        signal: controller.signal,
        ...(options.onConversation ? { onConversation: options.onConversation } : {}),
        assignWorkspace: (conversationId) => this.workspaceFor(conversationId),
        onEvent: (event) => queue.push(event),
      })
      .then((value) => {
        result = value;
      })
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        finished = true;
        queue.close();
      });

    try {
      while (true) {
        const next = await queue.shift();
        if (next === undefined) break;
        yield next;
      }
      await runPromise;
      if (failure) throw failure;
      return result!;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.controller.delete(runId);
    }
  }

  /** Abort every in-flight run (the stop button). */
  stop(): void {
    for (const controller of this.controller.values()) controller.abort();
    this.controller.clear();
    this.approvals.flush({ approved: false });
  }

  /* ---------------------------------------------------------------- private */

  private createProvider(): LlmProvider {
    return new OpenAiCompatibleProvider({
      baseUrl: this.config.provider.baseUrl,
      apiKey: this.apiKey,
      model: this.config.provider.model,
      label: this.config.provider.label,
      timeoutMs: 120_000,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
  }

  private createAgent(): Agent {
    return new Agent({
      provider: this.provider,
      registry: this.registry,
      permissions: this.permissions,
      store: this.store,
      systemPrompt: this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      maxSteps: this.config.provider.maxSteps,
      temperature: this.config.provider.temperature,
      ...(this.deps.environment ? { environment: this.deps.environment } : {}),
      // The workspace differs per conversation, so its wording is supplied here rather
      // than folded into `environment` (which is evaluated before any conversation
      // exists). Without this the agent never learns where to put what it produces.
      describeWorkspace,
    });
  }

  private async publishState(): Promise<void> {
    await this.deps.onConfigChange?.(this.getConfig());
  }
}

/**
 * The run loop pushes events while we are awaiting it, so we buffer them and
 * yield afterwards. `structuredClone` is unavailable on older Hermes builds.
 */
function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Re-exported for the UI so screens import from one module. */
export { DEFAULT_CONFIG, mergeConfig };
export type { AppConfig };
