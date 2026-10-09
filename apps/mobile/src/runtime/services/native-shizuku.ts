import { SCREEN_DEFAULTS } from "@mobileclaw/core";
import type {
  AutomationService,
  AutomationStatus,
  ForegroundWindow,
  PrivilegedService,
  ScreenCapture,
  ShellResult,
  ShellRunOptions,
} from "@mobileclaw/core";

/**
 * JS side of the `MobileClawShizuku` native module.
 *
 * Shizuku lends this app the identity of shell (uid 2000) without root, which is the
 * only way an ordinary app can capture the screen and inject input without an
 * AccessibilityService — and an AccessibilityService is deliberately out of scope
 * here (Play policy rejects automation tools, and Android 17's advanced protection
 * mode blocks the API for non-accessibility purposes).
 *
 * The Kotlin behind this module **does not exist yet**. `withMobileClawShizuku` is
 * planned in apps/mobile/app.config.ts but not written, so today `loadNativeShizuku()`
 * always returns undefined, `automation` is never set, and every `screen_*` tool
 * reports "unavailable" on a real device. When it is written it will follow
 * `withMobileClawFiles` — a plain `ReactPackage` rather than an Expo module, because an
 * Expo module failed to autolink here and a `ReactPackage` either registers or fails
 * the build loudly, which matters after a defect that hid behind a silent fallback
 * (see docs/device-verification.md).
 *
 * Loading is lazy and tolerant, exactly like `native-files.ts`: a build without the
 * module leaves `privileged` and `automation` undefined, and the tools explain what
 * is missing instead of pretending the capability exists.
 */
export interface NativeShizukuModule {
  /**
   * Everything the degradation matrix needs, in one call.
   *
   * Telling "not installed" apart from "installed but not running" is the Kotlin's
   * job — only it can see whether `moe.shizuku.privileged.api` is present, and the
   * two need different instructions for the user.
   */
  status(): Promise<AutomationStatus & { installed?: boolean }>;
  /** Opens Shizuku's own consent dialog; needs no Activity. */
  requestPermission(): Promise<boolean>;
  runPrivileged(
    command: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /**
   * Downscales in the UserService and saves the picture where the app can read it.
   *
   * Bytes are handed over the binder rather than through a shared path: uid 2000
   * cannot write into the app's private directory, and the app cannot read
   * `/data/local/tmp`.
   */
  screenshot(options: { maxWidth: number; quality: number; destDir?: string }): Promise<ScreenCapture>;
  tap(x: number, y: number): Promise<void>;
  scroll(direction: "up" | "down" | "left" | "right", fraction: number): Promise<void>;
  typeText(text: string): Promise<{ method: "input" | "paste" }>;
  currentWindow(): Promise<ForegroundWindow>;
}

export function loadNativeShizuku(): NativeShizukuModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NativeModules } = require("react-native") as { NativeModules?: Record<string, unknown> };
    const module = NativeModules?.["MobileClawShizuku"] as NativeShizukuModule | undefined;
    if (!module) {
      console.log("[mobileclaw] native shizuku: MobileClawShizuku is not registered; screen automation is off");
      return undefined;
    }
    console.log("[mobileclaw] native shizuku: MobileClawShizuku registered");
    return module;
  } catch (error) {
    console.log(
      `[mobileclaw] native shizuku unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** Screen automation over the native module. */
export function createAutomationService(native: NativeShizukuModule): AutomationService {
  return {
    kind: "shizuku",
    status: () => native.status(),
    captureScreen: (options = {}) =>
      native.screenshot({
        maxWidth: options.maxWidth ?? SCREEN_DEFAULTS.maxWidth,
        quality: options.quality ?? SCREEN_DEFAULTS.quality,
        ...(options.destDir ? { destDir: options.destDir } : {}),
      }),
    async tap(x, y) {
      await native.tap(x, y);
    },
    async scroll(direction, fraction = SCREEN_DEFAULTS.scrollFraction) {
      await native.scroll(direction, fraction);
    },
    typeText: (text) => native.typeText(text),
    currentWindow: () => native.currentWindow(),
  };
}

/**
 * Privileged command execution over the native module.
 *
 * `isAvailable()` is a `status()` call rather than a dedicated native method, so the
 * "not installed / not running / not permitted" distinction is computed in one place
 * and cannot drift between the shell backend and the screen tools.
 */
export function createPrivilegedService(native: NativeShizukuModule): PrivilegedService {
  return {
    kind: "shizuku",
    async isAvailable() {
      return (await native.status()).available;
    },
    requestPermission: () => native.requestPermission(),
    async run(command: string, options: ShellRunOptions = {}): Promise<ShellResult> {
      const started = Date.now();
      const result = await native.runPrivileged(command, options.timeoutMs ?? 60_000);
      return {
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      };
    },
  };
}
