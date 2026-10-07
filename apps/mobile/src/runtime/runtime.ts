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
import { API_KEY_SECRET, type SecretStore, type SecretStorageStatus } from "./services/secrets";
import { createSelfTestProvider, selfTestPath } from "./services/self-test";

/**
 * Prompt for the in-app self-test. Phrased as a real request so the scripted transport's
 * tool call reads naturally in the transcript.
 */
const SELF_TEST_PROMPT = "自检：请列出下载目录里的文件";
const SELF_TEST_TITLE = "自检会话";
import {
  probeAllFilesAccess,
  type AllFilesAccessReport,
} from "./services/permissions";
import { openAllFilesSettings } from "./services/settings-launcher";
import {
  checkLegacyStoragePermissions,
  requestLegacyStoragePermissions,
  type RuntimePermissionOutcome,
} from "./services/storage-permissions";
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
    /** Which backend holds the API key, and whether it is encrypted. */
    secretBackend: SecretStorageStatus;
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
      secretBackend: this.deps.secrets.status?.() ?? {
        backend: "keychain" as const,
        encrypted: true,
        detail: "此实现未报告后端",
      },
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
    // Roots are passed in because the probe must stay inside them: the path guard
    // rejects anything else, which previously made the verdict permanent `unknown`.
    const report = await probeAllFilesAccess(this.deps.fs, [...this.config.roots]);
    // Logged because the verdict is a heuristic over several probe directories, and a
    // wrong one is indistinguishable from a real permission problem without the raw
    // per-probe evidence. `adb logcat -s ReactNativeJS` shows it on a device.
    console.log(`[mobileclaw] storage access=${report.status} ${report.detail}`);
    return report;
  }

  /** Open the system screen where all-files access is toggled for this app. */
  async openStorageSettings(): Promise<{ opened: boolean; detail: string }> {
    return openAllFilesSettings(APP_PACKAGE);
  }

  /**
   * Ask for the legacy shared-storage permissions.
   *
   * Separate from the all-files probe: `MANAGE_EXTERNAL_STORAGE` cannot be requested
   * and only lives in system settings, while these two do have a dialog and are what
   * Android 12 and below actually enforce.
   */
  async requestStoragePermissions(): Promise<RuntimePermissionOutcome> {
    return requestLegacyStoragePermissions();
  }

  /** Whether those permissions are already granted, without prompting. */
  async checkStoragePermissions(): Promise<RuntimePermissionOutcome> {
    return checkLegacyStoragePermissions();
  }

  /**
   * Small persisted flags, for "have we already done this once" questions.
   *
   * A generic pair rather than one method per flag: the alternative is a new runtime
   * method every time the UI needs to remember something, and these carry no domain
   * meaning worth modelling.
   */
  async getFlag(key: string): Promise<string | undefined> {
    return this.deps.kv.get(`flag:${key}`);
  }

  async setFlag(key: string, value: string): Promise<void> {
    await this.deps.kv.set(`flag:${key}`, value);
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

  /**
   * Run one turn through the real pipeline using a scripted transport.
   *
   * Why this exists: proving the agent works end to end otherwise needs an API key and a
   * model, which makes it impossible to check on a device that has neither -- and the parts
   * that only appear on a real run (the tool registry, the permission gate, the workspace
   * assigned on a conversation's first turn, the transcript, the persistence) are exactly
   * the parts worth checking. Nothing is faked except the model's *words*: the tool call is
   * a genuine `fs_list`, gated and executed by the same code a real turn uses.
   *
   * The scripted transport and a placeholder key are installed only for the duration and
   * always restored, so a self-test cannot change how the app behaves afterwards.
   */
  async runSelfTest(): Promise<{
    ok: boolean;
    detail: string;
    conversationId: string;
    workspace: string;
    toolCalls: string[];
  }> {
    const savedProvider = this.provider;
    const savedKey = this.apiKey;
    const scripted = createSelfTestProvider(selfTestPath(this.config.roots));
    const conversation = await this.store.create({ title: SELF_TEST_TITLE });
    const conversationId = conversation.id;
    const workspace = this.workspaceFor(conversationId);
    const toolCalls: string[] = [];
    const toolFailures: string[] = [];
    let failure: string | undefined;

    try {
      // The provider is swapped rather than the transport, so no request is made and no
      // API key is needed. The placeholder below only satisfies the provider interface.
      this.provider = scripted;
      this.apiKey = "selftest-not-a-real-key";
      this.agent = this.createAgent();

      // Driven by hand rather than `for await`, because a generator's *return value*
      // carries the run result -- including the CoreError behind `stopReason: "error"`.
      // `for await` discards it, which is why the first version could only say
      // "运行以 error 结束" without saying why.
      const run = this.send(SELF_TEST_PROMPT, { conversationId });
      let step = await run.next();
      while (!step.done) {
        const event = step.value;
        if (event.type === "tool_start") toolCalls.push(event.name);
        if (event.type === "tool_end" && event.status !== "ok") {
          toolFailures.push(`${event.name}: ${event.error ?? event.status}`);
        }
        if (event.type === "denied") {
          toolFailures.push(`${event.name} 被拒绝: ${event.reason}`);
        }
        step = await run.next();
      }
      const result = step.value;
      if (result.error) {
        failure = `${result.error.code}: ${result.error.message}`;
      } else if (result.stopReason !== "completed") {
        failure = `运行结束于 ${result.stopReason}`;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.provider = savedProvider;
      this.apiKey = savedKey;
      this.agent = this.createAgent();
      await this.publishState();
    }

    // Read the conversation back from storage rather than trusting in-memory state: the
    // point of the exercise is that the turn was persisted.
    const stored = await this.loadConversation(conversationId);
    const persisted = (stored?.entries?.length ?? 0) > 0;
    const sawTool = scripted.sawToolResult();
    // A tool failure must fail the self-test even if the run itself completed. The first
    // version passed while a spurious empty tool call had errored, which is exactly the
    // kind of "green light hiding a real problem" the check exists to avoid.
    const ok = !failure && toolFailures.length === 0 && sawTool && toolCalls.length > 0 && persisted;

    // Surface a tool error even when the run itself finished, and name the tools that
    // exist -- an unknown tool name is the likeliest cause of "调用了但没结果".
    const available = this.toolNames();
    const lines = [
      `工具调用: ${toolCalls.length > 0 ? toolCalls.join(", ") : "无"}`,
      `工具结果回到模型: ${sawTool ? "是" : "否"}`,
      `会话已写入存储: ${persisted ? `是（${stored?.entries?.length ?? 0} 条记录）` : "否"}`,
      `会话工作区: ${workspace}`,
      `已注册工具: ${available.length > 0 ? available.join(", ") : "无"}`,
      ...(toolFailures.length > 0 ? [`工具错误: ${toolFailures.join("; ")}`] : []),
      ...(failure ? [`错误: ${failure}`] : []),
    ];
    return { ok, detail: lines.join("\n"), conversationId, workspace, toolCalls };
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
