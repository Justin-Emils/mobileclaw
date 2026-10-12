package dev.mobileclaw.app.shizuku

import android.app.Activity
import android.content.ComponentName
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import android.util.Base64
import android.view.WindowManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import dev.mobileclaw.app.BuildConfig
import org.json.JSONObject
import rikka.shizuku.Shizuku
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Screen access through Shizuku, which lends this app the identity of shell (uid 2000)
 * without root.
 *
 * Everything privileged happens in [MobileClawShizukuUserService], a separate process
 * Shizuku starts for us. This class only owns the binder to it, the permission dance,
 * and writing the capture somewhere the app can render it.
 *
 * Two environment facts drive the shape:
 *
 *  - `screencap` runs as uid 2000 and cannot write into the app's private directory,
 *    while the app cannot read `/data/local/tmp`. So the picture comes back as bytes
 *    over the binder and is written to the app's own storage here.
 *  - The binder dies on every device reboot, and Shizuku (in the non-root setup) has to
 *    be started again by hand. That is the normal "not available" case, not a bug, and
 *    [status] is what tells the user which of the several causes applies.
 *
 * @ReactModule is what makes a legacy module visible under the New Architecture; without
 * it the package is listed but NativeModules never resolves the name. The same trap
 * already cost this project a silent fallback on the file module.
 */
