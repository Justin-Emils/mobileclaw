import type { ShellResult } from "@mobileclaw/core";

/**
 * Opening a deep link through the privileged shell, which is the only route that works here.
 *
 * ## Why not `Linking.openURL`
 *
 * `system_open`'s URL path goes through Expo's launcher, which resolves the URL the way an ordinary
 * app would. For a custom scheme (`orpheus://`, `weixin://`) that means Android has to decide which
 * app handles it, and on Android 12+ the system interrupts with an "open with" confirmation. Our app
 * is in the background during a run — the target app is the one on screen — so that dialog is drawn
 * over a screen we are not watching, and the run stalls behind it.
 *
 * `am start` from uid 2000 does not go through that path. Verified on the target device: the shell
 * identity can start the activity directly, and the intent reaches the app we meant.
 *
 * ## Why the URL travels on stdin
 *
 * The URL is model-supplied. Composing `am start -d "$url"` would put it on a shell command line,
 * where a quote or a `;` turns "open this link" into "run this other thing". The same reasoning
 * already governs the package id elsewhere in this package: values the model controls are never
 * interpolated, they are piped. That leaves quoting out of the problem entirely rather than trying
 * to escape it correctly.
 *
 * What is *not* piped is the surrounding script, which is a constant. So the command line an
 * operator would see in a log is the same every time, and the untrusted part never appears in it.
 */

/** A URL safe to hand to `am start` as the data of a VIEW intent. */
export function isOpenableUrl(url: string): boolean {  // Scheme, `//`, then anything except a control character.
  //
  // `\S+` would be wrong twice over. `orpheus://` on its own is a legitimate link — it is how you
  // ask an app to come to the front — and a URL may legitimately contain a space, which is harmless
  // here because the value is a single quoted argument rather than a command line.
  //
  // A bare `com.tencent.mm` is still refused: it has no `//`, so it cannot be a link, and the
  // caller wanted `packageId`.
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) return false;
  // No control characters. A newline would let the value escape the line it is read on, and
  // whatever followed would be executed as further commands.
  return !/[\u0000-\u001f\u007f]/.test(url);
}

/** Why a URL is not openable, phrased for the model. */
export function urlRejection(url: string): string {
  if (/[\u0000-\u001f\u007f]/.test(url)) {
    return "the url contains control characters, which cannot be passed to the launcher";
  }
  return (
    `"${url}" is not a link: it needs a scheme and a value, like orpheus:// or https://example.com. ` +
    "To open an app rather than a link, pass `packageId` instead."
  );
}

export type DeepLinkOutcome =
  | { opened: true; url: string }
  | {
      opened: false;
      reason: "no-handler";
      /** `am`'s own message, so the caller can see what Android objected to. */
      detail: string;
    }
  | { opened: false; reason: "failed"; detail: string };

/**
 * Whether a value has the shape of an Android package id.
 *
 * Deliberately loose — it is a guard against nonsense and injection, not a specification. Android
 * requires at least two dot-separated segments, each starting with a letter, but real ids on real
 * phones also contain digits, underscores and (rarely) hyphens, so a stricter rule would refuse
 * valid apps. What it must reject is anything that could be read as something other than an id.
 */
export function isPlausiblePackageId(packageId: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_][A-Za-z0-9_-]*)+$/.test(packageId)) return false;
  // Belt and braces: the pattern above already excludes these, but stating it makes the intent
  // legible to the next person, and a future loosening of the pattern will have to face it.
  return !/[\s;'"`$\\|&<>(){}*?!~]/.test(packageId);
}

/** Why a package id is not usable, phrased for the model. */
export function packageIdRejection(packageId: string): string {
  return (
    `"${packageId}" is not an Android package id. They look like com.example.app — at least two ` +
    "dot-separated parts, starting with a letter. Use system_apps with a name to find the real one."
  );
}

/**
 * The script that opens the link.
 *
 * Reads the URL from stdin rather than taking it in the command line — see the note above. `am`
 * itself is what resolves the scheme; we do not look the handler up first, because `am start`
 * already fails with a legible message when nothing can handle it.
 */
export function deepLinkCommand(): string {
  return [
    "read -r url",
    'am start -a android.intent.action.VIEW -d "$url" 2>&1',
  ].join("\n");
}

/**
 * Read `am start`'s answer.
 *
 * `am` reports failure on **stdout** and still exits 0, which is why the exit code alone is not
 * enough and the text is what decides. Both spellings it uses for "nothing can handle this" are
 * matched, because the wording differs between Android releases.
 */
export function interpretDeepLink(result: ShellResult, url: string): DeepLinkOutcome {
  const output = `${result.stdout}\n${result.stderr}`.trim();

  if (/Error:\s*Activity not found/i.test(output) || /unable to resolve Intent/i.test(output)) {
    return { opened: false, reason: "no-handler", detail: output };
  }
  // `am` prints "Starting: Intent { ... }" when it hands the intent over. Its absence, with no other
  // error and a zero exit, means we cannot say the link was delivered -- not that it failed.
  if (/Starting:\s*Intent/i.test(output)) {
    return { opened: true, url };
  }
  if (result.exitCode !== 0) {
    return { opened: false, reason: "failed", detail: output || `the shell exited ${result.exitCode}` };
  }
  return {
    opened: false,
    reason: "failed",
    detail: output || "`am start` produced no output, so it is unknown whether the link was delivered",
  };
}
