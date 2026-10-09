package dev.mobileclaw.app.shizuku

import android.content.ComponentName
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import android.util.Base64
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

    /** Runs a command as shell. The result is the user service's JSON, reshaped. */
    @ReactMethod
    fun runPrivileged(command: String, timeoutMs: Double, promise: Promise) {
        run(promise) {
            val json = JSONObject(awaitService().exec(command, timeoutMs.toInt()))
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

            val directory =
                destDir?.takeIf { it.isNotBlank() }?.let { File(it) } ?: reactContext.cacheDir
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
