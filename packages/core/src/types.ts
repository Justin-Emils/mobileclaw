/**
 * Capability contracts (services) and the LLM-facing data model.
 *
 * These interfaces are the seam between the kernel and the platform: the agent
 * loop only ever talks to these, so the same core runs on Node (tests, desktop
 * CLI) and inside React Native with native modules behind it.
 */

/* ------------------------------------------------------------------ LLM model */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON arguments; kept as an object when the provider gave us one. */
  input: unknown;
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCallRequest[];
  /** Present on tool messages, linking back to the request. */
  toolCallId?: string;
  name?: string;
  /** Epoch ms; UI only. */
  at?: number;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: import("./tool.js").ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  message: ChatMessage;
  usage?: Usage;
  finishReason?: string;
}

/** Incremental events emitted while streaming a completion. */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; id: string; name: string; inputDelta: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason?: string };

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  /** Streaming call; must be cancellable through `request.signal`. */
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>;
  /** Convenience non-streaming call built on `stream`. */
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** Cheap connectivity/auth probe for the settings screen. */
  ping(signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
}

/* ------------------------------------------------------------ File system svc */

export interface FileStat {
  path: string;
  name: string;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  mtimeMs?: number;
}

export interface DirEntry extends FileStat {
  /** Path relative to the directory that was listed. */
  relative: string;
  /**
   * The name was listed but its metadata could not be read.
   *
   * This happens when the app is missing Android's all-files access. Dropping such
   * entries made a full directory look empty, which is how the agent came to report
   * "these folders are empty" for folders that were full. Kept as a visible entry
   * with `isDirectory`/`isFile` both false so callers must decide what to say about
   * it rather than silently omitting it.
   */
  unreadable?: boolean;
}

/**
 * What a recursive walk could not read.
 *
 * Reported because "0 results" and "0 results because nothing was readable" are
 * different findings: without all-files access the second is what a search returns
 * for a directory full of files, and a silent zero sends the user looking for files
 * that are right there.
 */
export interface WalkStats {
  /** Directories that could not be listed at all (their subtrees were skipped). */
  unreadableDirectories: number;
  /** Entries whose name resolved but whose metadata could not be read. */
  unreadableEntries: number;
  /** The walk hit its visit limit and stopped early. */
  truncated: boolean;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface FileSystemService {
  readonly kind: string;
  /** Directory listings returned when no explicit path is given. */
  roots(): Promise<string[]>;
  /**
   * What the most recent glob/grep walk could not read.
   *
   * Optional so lightweight implementations (tests, the demo driver) need not track
   * it. Callers that show search results should surface it: a search that returns
   * nothing because nothing was readable is a permission problem, not an empty
   * directory, and reporting it as the latter is actively misleading.
   */
  walkStats?(): WalkStats;
  /** Clear the counters before a new search so they describe that search. */
  resetWalkStats?(): void;
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array): Promise<FileStat>;
  append?(path: string, data: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<DirEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /** Glob search; implementations may cap the number of visited entries. */
  glob(pattern: string, options?: { cwd?: string; limit?: number }): Promise<string[]>;
  /** Content search across files under a directory. */
  grep(
    pattern: string,
    options?: { path?: string; limit?: number; ignoreCase?: boolean },
  ): Promise<GrepMatch[]>;
}

/* --------------------------------------------------------------- Command svc */

export interface ShellResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when the host refused to run the command (policy, not the OS). */
  blocked?: boolean;
}

export interface ShellRunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Text piped to the command's stdin. This is how snippets are executed without
   * ever being interpolated into a command line (e.g. `python3 -`).
   */
  stdin?: string;
  /** Bytes of combined output to keep. Defaults to the backend's limit. */
  maxOutputBytes?: number;
}

export interface ShellService {
  readonly kind: string;
  /** Whether this backend can actually execute commands on this device. */
  available(): Promise<boolean>;
  /** Why it is unavailable, for the diagnostics screen. */
  reason?(): Promise<string>;
  run(command: string, options?: ShellRunOptions): Promise<ShellResult>;
}

/* ---------------------------------------------------------------- System svc */

/**
 * Cross-app automation surface. On Android these are Intents / ContentProvider
 * writes; on iOS most entries simply report `supported: false`.
 */
export interface SystemService {
  readonly kind: string;
  openUrl(url: string): Promise<void>;
  openApp(packageName: string): Promise<void>;
  listApps?(): Promise<{ packageId: string; label: string }[]>;
  sendIntent?(intent: {
    action: string;
    data?: string;
    package?: string;
    extras?: Record<string, string>;
  }): Promise<void>;
  createCalendarEvent?(event: {
    title: string;
    startMs: number;
    endMs: number;
    description?: string;
    location?: string;
  }): Promise<{ id: string }>;
  /** Clipboard read/write; used for cross-app information transfer. */
  getClipboard?(): Promise<string>;
  setClipboard?(text: string): Promise<void>;
  /** Share sheet, the safest way to hand content to another app. */
  shareText?(text: string, title?: string): Promise<void>;
  notify?(notification: { title: string; body?: string }): Promise<void>;
  /** Privileged shell via Shizuku/ADB when the user has paired the device. */
  privileged?: PrivilegedService;
  /** Screen capture and input injection, when a privileged backend is available. */
  automation?: AutomationService;
}

