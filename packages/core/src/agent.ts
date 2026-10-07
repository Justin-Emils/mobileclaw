import { createId } from "./store";
import { describeInput, ToolRegistry } from "./tools-registry";
import { CoreError, safeStringify, toCoreError } from "./errors";
import { PermissionGate } from "./permission";
import type { AnyToolDefinition } from "./tool";
import type {
  ChatMessage,
  Conversation,
  ConversationStore,
  LlmProvider,
  Usage,
} from "./types";

export interface AgentOptions {
  provider: LlmProvider;
  registry: ToolRegistry;
  permissions: PermissionGate;
  store: ConversationStore;
  /** Base system prompt; the tool inventory is appended automatically. */
  systemPrompt?: string;
  /** Hard cap on model↔tool round trips per user turn. */
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  /** Restrict the tools offered to the model. */
  toolSelection?: string[];
  onEvent?: (event: AgentEvent) => void;
  /** Extra context appended to the system prompt (device facts, roots, ...). */
  environment?: () => string | Promise<string>;
}

export type AgentEvent =
  | { type: "step"; step: number }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "assistant"; message: ChatMessage }
  | { type: "tool_start"; callId: string; name: string; input: unknown; summary?: string }
  | {
      type: "tool_end";
      callId: string;
      name: string;
      status: "ok" | "error" | "denied";
      output?: string;
      error?: string;
      durationMs: number;
    }
  | { type: "denied"; name: string; reason: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; text: string; steps: number; stopReason: StopReason };

export type StopReason = "completed" | "step_limit" | "cancelled" | "error";

export interface AgentRunResult {
  conversationId: string;
  text: string;
  steps: number;
  stopReason: StopReason;
  usage: Usage;
  toolCalls: number;
  error?: CoreError;
}

export interface AgentRunInput {
  input: string;
  conversationId?: string;
  signal?: AbortSignal;
  /** Called with the conversation after every mutation, for persistence/UI. */
  onConversation?: (conversation: Conversation) => void;
  /** Per-run event observer; overrides the agent-level one for this run. */
  onEvent?: (event: AgentEvent) => void;
}

/**
 * The agent loop: stream a completion, execute any requested tools under the
 * permission gate, feed results back, and repeat until the model stops asking
 * for tools or the step budget runs out.
 */
export class Agent {
  private readonly store: ConversationStore;

  constructor(private readonly options: AgentOptions) {
    this.store = options.store;
  }

