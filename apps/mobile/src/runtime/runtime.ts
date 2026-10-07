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
  readonly registry = new ToolRegistry();
  readonly host: PluginHost;
  readonly ctx: Context;

  private config: AppConfig;
  private apiKey = "";
  private gate: PermissionGate;
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
    this.gate = new PermissionGate(this.config.permissions, this.approvals.request);
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
    this.gate.update(next.permissions);
    // Always rebuild: the provider is a projection of the config, so keeping a
    // stale instance would make providerInfo() disagree with the settings screen.
    this.provider = this.createProvider();
    this.agent = this.createAgent();
    await this.deps.onConfigChange?.(this.getConfig());
    return this.getConfig();
  }

  async setApiKey(key: string): Promise<void> {
    this.apiKey = key.trim();
    if (this.apiKey === "") await this.deps.secrets.delete(API_KEY_SECRET);
    else await this.deps.secrets.set(API_KEY_SECRET, this.apiKey);
    this.provider = this.createProvider();
    this.agent = this.createAgent();
    await this.publishState();
  }

  hasApiKey(): boolean {
    return this.apiKey !== "";
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
      permissions: this.gate,
      store: this.store,
      systemPrompt: this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      maxSteps: this.config.provider.maxSteps,
      temperature: this.config.provider.temperature,
      ...(this.deps.environment ? { environment: this.deps.environment } : {}),
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
