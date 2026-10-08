package dev.mobileclaw.app.files

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * File access that bypasses `expo-file-system`'s permission gate.
 *
 * ## Why this module exists
 *
 * `expo-file-system` decides whether an operation is allowed by asking the *filesystem*
 * about the file (expo-modules-core, `FilePermissionService.kt`):
 *
 *     protected open fun getExternalPathPermissions(path: String): EnumSet<Permission> =
 *       EnumSet.noneOf(Permission::class.java).apply {
 *         if (file.canRead())  { add(Permission.READ) }
 *         if (file.canWrite()) { add(Permission.WRITE) }
 *       }
 *
 * `File.canRead()` / `canWrite()` compare the file's owner, group and mode bits against the
 * calling process. A file in `/storage/emulated/0/Download` belongs to another uid --
 * `u0_a270 media_rw`, mode `rw-rw----`, on the device this was diagnosed on -- so the app is
 * neither owner nor group member and both calls return false. A file that does not exist yet
 * can never pass either check.
 *
 * All-files access does not change those bits, so the gate refuses no matter what the user
 * grants:
 *
 *     Call to function 'FileSystemFile.write' has been rejected.
 *       → Caused by: Missing 'READ' permission for accessing the file.
 *
 * Measured on a Xiaomi 2509FPN0BC running Android 16 (API 36) with all-files access granted
 * three independent ways: the Settings toggle reading `checked=true`,
 * `appops get ... MANAGE_EXTERNAL_STORAGE` returning `Uid mode: allow`, and `fs_list` on the
 * very same directory succeeding in 116 ms. The error text is not about a missing permission,
 * which is why it sent the user to a switch that was already on.
 *
 * `java.io.File` runs no such pre-check: it attempts the operation and the kernel decides.
 * That is the correct behaviour, because all-files access is precisely the grant that lets
 * the kernel say yes.
 *
 * ## Contract
 *
 * Paths arrive already validated by `PathGuard`, which is the authoritative containment
 * check and is stricter than anything here; this module deliberately does not repeat it.
 * Errors propagate as exceptions so the caller sees the kernel's own message rather than a
 * generic failure -- guessing between "no permission" and "no such directory" is what
 * produced the wrong banner.
 */
class MobileClawFilesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MobileClawFiles")

    /** Write text, returning the resulting byte length. */
    Function("writeText") { path: String, contents: String ->
      val file = File(path)
      file.parentFile?.mkdirs()
      file.writeText(contents)
      file.length()
    }

    /** Write binary as base64, which keeps the bridge free of array marshalling. */
    Function("writeBase64") { path: String, base64: String ->
      val file = File(path)
      file.parentFile?.mkdirs()
      file.writeBytes(Base64.decode(base64, Base64.DEFAULT))
      file.length()
    }

    /** Read text, or null when the path is not a readable file. */
    Function("readText") { path: String ->
      val file = File(path)
      if (!file.isFile) null else file.readText()
    }

    /** Read binary as base64, or null. */
    Function("readBase64") { path: String ->
      val file = File(path)
      if (!file.isFile) null else Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
    }

    Function("exists") { path: String -> File(path).exists() }

    Function("isDirectory") { path: String -> File(path).isDirectory }

    Function("size") { path: String -> File(path).length() }

    /** Last modification time in milliseconds, or 0. */
    Function("mtime") { path: String -> File(path).lastModified() }

    Function("mkdirs") { path: String -> File(path).mkdirs() }

    Function("delete") { path: String ->
      val file = File(path)
      if (file.isDirectory) file.deleteRecursively() else file.delete()
    }

    /** Move, falling back to copy-then-delete when a rename across mounts is refused. */
    Function("move") { from: String, to: String ->
      val source = File(from)
      val target = File(to)
      target.parentFile?.mkdirs()
      if (source.renameTo(target)) return@Function true
      if (source.isDirectory) return@Function false
      source.copyTo(target, overwrite = true)
      source.delete()
    }

    /** Immediate children by name, sorted, or empty when not a directory. */
    Function("list") { path: String ->
      val dir = File(path)
      if (!dir.isDirectory) emptyList<String>() else dir.list()?.sorted() ?: emptyList()
    }

    /**
     * What the filesystem says about a path, for diagnosing a refusal.
     *
     * Exists because the previous approach guessed a cause and got it wrong. Rather than
     * infer why an operation failed, the app can now report the facts it actually has.
     */
    Function("describe") { path: String ->
      val file = File(path)
      val parent = file.parentFile
      mapOf(
        "path" to path,
        "exists" to file.exists(),
        "isDirectory" to file.isDirectory(),
        "canRead" to file.canRead(),
        "canWrite" to file.canWrite(),
        "parent" to (parent?.absolutePath ?: ""),
        "parentExists" to (parent?.exists() ?: false),
        "parentCanWrite" to (parent?.canWrite() ?: false)
      )
    }
  }
}
