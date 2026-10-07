import { definePlugin, type Plugin } from "@mobileclaw/core";
import type { FileSystemService, HttpService, ShellService, SystemService } from "@mobileclaw/core";
import { createFilesystemTools } from "./tools/filesystem";
import { createShellTools } from "./tools/shell";
import { createWebTools } from "./tools/web";
import { createSystemTools } from "./tools/system";
import { createPythonTools } from "./tools/python";
import { createShizukuTools } from "./tools/shizuku";

export * from "./availability";
export * from "./tools/filesystem";
export * from "./tools/shell";
export * from "./tools/web";
export * from "./tools/system";
export * from "./tools/python";
export * from "./tools/shizuku";

export interface CapabilityDeps {
  fs: FileSystemService;
  shell: ShellService;
  http: HttpService;
  system: SystemService;
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
      tools: createWebTools({ http: deps.http }),
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
  ];
}