  /** Tool schemas the model will see on the next turn. */
  toolSchemas(): ReturnType<ToolRegistry["schemas"]> {
    return this.resolveTools().length === 0
      ? []
      : this.options.registry.schemas(
          this.options.toolSelection && this.options.toolSelection.length > 0
            ? this.options.toolSelection
            : undefined,
        );
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { signal } = input;
    // Callers may pass a per-run observer (the app's streaming UI does) in
    // addition to the one configured on the agent instance.
    const observer = input.onEvent ?? this.options.onEvent;
    const emit = (event: AgentEvent): void => observer?.(event);
    const maxSteps = this.options.maxSteps ?? 12;
    const usage: Usage = {};
    let toolCallCount = 0;

    const conversation = input.conversationId
      ? (await this.store.load(input.conversationId)) ??
        (await this.store.create({ id: input.conversationId }))
      : await this.store.create({ title: titleFrom(input.input) });

    const persist = async (): Promise<void> => {
      await this.store.save(conversation);
      input.onConversation?.(conversation);
    };

    const userMessage: ChatMessage = { role: "user", content: input.input, at: Date.now() };
    conversation.messages.push(userMessage);
    conversation.entries.push({
      kind: "message",
      id: createId("entry"),
      at: Date.now(),
      message: userMessage,
    });
    if (conversation.messages.length === 1) conversation.title = titleFrom(input.input);
    await persist();

    let steps = 0;
    let finalText = "";

    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        steps = step;
        if (signal?.aborted) {
          return await this.finish(
            conversation,
            finalText,
            steps,
            "cancelled",
            usage,
            toolCallCount,
            persist,
            emit,
          );
        }
        emit({ type: "step", step });

        const system = await this.buildSystemPrompt();
        const request = {
          model: this.options.provider.model,
          messages: [{ role: "system" as const, content: system }, ...conversation.messages],
          tools: this.toolSchemas(),
          ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
          ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
          ...(signal ? { signal } : {}),
        };

        let assistantText = "";
        let assistantReasoning = "";
        const calls = new Map<string, { name: string; args: string; order: number }>();
        let finishReason: string | undefined;
        let order = 0;

        for await (const event of this.options.provider.stream(request)) {
          switch (event.type) {
            case "text":
              assistantText += event.delta;
              emit({ type: "text", delta: event.delta });
              break;
            case "reasoning":
              assistantReasoning += event.delta;
              emit({ type: "reasoning", delta: event.delta });
              break;
            case "tool_call": {
              const existing = calls.get(event.id);
              if (existing) {
                if (event.name) existing.name = event.name;
                existing.args += event.inputDelta;
              } else {
                calls.set(event.id, { name: event.name, args: event.inputDelta, order: order++ });
              }
              break;
            }
            case "usage":
              mergeUsage(usage, event.usage);
              emit({ type: "usage", usage: { ...usage } });
              break;
            case "done":
              if (event.finishReason) finishReason = event.finishReason;
              break;
          }
        }

        const assistantMessage: ChatMessage = {
          role: "assistant",
          content: assistantText,
          at: Date.now(),
        };
        if (calls.size > 0) {
          assistantMessage.toolCalls = [...calls.entries()]
            .sort((a, b) => a[1].order - b[1].order)
            .map(([id, call]) => ({
              id,
              name: call.name,
              input: parseArguments(call.args),
            }));
        }
        if (assistantText === "" && assistantReasoning !== "") {
          // Surface reasoning-only turns instead of emitting an empty bubble.
          assistantMessage.content = assistantReasoning;
        }
        conversation.messages.push(assistantMessage);
        conversation.entries.push({
          kind: "message",
          id: createId("entry"),
          at: Date.now(),
          message: assistantMessage,
        });
        if (assistantText !== "") {
          // Accumulate across steps so an intermediate explanation is not lost
          // when a later step consists only of tool calls.
          finalText = finalText === "" ? assistantText : `${finalText}\n\n${assistantText}`;
        }
        emit({ type: "assistant", message: assistantMessage });
        await persist();

        const requested = assistantMessage.toolCalls ?? [];
        if (requested.length === 0) {
          return await this.finish(
            conversation,
            finalText,
            steps,
            "completed",
            usage,
            toolCallCount,
            persist,
            emit,
          );
        }

        // Every tool call must be answered, otherwise the next request is invalid.
        for (const call of requested) {
          if (signal?.aborted) {
            conversation.messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: "[E_CANCELLED] run cancelled before this call executed",
            });
            await persist();
            return await this.finish(
              conversation,
              finalText,
              steps,
              "cancelled",
              usage,
              toolCallCount,
              persist,
              emit,
            );
          }
          toolCallCount += 1;
          const result = await this.executeCall(call, conversation, signal, emit);
          conversation.messages.push(result.message);
          conversation.entries.push(result.entry);
          await persist();
        }
      }

      const notice = `Reached the step limit (${maxSteps}) before the task finished.`;
      conversation.entries.push({
        kind: "notice",
        id: createId("entry"),
        at: Date.now(),
        level: "warn",
        text: notice,
      });
      await persist();
      emit({ type: "done", text: finalText, steps, stopReason: "step_limit" });
      return {
        conversationId: conversation.id,
        text: finalText,
        steps,
        stopReason: "step_limit",
        usage,
        toolCalls: toolCallCount,
      };
    } catch (error) {
      const coreError = toCoreError(error, "E_PROVIDER");
      const stopReason: StopReason =
        coreError.code === "E_CANCELLED" ? "cancelled" : "error";
      conversation.entries.push({
        kind: "notice",
        id: createId("entry"),
        at: Date.now(),
        level: "error",
        text: coreError.message,
      });
      await persist();
      emit({ type: "done", text: finalText, steps, stopReason });
      return {
        conversationId: conversation.id,
        text: finalText,
        steps,
        stopReason,
        usage,
        toolCalls: toolCallCount,
        error: coreError,
      };
    }
  }

  /** Run one tool call through permissions, registry and event reporting. */
  private async executeCall(
    call: { id: string; name: string; input: unknown },
    conversation: Conversation,
    signal: AbortSignal | undefined,
    emit: (event: AgentEvent) => void,
  ): Promise<{ message: ChatMessage; entry: Conversation["entries"][number] }> {
    const started = Date.now();
    let definition: AnyToolDefinition | undefined;
    try {
      definition = this.options.registry.get(call.name);
    } catch {
      definition = undefined;
    }

    let paths: string[] = [];
    if (definition?.paths) {
      try {
        const parsed = definition.input.safeParse(call.input);
        if (parsed.success) paths = definition.paths(parsed.data as never) ?? [];
      } catch {
        paths = [];
      }
    }
    const summary = definition ? describeInput(definition, call.input) : undefined;
    emit({ type: "tool_start", callId: call.id, name: call.name, input: call.input, summary });

    // Ask the gate first so the prompt the user sees carries the real verdict,
    // not a generic "this needs approval" string.
    const verdict = this.options.permissions.evaluate({
      tool: call.name,
      risk: definition?.risk ?? "system",
      input: call.input,
      paths,
      ...(summary ? { summary } : {}),
      conversationId: conversation.id,
      ...(definition ? { definition } : {}),
    });
    const decision = await this.options.permissions.authorize({
      tool: call.name,
      risk: definition?.risk ?? "system",
      input: call.input,
      paths,
      ...(summary ? { summary } : {}),
      reason: verdict.allowed ? verdict.reason : `${verdict.reason} — requires confirmation`,
      conversationId: conversation.id,
      ...(definition ? { definition } : {}),
    });

    if (!decision.allowed) {
      const durationMs = Date.now() - started;
      emit({ type: "denied", name: call.name, reason: decision.reason });
      emit({
        type: "tool_end",
        callId: call.id,
        name: call.name,
        status: "denied",
        error: decision.reason,
        durationMs,
      });
      return {
        message: {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: `[E_PERMISSION_DENIED] ${decision.reason}. Do not retry; tell the user what you need and why.`,
          at: Date.now(),
        },
        entry: {
          kind: "tool",
          id: createId("entry"),
          at: started,
          callId: call.id,
          name: call.name,
          input: call.input,
          ...(summary ? { summary } : {}),
          status: "denied",
          error: decision.reason,
          durationMs,
        },
      };
    }

    const outcome = await this.options.registry.execute(call.name, call.input, {
      signal: signal ?? new AbortController().signal,
      callId: call.id,
      conversationId: conversation.id,
    });
    const durationMs = Date.now() - started;

    if (!outcome.ok) {
      emit({
        type: "tool_end",
        callId: call.id,
        name: call.name,
        status: "error",
        error: outcome.error.message,
        durationMs,
      });
      return {
        message: {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: outcome.error.toToolResult(),
          at: Date.now(),
        },
        entry: {
          kind: "tool",
          id: createId("entry"),
          at: started,
          callId: call.id,
          name: call.name,
          input: call.input,
          ...(summary ? { summary } : {}),
          status: "error",
          error: outcome.error.toToolResult(),
          durationMs,
        },
      };
    }

    const rendered = renderToolOutput(outcome.value);
    emit({
      type: "tool_end",
      callId: call.id,
      name: call.name,
      status: "ok",
      output: rendered.text,
      durationMs,
    });
    return {
      message: {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: rendered.text,
        at: Date.now(),
      },
      entry: {
        kind: "tool",
        id: createId("entry"),
        at: started,
        callId: call.id,
        name: call.name,
        input: call.input,
        ...(summary ? { summary } : {}),
        status: "ok",
        output: rendered.preview,
        durationMs,
      },
    };
  }

  async buildSystemPrompt(): Promise<string> {
    const base =
      this.options.systemPrompt ??
      DEFAULT_SYSTEM_PROMPT;
    const tools = this.resolveTools();
    const inventory =
      tools.length === 0
        ? "No tools are available right now."
        : tools
            .map((tool) => `- ${tool.name} (${tool.risk}): ${tool.description}`)
            .join("\n");
    const environment = this.options.environment
      ? await this.options.environment()
      : "";
    return [
      base,
      "",
      "## Available tools",
      inventory,
      environment ? `\n## Environment\n${environment}` : "",
    ]
      .join("\n")
      .trim();
  }

  private resolveTools(): AnyToolDefinition[] {
    const selection = this.options.toolSelection;
    return selection && selection.length > 0
      ? this.options.registry.select(selection)
      : this.options.registry.list();
  }

  private async finish(
    conversation: Conversation,
    text: string,
    steps: number,
    stopReason: StopReason,
    usage: Usage,
    toolCalls: number,
    persist: () => Promise<void>,
    emit: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    await persist();
    emit({ type: "done", text, steps, stopReason });
    return { conversationId: conversation.id, text, steps, stopReason, usage, toolCalls };
  }
}

