import type { AutomationService, DeepLinkResult, PrivilegedService, SystemService } from "@mobileclaw/core";
import { CoreError } from "@mobileclaw/core";

/**
 * Platform automation surface, fully injected.
 *
 * Every capability is optional: on Android we wire IntentLauncher, Clipboard,
 * Share, Notifications and Calendar; on iOS the same code degrades to what the
 * sandbox allows. `system_*` tools then report "not supported here" instead of
 * failing mysteriously.
 */
export interface ExpoSystemPorts {
  openUrl(url: string): Promise<void>;
  /** Launch an app by package id; requires a `<queries>` entry on Android 11+. */
  openApp?(packageId: string): Promise<void>;
  /**
   * Open a link through the privileged shell, so a custom scheme does not raise a chooser.
   *
   * Optional because it needs Shizuku: without it the port is absent and `system_open` reports that
   * it cannot open a deep link, rather than falling back to `openUrl` and popping a dialog on a
   * screen the run is not watching.
   */
  openDeepLink?(url: string): Promise<DeepLinkResult>;
  listApps?(): Promise<{ packageId: string; label: string }[]>;
  sendIntent?(intent: {
    action: string;
    data?: string;
    package?: string;
    extras?: Record<string, string>;
  }): Promise<void>;
  getClipboard?(): Promise<string>;
  setClipboard?(text: string): Promise<void>;
  shareText?(text: string, title?: string): Promise<void>;
  notify?(notification: { title: string; body?: string }): Promise<void>;
  createCalendarEvent?(event: {
    title: string;
    startMs: number;
    endMs: number;
    description?: string;
    location?: string;
  }): Promise<{ id: string }>;
  /** Shizuku/ADB bridge; provided only by the native module. */
  privileged?: PrivilegedService;
  /** Screen capture and input injection; provided only by the native module. */
  automation?: AutomationService;
}

export class ExpoSystemService implements SystemService {
  readonly kind = "expo-system";

  constructor(private readonly ports: ExpoSystemPorts) {
    // Only present when this host can actually do it — see the note on the property.
    if (ports.openDeepLink) {
      this.openDeepLink = (url: string) => ports.openDeepLink!(url);
    }
  }

  async openUrl(url: string): Promise<void> {
    await this.ports.openUrl(url);
  }

  async openApp(packageName: string): Promise<void> {
    if (!this.ports.openApp) {
      throw new CoreError("E_TOOL_FAILED", "launching apps by package id is Android-only", {
        hint: "on iOS, use system_open with a URL scheme instead",
      });
    }
    await this.ports.openApp(packageName);
  }

  /**
   * Opens a custom-scheme link through the privileged shell.
   *
   * Declared as an optional *property* rather than a method, and only assigned when the port exists.
   * `SystemService.openDeepLink` is optional, and `system_open` decides whether the shell route
   * exists by asking whether this is there at all. A method that always exists and throws would turn
   * "this host cannot do it" into "this host tried and failed", and the tool would stop explaining
   * that the only alternative is a chooser dialog drawn on a screen the run cannot see.
   */
  openDeepLink?: (url: string) => Promise<DeepLinkResult>;

  async listApps(): Promise<{ packageId: string; label: string }[]> {
    if (!this.ports.listApps) {
      throw new CoreError("E_TOOL_FAILED", "listing installed apps needs the Android native module");
    }
    return this.ports.listApps();
  }

  async getClipboard(): Promise<string> {
    if (!this.ports.getClipboard) throw new CoreError("E_TOOL_FAILED", "clipboard read is unavailable");
    return this.ports.getClipboard();
  }

  async setClipboard(text: string): Promise<void> {
    if (!this.ports.setClipboard) throw new CoreError("E_TOOL_FAILED", "clipboard write is unavailable");
    await this.ports.setClipboard(text);
  }

  async shareText(text: string, title?: string): Promise<void> {
    if (!this.ports.shareText) throw new CoreError("E_TOOL_FAILED", "sharing is unavailable");
    await this.ports.shareText(text, title);
  }

  async notify(notification: { title: string; body?: string }): Promise<void> {
    if (!this.ports.notify) throw new CoreError("E_TOOL_FAILED", "notifications are unavailable");
    await this.ports.notify(notification);
  }

  async createCalendarEvent(event: {
    title: string;
    startMs: number;
    endMs: number;
    description?: string;
    location?: string;
  }): Promise<{ id: string }> {
    if (!this.ports.createCalendarEvent) {
      throw new CoreError("E_TOOL_FAILED", "calendar writes need expo-calendar and the calendar permission");
    }
    return this.ports.createCalendarEvent(event);
  }

  get privileged(): SystemService["privileged"] {
    return this.ports.privileged;
  }

  get automation(): SystemService["automation"] {
    return this.ports.automation;
  }
}

/**
 * Android storage-access states, as the in-app diagnostics screen reports them.
 *
 * `allFiles` requires MANAGE_EXTERNAL_STORAGE, which has no runtime dialog — the
 * user must flip it in system settings. It is also a Play-policy dead end for an
 * agent app, so the intended distribution is sideload / F-Droid / GitHub builds.
 */
export interface StorageAccessStatus {
  allFiles: boolean;
  /** SAF tree URIs the user granted, if any. */
  grantedTrees: string[];
  appRoots: string[];
}