@ReactModule(name = MobileClawShizukuModule.NAME)
class MobileClawShizukuModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = NAME

    @Volatile
    private var service: IMobileClawShizukuUserService? = null

    /**
     * `tag` rather than relying on the class name: R8 renames classes, and Shizuku uses
     * the tag to decide whether an existing service is the one being asked for. `version`
     * mismatch makes Shizuku start a fresh service and tear the old one down.
     */
    private val userServiceArgs = Shizuku.UserServiceArgs(
        ComponentName(BuildConfig.APPLICATION_ID, MobileClawShizukuUserService::class.java.name),
    )
        .daemon(false)
        .processNameSuffix("shizuku")
        .debuggable(false)
        .version(SERVICE_VERSION)
        .tag(SERVICE_TAG)

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = binder?.let { IMobileClawShizukuUserService.Stub.asInterface(it) }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
        }
    }

    /** What the JS side needs to explain the situation, in one call. */
    @ReactMethod
    fun status(promise: Promise) {
        run(promise) {
            val installed = isManagerInstalled()
            val running = runCatching { Shizuku.pingBinder() }.getOrDefault(false)
            val granted =
                runCatching {
                    !Shizuku.isPreV11() &&
                        Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
                }.getOrDefault(false)

            Arguments.createMap().apply {
                putBoolean("installed", installed)
                putBoolean("running", running)
                putBoolean("granted", granted)
                putBoolean("available", running && granted)
                if (running) {
                    putInt("uid", runCatching { Shizuku.getUid() }.getOrDefault(-1))
                }
                when {
                    !installed -> {
                        putString("reason", "Shizuku is not installed")
                        putString("howTo", "Install Shizuku, start it, then grant MobileClaw access.")
                    }
                    !running -> {
                        putString("reason", "Shizuku is not running")
                        putString("howTo", "Open Shizuku and start the service; it stops on every reboot.")
                    }
                    !granted -> {
                        putString("reason", "MobileClaw has not been granted Shizuku access")
                        putString("howTo", "Call shizuku_request to open the consent dialog.")
                    }
                }
            }
        }
    }

    /**
     * Opens Shizuku's own consent dialog. It needs no Activity, so the module can drive
     * it directly.
     */
    @ReactMethod
    fun requestPermission(promise: Promise) {
        run(promise) {
            check(runCatching { !Shizuku.isPreV11() }.getOrDefault(false)) {
                "Shizuku requires Android 11 or newer for the on-device flow"
            }
            check(runCatching { Shizuku.pingBinder() }.getOrDefault(false)) {
                "Shizuku is not running"
            }
            if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) return@run true

            val answered = CountDownLatch(1)
            val granted = AtomicBoolean(false)
            // Registered before the request and removed in `finally`: leaking this
            // listener is the classic Shizuku mistake, and it survives the modal.
            val listener = Shizuku.OnRequestPermissionResultListener { code, result ->
                if (code == REQUEST_CODE) {
                    granted.set(result == PackageManager.PERMISSION_GRANTED)
                    answered.countDown()
                }
            }

            Shizuku.addRequestPermissionResultListener(listener)
            try {
                Shizuku.requestPermission(REQUEST_CODE)
                check(answered.await(PERMISSION_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                    "the Shizuku permission dialog was never answered"
                }
                granted.get()
            } finally {
                Shizuku.removeRequestPermissionResultListener(listener)
            }
        }
    }

    /**
     * Runs a command as shell. The result is the user service's JSON, reshaped.
     *
     * `stdin` is optional and defaults to empty. It exists so a model-supplied value can reach a
     * command without being interpolated into its command line — see the note on the AIDL method.
     * Declared with a default so the JS side may keep calling it with two arguments.
     */
    @ReactMethod
    fun runPrivileged(command: String, timeoutMs: Double, stdin: String?, promise: Promise) {
        run(promise) {
            val json = JSONObject(awaitService().exec(command, timeoutMs.toInt(), stdin ?: ""))
            if (json.has("error")) throw IllegalStateException(json.getString("error"))
            Arguments.createMap().apply {
                putInt("exitCode", json.optInt("exitCode", -1))
                putString("stdout", json.optString("stdout"))
                putString("stderr", json.optString("stderr"))
                putBoolean("timedOut", json.optBoolean("timedOut"))
            }
        }
    }

    /**
     * Captures the screen and writes it where the app can render it.
     *
     * The UserService downscales and compresses, because that is the only side that can
     * see the pixels; this side only chooses the destination.
     */
    @ReactMethod
    fun screenshot(maxWidth: Double, quality: Double, destDir: String?, promise: Promise) {
        run(promise) {
            val json = JSONObject(awaitService().screenshot(maxWidth.toInt(), quality.toInt()))
            if (json.has("error")) throw IllegalStateException(json.getString("error"))

            // Screenshots of other apps routinely contain private conversations, so the default
            // destination is app-internal: the system gallery never indexes it, no other app can
            // read it, and no storage permission is involved. `filesDir` rather than `cacheDir`
            // because these are evidence — the system may purge a cache at any moment, and a
            // screenshot that quietly disappears cannot witness anything.
            val directory = destDir?.takeIf { it.isNotBlank() }?.let { File(it) } ?: screenshotDir()
            check(directory.isDirectory || directory.mkdirs()) {
                "could not create the destination directory: ${directory.absolutePath}"
            }

            // A fresh name per capture: two pictures in one turn would otherwise
            // overwrite each other, and the transcript keeps the path as evidence.
            val target = File(directory, "screen-${System.currentTimeMillis()}.jpg")
            target.writeBytes(Base64.decode(json.getString("jpeg"), Base64.DEFAULT))

            Arguments.createMap().apply {
                putString("path", "file://${target.absolutePath}")
                putInt("width", json.getInt("width"))
                putInt("height", json.getInt("height"))
                json.optString("note").takeIf { it.isNotEmpty() }?.let { putString("note", it) }
            }
        }
    }

    /**
     * Keeps the display on while a run is in progress.
     *
     * The screen is the thing being automated, so a display that sleeps ends a run for a reason
     * that has nothing to do with the task — and it does so silently, mid-step. `FLAG_KEEP_SCREEN_ON`
     * needs no permission and lets the system release it when the app leaves the foreground, which
     * is the behaviour this wants: a run stops being meaningful then anyway.
     *
     * Applied on the current Activity, so it is a no-op rather than an error when there is none —
     * a headless moment must not take the run down.
     */
    @ReactMethod
    fun keepScreenOn(on: Boolean, promise: Promise) {
        run(promise) {
            val activity = attachedActivity
            check(activity != null) { "no current activity to hold the display with" }
            activity.runOnUiThread {
                if (on) {
                    activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
            on
        }
    }

    /**
     * Start the foreground service that keeps this process from being frozen.
     *
     * **Call this while the app is visible.** Android 12+ refuses to start a foreground service
     * from the background, so calling it when a run begins — by which time the agent has already
     * switched to another app — throws `ForegroundServiceStartNotAllowedException`. Starting it
     * once when the app is shown and leaving it running is the only shape that works; see
     * `MobileClawForegroundService` for the full reasoning.
     *
     * `text` is the notification's body, supplied by the caller so the wording stays in
     * `ui/strings.ts` with the rest of the interface.
     */
    @ReactMethod
    fun startRunService(text: String?, promise: Promise) {
        run(promise) {
            MobileClawForegroundService.start(reactContext, text ?: "")
            true
        }
    }

    /**
     * Stop that service, dropping its notification.
     *
     * Safe to call when the service was never started. Nothing depends on it having run, so a
     * failure here must not surface as a run error.
     */
    @ReactMethod
    fun stopRunService(promise: Promise) {
        run(promise) {
            MobileClawForegroundService.stop(reactContext)
            true
        }
    }

    /**
     * Re-post the ongoing notice, after the user grants the notification permission.
     *
     * `startForeground` runs once, when the service starts. If the permission arrives later — which
     * is the normal path, because Android 13+ makes it a runtime permission and the app asks from
     * its own settings screen — the service keeps running with **no visible notification** and
     * nothing retries. On a device that looked like: `isForeground=true`, the channel present and
     * unblocked, `POST_NOTIFICATIONS` granted, and zero notifications posted.
     */
    @ReactMethod
    fun refreshRunServiceNotice(text: String?, promise: Promise) {
        run(promise) {
            MobileClawForegroundService.refresh(reactContext, text ?: "")
            true
        }
    }

    /**
     * Read a file **inside this app's own storage**, so a diagnostic on the phone can be inspected
     * from a development machine.
     *
     * ## Why this exists
     *
     * A release build is not debuggable, so `adb shell run-as` refuses; the device has no root, so
     * `/data/user/0/...` is unreadable from a shell; and the storage tools cannot help because the
     * path is app-private. That left the in-app log reachable only by a human reading it off the
     * screen and copying it out by hand — which is a fine fallback and a poor debugging loop.
     *
     * ## Why that is safe
     *
     * It reads, never writes, and it can only read *this app's* files: the path is resolved against
     * `filesDir` and rejected if the result escapes it, so `..` cannot reach anything else. The
     * content is the app's own log, which the app already shows on its own settings screen, and the
     * only way to reach this method is a bridge call from the app itself.
     *
     * `offset` and `length` bound the transfer: a log can be hundreds of kilobytes and the bridge
     * copies the string into the JS heap, so the caller asks for a window rather than the whole file.
     */
    @ReactMethod
    fun readOwnFile(relativePath: String, offset: Double, length: Double, promise: Promise) {
        run(promise) {
            val root = reactContext.filesDir.canonicalFile
            val target = File(root, relativePath).canonicalFile
            // `canonicalFile` resolves `..` first, so the containment test below is the real guard:
            // comparing the unresolved path would let `../databases/x` through.
            check(target.path == root.path || target.path.startsWith(root.path + File.separator)) {
                "only files inside this app's storage can be read"
            }
            check(target.isFile) { "no such file: $relativePath" }

            val start = offset.toLong().coerceAtLeast(0L)
            val size = target.length()
            val take = length.toLong().coerceAtLeast(0L).coerceAtMost(size - start).toInt()
            // `coerceAtMost(0)` on an offset past the end would produce a negative take; clamping to
            // zero there reports an empty read rather than throwing, which is what a polling caller
            // wants when it has caught up with the file.
            val bytes = ByteArray(take.coerceAtLeast(0))
            if (bytes.isNotEmpty()) {
                java.io.RandomAccessFile(target, "r").use { handle ->
                    handle.seek(start)
                    handle.readFully(bytes)
                }
            }

            Arguments.createMap().apply {
                putDouble("size", size.toDouble())
                putDouble("offset", start.toDouble())
                putString("content", String(bytes, Charsets.UTF_8))
                putBoolean("eof", start + take >= size)
            }
        }
    }

    /**
     * Copy a file out of this app's own storage to shared storage, so a development machine can
     * read it over USB.
     *
     * ## Why the app does this itself
     *
     * The obvious approach — hand the path to the privileged shell and let uid 2000 `cat` it — does
     * **not** work, and fails in a way that looks like success:
     *
     *   /data/user/0/<pkg>/files/mobileclaw-run.log: Permission denied
     *
     * Android's app-data isolation is per *process* identity, not per uid: a process under
     * `u:r:shell:s0` is refused even when its uid matches. The redirect still creates the
     * destination, so the first attempt produced a **0-byte file that looked like an export**.
     * Only the app can read its own directory, so the app has to be the one that copies.
     *
     * The write side is ordinary app storage: the app has `WRITE_EXTERNAL_STORAGE` for the releases
     * that need it, and `Download` is where the caller is told to look.
     */
    @ReactMethod
    fun exportOwnFile(relativePath: String, promise: Promise) {
        run(promise) {
            val root = reactContext.filesDir.canonicalFile
            val source = File(root, relativePath).canonicalFile
            check(source.path == root.path || source.path.startsWith(root.path + File.separator)) {
                "only files inside this app's storage can be exported"
            }
            check(source.isFile) { "no such file: $relativePath" }

            val destinationDir = android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOWNLOADS,
            )
            check(destinationDir.isDirectory || destinationDir.mkdirs()) {
                "could not create ${destinationDir.absolutePath}"
            }
            val destination = File(destinationDir, source.name)
            source.inputStream().use { input ->
                destination.outputStream().use { output -> input.copyTo(output) }
            }
            destination.absolutePath
        }
    }

    /**
     * Declare the approval notification channel, so it exists before the first question is asked.
     *
     * Called at startup rather than lazily: `expo-notifications` creates an Android channel on first
     * use at *default* importance and never revisits it, so a channel that is not already present
     * ends up silent — no heads-up banner — which is precisely the failure the approval
     * notification exists to fix.
     *
     * Idempotent: recreating a channel only refreshes its name and description.
     */
    @ReactMethod
    fun prepareApprovalChannel(promise: Promise) {
        run(promise) {
            val manager = reactContext.getSystemService(android.content.Context.NOTIFICATION_SERVICE)
                as android.app.NotificationManager
            MobileClawForegroundService.ensureApprovalChannel(manager)
            true
        }
    }

    /**
     * Post an approval question with its two buttons, on the interrupting channel.
     *
     * Done natively rather than through `expo-notifications` for one reason: the buttons have to work
     * **from the notification shade while another app is in front**, and a notification action can
     * only be declared with an Android `PendingIntent`. There is no way to reach a JavaScript
     * listener from one, so the whole notice lives on this side and the answer comes back as an
     * Intent extra handled by [MobileClawApprovalReceiver].
     */
    @ReactMethod
    fun postApprovalNotification(
        approvalId: String,
        title: String,
        body: String,
        promise: Promise,
    ) {
        run(promise) {
            MobileClawApprovalReceiver.post(reactContext, approvalId, title, body)
            true
        }
    }

    /** Take the question down once it has been answered, by either route. */
    @ReactMethod
    fun dismissApprovalNotification(approvalId: String, promise: Promise) {
        run(promise) {
            MobileClawApprovalReceiver.dismiss(reactContext, approvalId)
            true
        }
    }

    /**
     * The Activity this module is attached to, when there is one.
     *
     * Named `attachedActivity` rather than `currentActivity` on purpose. The base class
     * `ReactContextBaseJavaModule` already declares `getCurrentActivity()`, so a Kotlin property
     * called `currentActivity` generates a getter with the same JVM signature and the compiler
     * rejects the file:
     *
     *   Accidental override: The following declarations have the same JVM signature
     *   (getCurrentActivity()Landroid/app/Activity;)
     *
     * That surfaced only on the first full build, because this file was written on a machine with
     * no Android toolchain. Do not rename it back.
     */
    private val attachedActivity: Activity?
        get() = (reactContext.currentActivity as? Activity)

    /**
     * Where screenshots live, so JavaScript can list, show and prune them.
     *
     * Exposed rather than derived on the JavaScript side: this is a platform path, and a second
     * guess at it in TypeScript would be a second thing to keep correct. The Kotlin side owns the
     * location; everything else asks for it.
     */
    @ReactMethod
    fun screenshotDir(promise: Promise) {
        run(promise) {
            val directory = screenshotDir()
            check(directory.isDirectory || directory.mkdirs()) {
                "could not create the screenshot directory: ${directory.absolutePath}"
            }
            directory.absolutePath
        }
    }

    /**
     * The app-internal screenshot directory.
     *
     * Inside the app's private `files` directory, which is what keeps these pictures out of the
     * system gallery and away from every other app, with no permission asked for. Not `cacheDir`:
     * a screenshot the system may purge cannot serve as evidence.
     */
    private fun screenshotDir(): File = File(reactContext.filesDir, "screenshots")

    /** True when the Shizuku manager app is present at all, which "not running" hides. */
    private fun isManagerInstalled(): Boolean =
        try {
            reactContext.packageManager.getPackageInfo(SHIZUKU_PACKAGE, 0)
            true
        } catch (error: Throwable) {
            false
        }

    /**
     * The bound service, binding it first if needed.
     *
     * `bindUserService` is asynchronous, so this polls rather than assuming the
     * connection callback has already run. Binding is only legal while the binder is
     * alive; calling it after a reboot without restarting Shizuku throws.
     */
    private fun awaitService(timeoutMs: Long = BIND_TIMEOUT_MS): IMobileClawShizukuUserService {
        service?.let { return it }
        Shizuku.bindUserService(userServiceArgs, connection)
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            service?.let { return it }
            Thread.sleep(POLL_MS)
        }
        throw IllegalStateException(
            "the Shizuku user service did not connect within ${timeoutMs}ms",
        )
    }

    /** Runs [block] off the JS thread and settles [promise] with its result or failure. */
    private fun run(promise: Promise, block: () -> Any?) {
        Thread {
            try {
                promise.resolve(block())
            } catch (error: Throwable) {
                promise.reject(ERROR_CODE, error.message ?: error.toString(), error)
            }
        }.start()
    }

    companion object {
        const val NAME = "MobileClawShizuku"

        /** The manager package, for telling "not installed" apart from "not running". */
        private const val SHIZUKU_PACKAGE = "moe.shizuku.privileged.api"
        private const val ERROR_CODE = "E_MOBILECLAW_SHIZUKU"
        private const val SERVICE_TAG = "mobileclaw-automation"
        private const val SERVICE_VERSION = 1
        private const val REQUEST_CODE = 4399
        private const val PERMISSION_TIMEOUT_MS = 120_000L
        private const val BIND_TIMEOUT_MS = 15_000L
        private const val POLL_MS = 50L
    }
}
