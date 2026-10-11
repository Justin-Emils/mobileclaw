import { describe, expect, it } from "vitest";
import { selectShellKind } from "../src/runtime/bootstrap";

/**
 * Which shell backend the app picks at startup.
 *
 * This is small enough to look obviously correct, and it was wrong in a way that took a device and
 * a confused user to find. The original took a liveness reading here:
 *
 *     if (await privileged.isAvailable()) return new NativeBridgeShell(privileged);
 *
 * Shizuku's binder routinely is not answering in the first moments after launch, so that check
 * failed, the code fell through to the Termux branch, and the choice was frozen for the life of the
 * process. From then on `shell_run` answered "install Termux (or pair Shizuku)" — advice that leads
 * nowhere, because the Termux backend reports itself unavailable too — while `shizuku_status` asked
 * the same question live and correctly said the backend was available. Two answers to one question,
 * and the one the user saw was the false one.
 *
 * The rule that replaces it: decide by *kind* (does this build have the native module?), and let
 * availability be re-asked on every call, which `NativeBridgeShell.available()` already does. The
 * first case below is the regression; the rest pin the ordering down.
 */

describe("selectShellKind", () => {
  it("picks Shizuku whenever the native module exists, without consulting liveness", () => {
    // The regression. There is deliberately no way to express "the module exists but is not
    // answering yet" in this input, because that state must not change the answer: a backend that
    // is momentarily unavailable is still the right backend to hand back, and it will report its own
    // availability when asked.
    expect(selectShellKind({ hasPrivileged: true, termuxInstalled: false })).toBe("shizuku");
  });

  it("still picks Shizuku when Termux is also installed", () => {
    // Ordering, not just presence. Shizuku is the higher-privilege path and the one the privileged
    // tools need, so a Termux installation must not shadow it.
    expect(selectShellKind({ hasPrivileged: true, termuxInstalled: true })).toBe("shizuku");
  });

  it("falls back to Termux only when there is no native module", () => {
    expect(selectShellKind({ hasPrivileged: false, termuxInstalled: true })).toBe("termux");
  });

  it("returns the explaining backend when neither is available", () => {
    // `memory` is not a shell: it answers `available: false` with a reason, which is what makes the
    // failure legible instead of silent. The message differs depending on whether Termux was found,
    // because "install Termux" is unhelpful advice to someone who already has it.
    expect(selectShellKind({ hasPrivileged: false, termuxInstalled: false })).toBe("memory");
  });

  it("never returns memory while a native module is present", () => {
    // Stated as its own case because this is the shape the bug took: a build that had Shizuku ended
    // up on the "no backend" path. Exhaustive over the termux axis so a future reordering that
    // reintroduces a liveness probe cannot pass by accident.
    for (const termuxInstalled of [true, false]) {
      expect(selectShellKind({ hasPrivileged: true, termuxInstalled })).not.toBe("memory");
    }
  });
});
