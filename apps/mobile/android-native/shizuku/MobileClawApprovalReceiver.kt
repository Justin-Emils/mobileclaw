package dev.mobileclaw.app.shizuku

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File

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

        // Withdraw the question: the user has answered, and a notice that stays on screen invites a
        // second answer to a decision already made. This is also the button's only visible feedback
        // now that a press no longer opens the app.
        dismiss(context, approvalId)

        /*
         * Hand the answer to the running app **without bringing it forward**.
         *
         * The first version started the launch activity with the answer as a URL. That worked, and it
         * was wrong: it put MobileClaw in front of whatever the user was doing, every time — which is
         * exactly what the notification exists to avoid. Worse, the launch used
         * `FLAG_ACTIVITY_CLEAR_TOP` with an `ACTION_VIEW`, so the stack was cleared and the chat screen
         * remounted, and the redirected `/?id=…` was briefly absent: the run the user had just approved
         * was replaced by a fresh conversation.
         *
         * The process is still alive when a button is pressed — the run is parked mid-step and the
         * foreground service is holding it up — so the answer can be handed over in-process. A file is
         * the channel: it needs no receiver registration ordering, survives the JavaScript side being
         * between polls, and can be read whenever the runtime next looks. See `approval-inbox.ts`.
         */
        appendDecision(context, approvalId, approved)
    }

    /**
     * Append one decision to the inbox.
     *
     * Append rather than replace: two questions can be waiting at once (the run asks again while the
     * first is unanswered is prevented, but a second run can start), and a replace would silently drop
     * the earlier answer. One JSON object per line keeps the writer simple and the reader tolerant of a
     * torn last line.
     */
    private fun appendDecision(context: Context, approvalId: String, approved: Boolean) {
        try {
            val file = File(context.filesDir, INBOX_FILE)
            val line = JSONObject()
                .put("approvalId", approvalId)
                .put("approved", approved)
                .put("at", System.currentTimeMillis())
                .toString()
            file.appendText("$line\n")
        } catch (ignored: Throwable) {
            // A write that fails leaves the question in the in-app sheet, which is still there.
        }
    }

    companion object {
        const val EXTRA_APPROVAL_ID = "mobileclaw.approvalId"
        const val EXTRA_APPROVED = "mobileclaw.approved"
        const val ACTION_APPROVE = "dev.mobileclaw.app.APPROVE"
        const val ACTION_DENY = "dev.mobileclaw.app.DENY"

        /** Where a button press leaves its answer for the running app. Must match `approval-inbox.ts`. */
        const val INBOX_FILE = "mobileclaw-approvals.jsonl"

        /**
         * A stable notification id per approval.
         *
         * `String.hashCode` rather than an incrementing counter: the id has to be reproducible from
         * the approval id alone, because the receiver that cancels the notice is a different
         * component from the one that posted it.
         */
        fun notificationIdFor(approvalId: String): Int = 5000 + (approvalId.hashCode() and 0x0FFF)

        /**
         * Post the approval question with its two buttons.
         *
         * ## Why a separate notification on the HIGH channel
         *
         * Putting the buttons on the run's own notice was the first idea and it does not work: that
         * notice lives on the `IMPORTANCE_LOW` channel, which is right for "still working" and wrong
         * for a question — a low-importance notification is collapsed to one line and **its action
         * buttons are not drawn at all**. The run's notice stays as it is, and the question gets its
         * own notice on `IMPORTANCE_HIGH` so Android will show it as a banner over whatever is in
         * front, which is the entire point.
         *
         * The id is derived from the approval id rather than counted, because the component that
         * cancels this notice is a different one from the component that posts it.
         *
         * ## The buttons
         *
         * Built with the `Action` overload, not `addAction(icon, title, intent)`. The three-argument
         * form was tried first and produced a notification that `dumpsys` reported as `actions=2`
         * while the shade drew **no buttons** — registered and invisible, which is worse than absent
         * because everything except the screen said it had worked.
         *
         * The icon is a real system drawable. `0` is accepted by the API but is not something the
         * shade can draw, which is the likeliest reason nothing appeared.
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
                // Deliberately *not* `setOngoing(true)`.
                //
                // It was set at first, on the reasoning that a blocked run should not be dismissible by
                // a swipe. On a device that made the notice impossible to **expand**, so its two
                // buttons stayed hidden behind a long press — the user found them, but a control that
                // requires discovering a gesture is not one that solves "the run stopped and nobody
                // knows". An expandable notice shows the buttons, and a swipe that dismisses it leaves
                // the in-app sheet and the blocked run untouched, so nothing is lost.
                .setAutoCancel(false)
                .addAction(
                    NotificationCompat.Action(
                        android.R.drawable.ic_menu_close_clear_cancel,
                        "拒绝",
                        action(context, approvalId, false),
                    ),
                )
                .addAction(
                    NotificationCompat.Action(
                        android.R.drawable.ic_menu_send,
                        "本次允许",
                        action(context, approvalId, true),
                    ),
                )
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
