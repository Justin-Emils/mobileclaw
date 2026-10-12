package dev.mobileclaw.app.shizuku

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Delivers an approval button press back into the app.
 *
 * ## Why the buttons are declared natively
 *
 * The question is asked while the agent is operating **another app**, and the whole problem is that
 * the user cannot see MobileClaw at that moment. So the buttons have to work from the notification
 * shade, and that means Android `PendingIntent`s — there is no way to reach a JavaScript listener
 * from a notification action declared in Kotlin.
 *
 * The press therefore arrives as an `Intent` extra on a broadcast, and the receiver turns it into the
 * app being brought forward with `EXTRA_APPROVAL_ID` / `EXTRA_APPROVED`. JavaScript reads those off
 * the launch intent. Bringing the app forward is not incidental: the user has just made a decision
 * about a run that is stopped, and showing them where it stopped is the useful thing to do.
 *
 * ## Why a declared receiver and not a runtime one
 *
 * `registerReceiver` from a module only works while the process is alive. A run can outlive the
 * JavaScript context being focused, and an approval must not become unanswerable because of that, so
 * the receiver is declared in the manifest and needs no registration.
 */
class MobileClawApprovalReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val approvalId = intent.getStringExtra(EXTRA_APPROVAL_ID) ?: return
        val approved = intent.getBooleanExtra(EXTRA_APPROVED, false)

        // Withdraw the question first: the user has answered, and a notice that stays on screen
        // invites a second answer to a decision already made.
        dismiss(context, approvalId)

        // The answer travels as this app's own URL scheme rather than as an Intent extra.
        //
        // An extra on the launch intent never reaches React Native: `Linking` only surfaces the
        // intent's *data* URI. Using the scheme the app already registers means the answer arrives
        // through the same path as `mobileclaw://logs`, which is known to work on this device, and
        // needs no new plumbing between the native and JavaScript halves.
        val url = Uri.parse("mobileclaw://approval")
            .buildUpon()
            .appendQueryParameter("id", approvalId)
            .appendQueryParameter("approved", approved.toString())
            .build()

        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        launch.data = url
        launch.action = Intent.ACTION_VIEW
        context.startActivity(launch)
    }

    companion object {
        const val EXTRA_APPROVAL_ID = "mobileclaw.approvalId"
        const val EXTRA_APPROVED = "mobileclaw.approved"
        const val ACTION_APPROVE = "dev.mobileclaw.app.APPROVE"
        const val ACTION_DENY = "dev.mobileclaw.app.DENY"

        /**
         * A stable notification id per approval.
         *
         * `String.hashCode` rather than an incrementing counter: the id has to be reproducible from
         * the approval id alone, because the receiver that cancels the notice is a different
         * component from the one that posted it.
         */
        fun notificationIdFor(approvalId: String): Int = 5000 + (approvalId.hashCode() and 0x0FFF)

        /**
         * Post the question with its two buttons.
         *
         * On the `IMPORTANCE_HIGH` channel so Android shows it as a heads-up banner over whatever is
         * on screen — a LOW channel would be silent and sit unnoticed in a tray the user has no
         * reason to open, which is the failure being fixed.
         */
        fun post(context: Context, approvalId: String, title: String, body: String) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            MobileClawForegroundService.ensureApprovalChannel(manager)

            val notification = NotificationCompat.Builder(context, MobileClawForegroundService.APPROVAL_CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                // Tapping the body opens the app, which is the other way to answer: the sheet is there.
                .setContentIntent(openApp(context, approvalId))
                .setOngoing(true)
                .addAction(0, "拒绝", action(context, approvalId, false))
                .addAction(0, "本次允许", action(context, approvalId, true))
                .build()

            manager.notify(notificationIdFor(approvalId), notification)
        }

        fun dismiss(context: Context, approvalId: String) {
            try {
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                manager.cancel(notificationIdFor(approvalId))
            } catch (ignored: Throwable) {
                // Already gone is the desired state.
            }
        }

        private fun flags(): Int =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }

        private fun action(context: Context, approvalId: String, approved: Boolean): PendingIntent {
            val intent = Intent(context, MobileClawApprovalReceiver::class.java).apply {
                // Distinct action per answer, so the two PendingIntents do not collapse into one
                // under FLAG_UPDATE_CURRENT -- they would share an Intent filter otherwise.
                this.action = if (approved) ACTION_APPROVE else ACTION_DENY
                putExtra(EXTRA_APPROVAL_ID, approvalId)
                putExtra(EXTRA_APPROVED, approved)
            }
            // Distinct request codes for the same reason.
            return PendingIntent.getBroadcast(context, notificationIdFor(approvalId) + if (approved) 1 else 0, intent, flags())
        }

        private fun openApp(context: Context, approvalId: String): PendingIntent? {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            launch.putExtra(EXTRA_APPROVAL_ID, approvalId)
            return PendingIntent.getActivity(context, notificationIdFor(approvalId) + 2, launch, flags())
        }
    }
}
