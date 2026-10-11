import { z } from "zod";
import { CoreError, type AnyToolDefinition, type ForegroundWindow, type SystemService } from "@mobileclaw/core";
import { awaitArrival, describeArrival } from "../app-state";
import { isOpenableUrl, isPlausiblePackageId, packageIdRejection, urlRejection } from "../deep-link";

/**
 * Cross-app automation. Which entries actually work depends on the platform
 * service: Android implements most through Intents, iOS reports "unsupported"
 * for the ones the sandbox forbids.
 */
export function createSystemTools(deps: {
  system: SystemService;
  /**
   * Read which app (and screen) is in the foreground, so a launch can be checked.
   *
   * Defaults to the screen backend already carried by `SystemService`, which is the same probe
   * `screen_current` uses — so "did it arrive" is answered by the same reading the model would
   * otherwise call for by hand. Injected as an override because a host may have the probe without
   * exposing it through the system service.
   *
   * Absent (with no `system.automation` either) means the host cannot tell, and the tool reports
   * `unverified` rather than claiming the launch worked — see `awaitArrival`.
   */
  readForeground?: () => Promise<ForegroundWindow>;
}): AnyToolDefinition[] {
  const readForeground =
    deps.readForeground ??
    (deps.system.automation ? () => deps.system.automation!.currentWindow() : undefined);

  const systemOpen = {
    name: "system_open",
    description:
      "Bring an app or a link to the front. Pass exactly one of `packageId`, `deepLink` or `url`.\n" +
      "· `packageId` — open an installed app through Android's own launcher lookup. This is how you " +
      "open an app.\n" +
      "· `deepLink` — a custom scheme such as `orpheus://` or `weixin://`, opened through the " +
      "privileged shell so Android does not interrupt with a chooser. Use this when the app " +
      "documents a way into a specific screen (a chat, a track, a playlist); it saves the taps and " +
      "the guessing that navigating there by hand costs.\n" +
      "· `url` — an ordinary web/mail/tel link (http, https, mailto, tel, geo).\n" +
      "Do not pass a made-up URL as a way of reaching an app: Android then has to pick a handler and " +
      "interrupts the user with a 「选择应用」dialog that usually does not even list the app they " +
      "asked for. If you do not know the package id, search with system_apps first.\n" +
      "The result reports where the app actually ended up, because a launch can land somewhere " +
      "other than expected — apps restore the screen you last left them on. `verified: false` means " +
      "the launch was *not* confirmed; say so rather than reporting it as done.",
    input: z.object({
      url: z
        .string()
        .optional()
        .describe("An ordinary URL to open: http, https, mailto, tel, geo."),
      packageId: z.string().optional().describe("Android package id, e.g. com.android.calendar."),
      deepLink: z
        .string()
        .optional()
        .describe(
          "A custom-scheme link into an app, e.g. orpheus://song/123. Opened through the " +
            "privileged shell so no chooser is raised.",
        ),
      settleMs: z
        .number()
        .int()
        .min(0)
        .max(15000)
        .optional()
        .describe(
          "How long to wait for the app to reach the front before reporting. Defaults to 5000. " +
            "Raise it for an app known to start slowly; there is no point lowering it much, since a " +
            "launch that has not arrived by then is usually not going to.",
        ),
    }),
    /**
     * Bringing an app to the front changes nothing on the device, so it is not asked.
     *
     * This used to be `system`, which made every cross-app task open with a prompt for the
     * most innocuous step in it — "open the app I am about to look at". That trains the
     * user to tap through prompts, which is precisely what makes the prompts that *do*
     * matter (typing into a field, pressing send) stop working. Opening is navigation;
     * the injection is the action, and `screen_type`/`screen_tap_element` still ask every
     * single time.
     */
    risk: "read",
    category: "system",
    summarize: (input) => input.deepLink ?? input.url ?? input.packageId ?? "open",
    async execute(
      input: { url?: string; packageId?: string; deepLink?: string; settleMs?: number },
      ctx: { signal?: AbortSignal },
    ) {
      const given = [input.url, input.packageId, input.deepLink].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (given.length === 0) {
        throw new CoreError("E_TOOL_INPUT", "provide exactly one of `packageId`, `deepLink` or `url`");
      }
      if (given.length > 1) {
        // Refusing rather than picking one: which of two contradictory targets was meant is not
        // something to guess at when the answer decides which app comes to the front.
        throw new CoreError(
          "E_TOOL_INPUT",
          "provide exactly one of `packageId`, `deepLink` or `url`, not several",
        );
      }

      // --- app by package id -------------------------------------------------
      if (input.packageId) {
        const packageId = input.packageId.trim();
        if (!isPlausiblePackageId(packageId)) {
          throw new CoreError("E_TOOL_INPUT", packageIdRejection(packageId));
        }
        await deps.system.openApp(packageId);
        return finish({ packageId, opened: packageId }, input.settleMs, ctx);
      }

      // --- a custom scheme, through the shell --------------------------------
      if (input.deepLink) {
        const deepLink = input.deepLink.trim();
        if (!isOpenableUrl(deepLink)) {
          throw new CoreError("E_TOOL_INPUT", urlRejection(deepLink));
        }
        if (!deps.system.openDeepLink) {
          throw new CoreError(
            "E_TOOL_FAILED",
            "deep links need the privileged shell, which this host does not have; " +
              "opening through the ordinary launcher would raise a chooser the run cannot see",
          );
        }
        const result = await deps.system.openDeepLink(deepLink);
        if (!result.opened) {
          // Reported, not thrown: "nothing registered for this scheme" is a fact about the device
          // that the model should act on (different link, or ask the user), not a crash to retry.
          return {
            ok: false,
            opened: deepLink,
            reason: result.reason,
            detail: result.detail,
            ...(result.reason === "no-handler"
              ? { hint: "no app on this device registered for that scheme; the link cannot work as written" }
              : {}),
          };
        }
        // Which package a scheme landed in is not knowable before the fact, so there is nothing to
        // check the foreground against. Say that plainly instead of reporting an unverified success.
        return { ok: true, opened: deepLink, verified: "not-checked", note: "opened through the shell; the target package is whatever handles this scheme" };
      }

      // --- an ordinary URL ---------------------------------------------------
      const url = input.url!.trim();
      if (!isOpenableUrl(url)) {
        throw new CoreError("E_TOOL_INPUT", urlRejection(url));
      }
      await deps.system.openUrl(url);
      return { ok: true, opened: url, verified: "not-checked", note: "opened through the normal launcher; the handler decides which app this reaches" };
    },
  } satisfies AnyToolDefinition;

  /**
   * Add the arrival check to a successful open.
   *
   * Split out so both branches report the same way, and so the *shape* of the answer cannot drift:
   * one place decides what `verified: true` means.
   */
  async function finish(
    base: Record<string, unknown>,
    settleMs: number | undefined,
    ctx: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const packageId = String(base.packageId);
    const outcome = await awaitArrival(
      packageId,
      readForeground,
      settleMs === undefined ? {} : { timeoutMs: settleMs },
      ctx,
    );
    return { ...base, ...describeArrival(outcome, packageId) };
  }

  const systemApps = {
    name: "system_apps",
    description:
      "List installed apps (Android only) so you can pick a package id for system_open. " +
      "Pass `filter` with the app's name whenever you have one — matching is against both the " +
      "visible label and the package id. The unfiltered list is only the first slice of a long " +
      "list, and a phone routinely has two hundred or more launchable apps, so searching by name " +
      "is the reliable way to find one.",
    input: z.object({
      filter: z
        .string()
        .optional()
        .describe("Case-insensitive substring of the app's visible name or its package id."),
      limit: z.number().int().min(1).max(500).optional().describe("How many matches to return. Defaults to 50."),
    }),
    risk: "read",
    category: "system",
    async execute(input: { filter?: string; limit?: number }) {
      if (!deps.system.listApps) {
        throw new CoreError("E_TOOL_FAILED", "listing installed apps is not supported on this platform");
      }
      const apps = await deps.system.listApps();
      const filter = input.filter?.trim().toLowerCase();
      const limit = input.limit ?? 50;
      const matched = filter
        ? apps.filter((app) => app.label.toLowerCase().includes(filter) || app.packageId.includes(filter))
        : apps;
      const visible = matched.slice(0, limit);
      return {
        // These counts are the reason this returns an object rather than an array. The previous
        // shape reported `count: apps.length` while silently slicing to 100, so a caller could
        // not tell a complete list from a truncated one -- an app past the cut simply "did not
        // exist". A phone has far more than 100 launchable apps, so in practice this hid real
        // apps and pushed the model into guessing a URL instead, which is what produced an
        // Android chooser with no correct entry in it.
        total: apps.length,
        matched: matched.length,
        returned: visible.length,
        truncated: matched.length > visible.length,
        ...(matched.length > visible.length
          ? { hint: "还有更多匹配项。用更精确的 filter 缩小范围，或提高 limit。" }
          : {}),
        apps: visible,
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
    category: "system",
    // The clipboard is the user's own shared surface: reading it is what a paste depends on and
    // writing it is what a copy does. Neither leaves the device.
    effects: ["edit"],
    cost: "cheap",
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
    category: "system",
    // Hands content to another app through the system chooser: it leaves the app, and the user
    // is the one who decides where it goes.
    effects: ["share"],
    // Asked every time: the share sheet is a real hand-off of the user's data, and which app
    // receives it is a decision, not a detail.
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
    category: "system",
    effects: ["edit"],
    cost: "cheap",
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
    category: "system",
    effects: ["edit"],
    cost: "slow",
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
