import { z } from "zod";
import { CoreError, type AnyToolDefinition, type SystemService } from "@mobileclaw/core";

/**
 * Cross-app automation. Which entries actually work depends on the platform
 * service: Android implements most through Intents, iOS reports "unsupported"
 * for the ones the sandbox forbids.
 */
export function createSystemTools(deps: { system: SystemService }): AnyToolDefinition[] {
  const systemOpen = {
    name: "system_open",
    description:
      "Open a URL in the matching app (http/https/mailto/tel/geo), or launch an installed app by package id. Use it to hand the user over to the right app after doing local work.",
    input: z.object({
      url: z.string().optional().describe("URL to open."),
      packageId: z.string().optional().describe("Android package id, e.g. com.android.calendar."),
    }),
    risk: "system",
    summarize: (input) => input.url ?? input.packageId ?? "open",
    async execute(input: { url?: string; packageId?: string }) {
      if (!input.url && !input.packageId) {
        throw new CoreError("E_TOOL_INPUT", "provide `url` or `packageId`");
      }
      if (input.url) await deps.system.openUrl(input.url);
      if (input.packageId) await deps.system.openApp(input.packageId);
      return { ok: true, opened: input.url ?? input.packageId };
    },
  } satisfies AnyToolDefinition;

  const systemApps = {
    name: "system_apps",
    description: "List installed apps (Android only) so you can pick a package id for system_open.",
    input: z.object({ filter: z.string().optional().describe("Case-insensitive substring filter.") }),
    risk: "read",
    async execute(input: { filter?: string }) {
      if (!deps.system.listApps) {
        throw new CoreError("E_TOOL_FAILED", "listing installed apps is not supported on this platform");
      }
      const apps = await deps.system.listApps();
      const filter = input.filter?.toLowerCase();
      return {
        count: apps.length,
        apps: (filter ? apps.filter((app) => app.label.toLowerCase().includes(filter) || app.packageId.includes(filter)) : apps).slice(0, 100),
      };
    },
  } satisfies AnyToolDefinition;

  const systemClipboard = {
    name: "system_clipboard",
    description:
      "Read or write the system clipboard. This is the most reliable way to move text between apps when no direct API exists.",
    input: z.object({
      action: z.enum(["get", "set"]),
      text: z.string().optional().describe("Required when action is set."),
    }),
    risk: "system",
    summarize: (input) => `clipboard ${input.action}`,
    async execute(input: { action: "get" | "set"; text?: string }) {
      if (input.action === "set") {
        if (input.text === undefined) throw new CoreError("E_TOOL_INPUT", "`text` is required to set the clipboard");
        if (!deps.system.setClipboard) throw new CoreError("E_TOOL_FAILED", "clipboard write is not supported here");
        await deps.system.setClipboard(input.text);
        return { ok: true, chars: input.text.length };
      }
      if (!deps.system.getClipboard) throw new CoreError("E_TOOL_FAILED", "clipboard read is not supported here");
      const text = await deps.system.getClipboard();
      return { text, chars: text.length };
    },
  } satisfies AnyToolDefinition;

  const systemShare = {
    name: "system_share",
    description: "Open the system share sheet with text (or a file path) so the user can send it to any app.",
    input: z.object({
      text: z.string().min(1),
      title: z.string().optional(),
    }),
    risk: "system",
    alwaysAsk: true,
    summarize: (input) => `share ${input.text.length} chars`,
    async execute(input: { text: string; title?: string }) {
      if (!deps.system.shareText) throw new CoreError("E_TOOL_FAILED", "sharing is not supported here");
      await deps.system.shareText(input.text, input.title);
      return { ok: true };
    },
  } satisfies AnyToolDefinition;

  const systemNotify = {
    name: "system_notify",
    description: "Post a local notification. Use for long-running work you finished in the background.",
    input: z.object({ title: z.string().min(1), body: z.string().optional() }),
    risk: "system",
    summarize: (input) => `notify: ${input.title}`,
    async execute(input: { title: string; body?: string }) {
      if (!deps.system.notify) throw new CoreError("E_TOOL_FAILED", "notifications are not supported here");
      await deps.system.notify({ title: input.title, ...(input.body ? { body: input.body } : {}) });
      return { ok: true };
    },
  } satisfies AnyToolDefinition;

  const systemCalendar = {
    name: "system_calendar",
    description:
      "Create a calendar event (reminder/schedule). Provide ISO-8601 local times or epoch milliseconds.",
    input: z.object({
      title: z.string().min(1),
      start: z.string().describe("ISO-8601 start time, e.g. 2026-03-01T09:00:00"),
      end: z.string().optional().describe("ISO-8601 end time; defaults to start + 1 hour."),
      description: z.string().optional(),
      location: z.string().optional(),
      durationMinutes: z.number().int().min(5).max(24 * 60).optional().default(60),
    }),
    risk: "system",
    alwaysAsk: true,
    summarize: (input) => `calendar: ${input.title} @ ${input.start}`,
    async execute(input: {
      title: string;
      start: string;
      end?: string;
      description?: string;
      location?: string;
      durationMinutes: number;
    }) {
      if (!deps.system.createCalendarEvent) {
        throw new CoreError("E_TOOL_FAILED", "calendar writes are not supported here", {
          hint: "on iOS this requires the calendar entitlement and a native implementation",
        });
      }
      const startMs = parseTime(input.start);
      const endMs = input.end ? parseTime(input.end) : startMs + input.durationMinutes * 60_000;
      const event = await deps.system.createCalendarEvent({
        title: input.title,
        startMs,
        endMs,
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {}),
      });
      return { ok: true, id: event.id, startMs, endMs };
    },
  } satisfies AnyToolDefinition;

  return [systemOpen, systemApps, systemClipboard, systemShare, systemNotify, systemCalendar];
}

export function parseTime(value: string): number {
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new CoreError("E_TOOL_INPUT", `could not parse time: ${value}`, {
      hint: "use ISO-8601 like 2026-03-01T09:00:00 or epoch milliseconds",
    });
  }
  return parsed;
}