export const DEFAULT_SYSTEM_PROMPT = `You are MobileClaw, a local agent running on the user's own phone.

You act through tools. Prefer doing the work over describing it: inspect the filesystem, run the command, read the file, then report exactly what changed.

Rules:
- Answer in the user's language.
- Never invent file contents, paths, or command output. If you did not read it, say so.
- Before destructive or irreversible operations (delete, overwrite, mass rename, sending data off-device), state the plan and ask the user first.
- Prefer the narrowest tool that does the job, and batch independent reads into one step.
- When a tool returns an error code, adapt: read the error, fix the input, or explain the blocker.
- Keep replies short. Show paths, commands and results; skip filler.`;

/** Tool output is both rendered to the model and previewed in the UI. */
export function renderToolOutput(value: unknown): { text: string; preview: string } {
  if (typeof value === "string") {
    return { text: value, preview: truncate(value, 400) };
  }
  const text = safeStringify(value, 0);
  return { text, preview: truncate(text, 400) };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function parseArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Keep the raw string so validation reports a useful error.
    return trimmed;
  }
}

function mergeUsage(target: Usage, next: Usage): void {
  if (next.promptTokens !== undefined) target.promptTokens = next.promptTokens;
  if (next.completionTokens !== undefined) target.completionTokens = next.completionTokens;
  if (next.totalTokens !== undefined) target.totalTokens = next.totalTokens;
}

function titleFrom(input: string): string {
  const firstLine = input.trim().split("\n")[0] ?? "";
  const clean = firstLine.replace(/\s+/g, " ").trim();
  if (clean === "") return "New chat";
  return clean.length <= 40 ? clean : `${clean.slice(0, 40)}…`;
}
