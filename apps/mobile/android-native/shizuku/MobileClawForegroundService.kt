package dev.mobileclaw.app.shizuku

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps this process from being frozen while the agent works in another app.
 *
 * ## Why this exists at all
 *
 * The thing driving a run is a JavaScript loop **inside this process**. Android freezes
 * background processes, and a phone shows one app at a time — so the moment the agent does its
 * job (opening the app it was asked to operate), this process is in the background and a
 * candidate for being frozen. Freezing does not slow the loop down or fail a step; it stops it
 * silently between two tool calls, which is what the user saw as "it just hangs after opening
 * the app".
 *
 * `FLAG_KEEP_SCREEN_ON` (see `MobileClawShizukuModule.keepScreenOn`) does **not** help: it stops
 * the display from sleeping, which is a different mechanism from process freezing.
 *
 * ## Why the service runs all the time, not just during a run
 *
 * Android 12+ throws `ForegroundServiceStartNotAllowedException` when an app tries to **start** a
 * foreground service **from the background**. Starting it when a run begins is exactly that call:
 * by then the agent has already switched to another app, so this process is in the background and
 * the start is refused — the naive implementation fails at precisely the moment it is needed.
 *
 * So the service is started once, while this app is still visible, and then keeps running with
 * its notification. That notification is not a workaround; it is the contract of a foreground
 * service — the system requires the user to be able to see that something is running.
 *
 * ## Scope
 *
 * This service has no binder and no work of its own. Its entire purpose is to hold the process at
 * foreground priority. Nothing talks to it; the state it expresses is "this app is alive", which
 * the notification reports.
 */
class MobileClawForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A null intent means the system restarted the service after killing the process. Starting
        // it again in the foreground is the correct response: the notification would otherwise be
        // missing while the service is running, which Android treats as a crash.
        startInForeground(intent)
        // NOT sticky: if the process is gone, there is no agent loop left to protect, and the
        // notification should not outlive it. The app starts this again the next time it is shown.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        super.onDestroy()
    }

    private fun startInForeground(intent: Intent?) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureChannel(manager)

        // The wording comes from `ui/strings.ts` through `startRunService`, so it is not a second
        // copy that can drift from the rest of the interface. The fallback here is only reached if
        // the service is restarted by the system with no intent, which is the one path JavaScript
        // is not around to supply it on.
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: TEXT_FALLBACK
        val notification = buildNotification(text)

        // The type argument is mandatory from Android 14 (API 34). Passing it unconditionally
        // would crash on older releases, and omitting it crashes on newer ones, so it is chosen
        // by version. `stopForeground` above exists for the same reason in reverse.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /** The ongoing notice, shared by `startForeground` and `postNotice`. */
    private fun buildNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(TITLE)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openAppIntent())
            .build()

    /**
     * Tapping the notification opens the app, so the notice is actionable rather than permanent
     * noise. `packageManager.getLaunchIntentForPackage` is the same lookup the launch path uses,
     * and it is the only one that reliably picks the launcher activity.
     */
    private fun openAppIntent(): PendingIntent? {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        return PendingIntent.getActivity(this, 0, launch, flags)
    }

    private fun ensureChannel(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            // LOW: this is a statement of fact, not an alert. A run may last minutes and the user
            // should not be buzzed for the whole of it.
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = CHANNEL_DESCRIPTION
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        const val CHANNEL_ID = "mobileclaw-run"
        const val NOTIFICATION_ID = 4399

        /**
         * The channel approval questions are posted on.
         *
         * Separate from `CHANNEL_ID` because the two notices are opposites. The run notice says
         * "still working" and must be silent — a LOW channel. An approval question is a request the
         * whole run is **blocked on**, asked while the user is looking at another app, so it has to
         * interrupt: HIGH is what makes Android show a heads-up banner over whatever is on screen.
         *
         * Created here rather than through `expo-notifications` because importance is not something
         * that library sets, and a LOW channel would be silent and invisible in a tray the user has
         * no reason to open — which is the exact failure this channel exists to fix.
         */
        const val APPROVAL_CHANNEL_ID = "mobileclaw-approval"
        private const val APPROVAL_CHANNEL_NAME = "需要你的授权"
        private const val APPROVAL_CHANNEL_DESCRIPTION = "运行中被暂停的步骤，需要你确认后才能继续"

        /**
         * Declare the approval channel. Called from module construction so it exists before any
         * question is asked; creating an existing channel is a no-op that also refreshes its name.
         */
        fun ensureApprovalChannel(manager: NotificationManager) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val channel = NotificationChannel(
                APPROVAL_CHANNEL_ID,
                APPROVAL_CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = APPROVAL_CHANNEL_DESCRIPTION
                // The question is not a feed item; a badge would linger after it was answered.
                setShowBadge(false)
                enableVibration(true)
                // Visible on the lock screen: the phone may well be in a pocket when a run stops to
                // ask, and an answer that cannot be given from there is an answer that is not given.
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            manager.createNotificationChannel(channel)
        }

        /**
         * The text that says why this notice is here.
         *
         * This is the one piece of user-facing wording that cannot live in `ui/strings.ts`: the
         * notification is posted from `startForeground`, so the text has to arrive with the intent.
         * JavaScript supplies it (see `startRunService`), which keeps the canonical copy in
         * `ui/strings.ts` where the rest of the interface's wording is. The constants below are the
         * fallback for the one path JavaScript is not present on -- the system restarting the
         * service with a null intent.
         */
        const val EXTRA_TEXT = "text"

        /** Only used when the system restarts the service on its own, with no intent. */
        private const val TITLE_FALLBACK = "MobileClaw"
        private const val TEXT_FALLBACK = "正在运行"

        /**
         * The Android notification-channel strings.
         *
         * These are also outside `ui/strings.ts`, for the same reason: the channel is created
         * before any JavaScript runs. They are what the user sees in Android's notification
         * settings, so they are in Chinese like the rest of the interface.
         */
        private const val CHANNEL_NAME = "运行中"
        private const val CHANNEL_DESCRIPTION = "任务运行期间保持应用不被系统冻结"

        /** The notification title. In Chinese, matching the interface. */
        private const val TITLE = "MobileClaw 正在运行"

        /** Start it, from a context where this app is still visible. */
        fun start(context: Context, text: String) {
            val intent = Intent(context, MobileClawForegroundService::class.java)
                .putExtra(EXTRA_TEXT, text)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /**
         * Put the ongoing notice back.
         *
         * Needed because the notification permission can be granted *after* the service started,
         * and `startForeground` is only called when the service starts. On Android 13+ that
         * combination leaves a running foreground service with **no visible notification** — the
         * platform hides it, and nothing ever retries. Observed on a device exactly that way:
         * `isForeground=true`, the channel present and unblocked, `POST_NOTIFICATIONS` granted, and
         * zero notifications posted.
         *
         * `NotificationManager.notify` with the service's own id updates that notification rather
         * than creating a second one, and is harmless when the notice is already showing.
         */
        fun refresh(context: Context, text: String) {
            try {
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
                    manager.createNotificationChannel(
                        NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                            description = CHANNEL_DESCRIPTION
                            setShowBadge(false)
                        },
                    )
                }
                val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
                val pending = launch?.let {
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    } else {
                        PendingIntent.FLAG_UPDATE_CURRENT
                    }
                    PendingIntent.getActivity(context, 0, it, flags)
                }
                val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                    .setContentTitle(TITLE)
                    .setContentText(text)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setOngoing(true)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setCategory(NotificationCompat.CATEGORY_SERVICE)
                    .apply { if (pending != null) setContentIntent(pending) }
                    .build()
                manager.notify(NOTIFICATION_ID, notification)
            } catch (error: Throwable) {
                // A notice that cannot be shown must not take the run down with it.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MobileClawForegroundService::class.java))
        }
    }
}