export interface PrivilegedService {
  readonly kind: string;
  isAvailable(): Promise<boolean>;
  requestPermission?(): Promise<boolean>;
  run(command: string, options?: ShellRunOptions): Promise<ShellResult>;
}

/**
 * Screen automation through a privileged backend (Shizuku, shell uid 2000).
 *
 * Deliberately separate from `PrivilegedService`, which only runs commands: these
 * are about what is *on screen*, and each one either changes it or exposes it.
 *
 * The geometry lives in the implementation, not here. The model cannot see the
 * screen, so it cannot invent coordinates — a tap point comes from the user
 * pointing at a capture, and scrolling is expressed as a direction and resolved
 * against the real display size.
 */
export interface AutomationService {
  readonly kind: string;
  /** Whether the backend can act right now, and if not, what the user should do. */
  status(): Promise<AutomationStatus>;
  /**
   * Capture the screen, downscaled, and save it where the UI can render it.
   *
   * A window that sets `FLAG_SECURE` (banking, some password fields) comes back
   * black; the result says so rather than reporting an empty screen.
   */
  captureScreen(options?: {
    maxWidth?: number;
    quality?: number;
    /** Directory the capture should land in; the conversation workspace when known. */
    destDir?: string;
  }): Promise<ScreenCapture>;
  tap(x: number, y: number): Promise<void>;
  scroll(direction: "up" | "down" | "left" | "right", fraction?: number): Promise<void>;
  /**
   * Type into whatever holds focus.
   *
   * The method is reported because it is user-visible: Chinese cannot go through
   * the `input` command, so it is routed via the clipboard and a paste keystroke,
   * which overwrites whatever the user had copied.
   */
  typeText(text: string): Promise<{ method: "input" | "paste" }>;
  /**
   * Which app is in the foreground.
   *
   * Best effort: the values come from parsing debug output, so on some ROMs this
   * returns nothing. `raw` is kept so an empty result is diagnosable rather than
   * looking like "nothing is open".
   */
  currentWindow(): Promise<ForegroundWindow>;
}

export interface AutomationStatus {
  available: boolean;
  /** Where the privilege comes from, e.g. `shizuku`. */
  backend?: string;
  /** 0 when running as root, 2000 when riding on ADB. */
  uid?: number;
  reason?: string;
  /** What the user has to do to make this work, in their own language. */
  howTo?: string;
}

export interface ScreenCapture {
  /** A `file://` URI the UI can render directly. */
  path: string;
  /** Pixel size of the capture, i.e. the coordinate space taps are expressed in. */
  width: number;
  height: number;
  /** Set when the frame is unusable for a reason the user should know. */
  note?: string;
}

export interface ForegroundWindow {
  package?: string;
  activity?: string;
  /** The line the values were parsed from, so a miss can be diagnosed. */
  raw: string;
}

/* ------------------------------------------------------------------ Web svc */

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
}

export interface HttpService {
  readonly kind: string;
  fetch(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
}

/* ----------------------------------------------------------- Persistence svc */

export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/* ---------------------------------------------------------------- Transcript */

export type TranscriptEntry =
  | { kind: "message"; id: string; at: number; message: ChatMessage }
  | {
      kind: "tool";
      id: string;
      at: number;
      callId: string;
      name: string;
      input: unknown;
      summary?: string;
      status: "running" | "ok" | "error" | "denied";
      output?: string;
      durationMs?: number;
      error?: string;
      /**
       * Screenshot of what the action did, when the tool produced one.
       *
       * The "show your work" half of the automation promise: the user is shown the
       * result rather than asked to trust a sentence the model wrote about it.
       */
      evidence?: ScreenCapture;
      /** Why the evidence is missing, when the action ran but produced none. */
      evidenceNote?: string;
    }
  | { kind: "notice"; id: string; at: number; level: "info" | "warn" | "error"; text: string };

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  messages: ChatMessage[];
  entries: TranscriptEntry[];
  /** Tool names the user permanently allowed for this conversation. */
  allowlist?: string[];
  /**
   * Directory this conversation owns for files the agent produces.
   *
   * Stored rather than derived on every run so it survives a restart and stays
   * stable even if the naming scheme changes later. Assigned by the app on the
   * conversation's first run (see apps/mobile/src/runtime/workspace.ts).
   */
  workspace?: string;
}

export interface ConversationStore {
  create(input?: { id?: string; title?: string; model?: string }): Promise<Conversation>;
  load(id: string): Promise<Conversation | undefined>;
  save(conversation: Conversation): Promise<void>;
  list(): Promise<{ id: string; title: string; updatedAt: number }[]>;
  delete(id: string): Promise<void>;
}
