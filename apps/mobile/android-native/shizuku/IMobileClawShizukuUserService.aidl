// The interface Shizuku instantiates in a process running as shell (uid 2000).
//
// Deliberately tiny. Everything that can be expressed as a command line is sent
// through `exec` and composed on the JS side, where it can be unit-tested — this
// machine has no Android toolchain, so Kotlin cannot even be compiled here, and
// every line of it is a blind spot. `screenshot` is the exception: downscaling has
// to happen in this process, because uid 2000 cannot write into the app's private
// directory and the app cannot read /data/local/tmp, so the bytes must cross the
// binder rather than a shared path.
package dev.mobileclaw.app.shizuku;

interface IMobileClawShizukuUserService {
    /** Runs `sh -c command`. Returns JSON: {exitCode, stdout, stderr, timedOut}. */
    String exec(String command, int timeoutMs);

    /**
     * Captures the screen, downscales to `maxWidth` and compresses to JPEG.
     *
     * Returns JSON: {width, height, jpeg (base64), note?}. `width`/`height` are the
     * *saved picture*, which is smaller than the display — the display size is not
     * reported because nothing needs it: taps are expressed as fractions and resolved
     * at the point of use.
     *
     * `note` is set when the frame is a single flat colour, which is what a
     * FLAG_SECURE window looks like — and equally what a plain screen looks like.
     */
    String screenshot(int maxWidth, int quality);

    /*
     * Shizuku's teardown call is deliberately NOT declared here.
     *
     * AIDL requires every method to carry an explicit id or none of them, and Shizuku wants a
     * reserved transaction code rather than the next sequential one, so `void destroy() =
     * 16777114;` cannot sit beside the two methods above:
     *
     *   ERROR: ...IMobileClawShizukuUserService.aidl:35.9-17:
     *          You must either assign id's to all methods or to none of them.
     *
     * This file was written on a machine with no Android toolchain and had never been
     * compiled, so the error appeared only when a full build first ran. The Kotlin side already
     * handles the call in `onTransact`, accepting both 16777114 and 16777115 because Shizuku's
     * documentation and its declared constant disagree -- see MobileClawShizukuUserService.kt.
     * Declaring it here would be dead weight even if AIDL accepted the mix.
     */
}
