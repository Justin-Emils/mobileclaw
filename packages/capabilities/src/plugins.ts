import { definePlugin, type Plugin } from "@mobileclaw/core";
import type {
  FileSystemService,
  HttpService,
  ShellService,
  SystemService,
  WebSearchService,
} from "@mobileclaw/core";
import { createFilesystemTools } from "./tools/filesystem";
import { createShellTools } from "./tools/shell";
import { createWebTools } from "./tools/web";
import { createSystemTools } from "./tools/system";
import { createPythonTools } from "./tools/python";
import { createShizukuTools } from "./tools/shizuku";
import { createAutomationTools } from "./tools/automation";
import { createScreenReadTools } from "./tools/screen-read";
import { createOpenTools } from "./tools/screen-open";
import { createSendTools } from "./tools/screen-send";
import { createPlanTools } from "./tools/plan";
import { createEnrichTools } from "./tools/enrich";

export * from "./availability";
export * from "./screen-match";
export * from "./foreground";
export * from "./ui-dump";
export * from "./android-ui-dump";
export * from "./tools/filesystem";
export * from "./tools/shell";
export * from "./tools/web";
export * from "./tools/system";
export * from "./tools/python";
export * from "./tools/shizuku";
export * from "./tools/automation";
export * from "./tools/screen-read";
export * from "./tools/screen-open";
export * from "./tools/screen-send";
export * from "./tools/plan";
export * from "./tools/enrich";
/**
 * Re-exported from the kernel rather than redeclared: both the tool and the agent loop
 * compare against this name, and two string literals would drift without failing.
 */
export { CONFIRM_PLAN_TOOL } from "@mobileclaw/core";

export interface CapabilityDeps {
  fs: FileSystemService;
  shell: ShellService;
  http: HttpService;
  system: SystemService;
  /**
   * Optional web search backend. A host without one still gets `web_fetch`; the
   * `web_search` tool then explains that no engine is configured rather than failing
   * obscurely, which keeps "no search" distinguishable from "search found nothing".
   */
  search?: WebSearchService;
  /**
   * Where the host wants screenshots kept, and how to sweep the expired ones.
   *
   * Both optional and both the host's business: the directory is a platform path, and the
   * retention window is the user's setting. This package only knows that a screenshot is evidence
   * and that the directory must not be the conversation workspace — pictures of other people's
   * conversations do not belong wherever a workspace root happens to point.
   */
  screenshotDir?: string;
  pruneScreenshots?: () => Promise<{ deleted: number; kept: number } | undefined>;
}

/**
 * The capability bundles shipped with the app. Each is a separate plugin so the
 * user can disable shell execution without losing file management, and each
 * declares the services it needs via `inject` so the host reports a precise error
 * instead of failing mid-conversation.
 *
 * The host publishes the platform services (fs/shell/http/system) before loading
 * these, which is why `inject` can be checked up front and every `apply` body is
 * empty here. Plugins that do more than contribute tools use `apply(ctx)` to
 * register listeners and their own services.
 */
export function capabilityPlugins(deps: CapabilityDeps): Plugin[] {
  return [
    definePlugin({
      name: "cap-files",
      description: "Read, write, search and organise files under the allowed roots.",
      version: "0.1.0",
      core: true,
      inject: ["fs"],
      tools: createFilesystemTools({ fs: deps.fs }),
      apply: () => {},
    }),
    definePlugin({
      name: "cap-shell",
      description: "Run shell commands through the platform command backend.",
      version: "0.1.0",
      core: true,
      inject: ["shell"],
      tools: createShellTools({ shell: deps.shell }),
      apply: () => {},
    }),
    definePlugin({
      name: "cap-web",
      description: "Fetch URLs and search the web for fresh information.",
      version: "0.1.0",
      core: true,
      inject: ["http"],
      tools: [
        ...createWebTools({
          http: deps.http,
          ...(deps.search ? { search: deps.search } : {}),
        }),
        // Lives in the web bundle because it is a network capability, and takes the same
        // two services: `web_search` finds the pages, `enrich_list` does that per item.
        ...createEnrichTools({
          http: deps.http,
          ...(deps.search ? { search: deps.search } : {}),
        }),
      ],
      apply: () => {},
    }),
    definePlugin({
      name: "cap-system",
      description: "Open apps/URLs, share text, clipboard, calendar events and notifications.",
      version: "0.1.0",
      core: true,
      inject: ["system"],
      tools: createSystemTools({ system: deps.system }),
      apply: () => {},
    }),
    definePlugin({
      name: "cap-plan",
      description:
        "Restate the intended task and wait for one explicit confirmation before acting on another app.",
      version: "0.1.0",
      core: true,
      // No injected service: confirming a plan needs nothing but the user. Declared as an
      // empty list rather than omitted so the host still validates it as a plugin.
      inject: [],
      tools: createPlanTools(),
      apply: () => {},
    }),
    definePlugin({
      name: "cap-python",
      description: "Run Python snippets on device (needs a reachable interpreter).",
      version: "0.1.0",
      inject: ["shell", "fs"],
      tools: createPythonTools({ shell: deps.shell, fs: deps.fs }),
      apply: () => {},
    }),
    definePlugin({
      name: "cap-shizuku",
      description: "Privileged shell through Shizuku/ADB for operations a normal app cannot do.",
      version: "0.1.0",
      inject: ["system"],
      tools: createShizukuTools({ system: deps.system }),
      apply: () => {},
    }),
    definePlugin({
      name: "cap-automation",
      description:
        "See the screen and act on it through a privileged backend. Every screen-changing tool asks the user each time and returns a screenshot as evidence.",
      version: "0.1.0",
      inject: ["system"],
      tools: [
        ...createAutomationTools({
          system: deps.system,
          ...(deps.screenshotDir ? { screenshotDir: deps.screenshotDir } : {}),
          ...(deps.pruneScreenshots ? { prune: deps.pruneScreenshots } : {}),
        }),
        ...createScreenReadTools({ system: deps.system }),
        // Opening a named item lives with the other screen actions: it presses something, and the
        // reason it exists is that pressing the wrong thing here sends a message to a stranger.
        ...createOpenTools({ system: deps.system }),
        // The send itself. Last in the bundle because it is the last thing that should ever run.
        ...createSendTools({ system: deps.system }),
      ],
      apply: () => {},
    }),
  ];
}
