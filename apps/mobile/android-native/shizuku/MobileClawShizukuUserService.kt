package dev.mobileclaw.app.shizuku

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Parcel
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess

/**
 * Runs as shell (uid 2000) inside Shizuku's UserService process.
 *
 * Two things about this environment shape everything below:
 *
 *  - The process is **not a valid Android application process**. A `Context` may exist
 *    but `getContentResolver`, `registerReceiver` and friends do not work. Nothing here
 *    reaches for one.
 *  - uid 2000 cannot write into the app's private directory, and the app cannot read
 *    `/data/local/tmp`. So a capture cannot be handed over as a file path: the bytes
 *    have to come back through the binder. That is the only reason `screenshot` is a
 *    method here instead of another `exec` command line.
 *
 * Keep this class small. It cannot be compiled on a developer machine without the
 * Android toolchain, so every line here is unverified until a device build says
 * otherwise — anything expressible as a command line belongs in the JS side instead,
 * where it has tests.
 */
class MobileClawShizukuUserService : IMobileClawShizukuUserService.Stub() {

    override fun exec(command: String, timeoutMs: Int): String {
        return try {
            val process = ProcessBuilder("sh", "-c", command).start()

            // stderr is drained on its own thread: reading only stdout here and letting
            // stderr fill its pipe would hang as soon as a command wrote more than the
            // pipe buffer holds.
            var error = ""
            val errorThread = Thread { error = readAll(process.errorStream) }
                .apply { isDaemon = true }
                .also { it.start() }

            val out = readAll(process.inputStream)
            val finished = process.waitFor(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            if (!finished) process.destroyForcibly()
            errorThread.join(DRAIN_JOIN_MS)

            JSONObject()
                // Only ask for the exit value once the process really ended; after a
                // forced destroy it may not have, and exitValue() would throw.
                .put("exitCode", if (finished) process.exitValue() else TIMEOUT_EXIT)
                .put("stdout", out)
                .put("stderr", error)
                .put("timedOut", !finished)
                .toString()
        } catch (error: Throwable) {
            JSONObject().put("error", error.message ?: error.toString()).toString()
        }
    }

    /**
     * Capture, downscale, compress — and report a flat frame for what it is.
     *
     * A window that sets FLAG_SECURE (banking apps, some password fields) is excluded
     * from every capture path, so it comes back as one solid colour. That is
     * indistinguishable from a genuinely plain screen, so the note says both.
     */
    override fun screenshot(maxWidth: Int, quality: Int): String {
        val temp = File(TEMP_DIR, "mobileclaw-shot.png")
        try {
            val capture = ProcessBuilder("sh", "-c", "screencap -p ${temp.absolutePath}").start()
            val ok = capture.waitFor(15, TimeUnit.SECONDS) && capture.exitValue() == 0
            if (!ok || !temp.isFile) {
                return failure("screencap failed or produced nothing")
            }

            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(temp.absolutePath, bounds)
            if (bounds.outWidth <= 0) return failure("the capture could not be decoded")

            val options = BitmapFactory.Options().apply {
                inSampleSize = sampleSizeFor(bounds.outWidth, maxWidth)
            }
            val decoded = BitmapFactory.decodeFile(temp.absolutePath, options)
                ?: return failure("the capture could not be decoded")

            val scaled =
                if (decoded.width > maxWidth) {
                    Bitmap.createScaledBitmap(
                        decoded,
                        maxWidth,
                        (decoded.height.toLong() * maxWidth / decoded.width).toInt().coerceAtLeast(1),
                        true,
                    )
                } else {
                    decoded
                }

            val result = JSONObject()
                .put("width", scaled.width)
                .put("height", scaled.height)
                .put("jpeg", Base64.encodeToString(toJpeg(scaled, quality), Base64.NO_WRAP))
            if (looksFlat(scaled)) result.put("note", FLAT_FRAME_NOTE)

            if (scaled !== decoded) scaled.recycle()
            decoded.recycle()
            return result.toString()
        } catch (error: Throwable) {
            return failure(error.message ?: error.toString())
        } finally {
            // Left behind, these accumulate in a shell-owned directory that only this
            // process can clear.
            temp.delete()
        }
    }

    /**
     * Shizuku's teardown call.
     *
     * The documentation gives the transaction code as 16777115 while telling you to
     * declare 16777114 in AIDL, and there is no device here to see which one actually
     * arrives. Both are accepted rather than betting on one: getting it wrong leaks a
     * shell process on every reconnect, and the check costs nothing.
     */
    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code == DESTROY_TRANSACTION || code == DESTROY_TRANSACTION + 1) {
            exitProcess(0)
        }
        return super.onTransact(code, data, reply, flags)
    }

    private fun toJpeg(bitmap: Bitmap, quality: Int): ByteArray {
        val stream = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(1, 100), stream)
        return stream.toByteArray()
    }

    /** Nearest power of two that brings [sourceWidth] down to at least [targetWidth]. */
    private fun sampleSizeFor(sourceWidth: Int, targetWidth: Int): Int {
        var sample = 1
        while (targetWidth > 0 && sourceWidth / (sample * 2) >= targetWidth) sample *= 2
        return sample
    }

    /** Samples a coarse grid; a frame that is one colour everywhere is the blocked case. */
    private fun looksFlat(bitmap: Bitmap): Boolean {
        val first = bitmap.getPixel(0, 0)
        val stepX = maxOf(1, bitmap.width / SAMPLES)
        val stepY = maxOf(1, bitmap.height / SAMPLES)
        var y = 0
        while (y < bitmap.height) {
            var x = 0
            while (x < bitmap.width) {
                if (bitmap.getPixel(x, y) != first) return false
                x += stepX
            }
            y += stepY
        }
        return true
    }

    private fun readAll(stream: InputStream): String =
        try {
            stream.bufferedReader().use { it.readText() }
        } catch (error: Throwable) {
            ""
        }

    private fun failure(message: String): String =
        JSONObject().put("error", message).toString()

    private companion object {
        const val TEMP_DIR = "/data/local/tmp"
        const val DESTROY_TRANSACTION = 16777114
        const val TIMEOUT_EXIT = 124
        const val DRAIN_JOIN_MS = 500L
        const val SAMPLES = 8
        const val FLAT_FRAME_NOTE =
            "看起来是纯色画面：可能是受保护的内容（应用设了 FLAG_SECURE），也可能屏幕本身就是纯色。"
    }
}
