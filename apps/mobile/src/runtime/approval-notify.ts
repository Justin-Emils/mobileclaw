import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { PendingApproval } from "./approval";

/**
 * Ask for approval where the user can actually see it.
 *
 * ## The problem this solves
 *
 * Every mutating screen tool waits for approval, and the agent asks **while it is operating another
 * app**. MobileClaw is therefore in the background, its approval sheet is behind whatever is on
 * screen, and the run stops without the user being told anything. On a device this showed up as a
 * run that simply froze — one measured wait was 173 seconds, ended by the user noticing by accident.
 *
 * ## Why a notification and not an overlay
 *
 * A floating ball would also work and was considered. It was rejected because of what it does to the
 * tools: measured on the device, an overlay window **takes over the accessibility dump** — with the
 * notification shade open, `uiautomator` reported 200 nodes of SystemUI and the app underneath did
 * not appear at all. A permanently visible overlay would threaten every screen reading, and the
 * platform offers no way to exclude one from a capture (`screencap` cannot filter layers, and the
 * tools that can need root).
 *
 * A heads-up notification has none of that: it appears over another app, its buttons answer the
 * question without bringing MobileClaw forward, and it is gone as soon as it is answered.
 *
 * ## The two halves that have to line up
 *
 * The channel's **importance** decides whether Android shows a banner at all, and that is not
 * something `expo-notifications` sets — it creates a channel on first use at default importance and
 * never revisits it. So the channel is declared by the native module
 * (`prepareApprovalChannel`), and the notification is posted through `expo-notifications` so that
 * button presses arrive back in JavaScript.
 */

/** Action identifiers, echoed back by the response listener. */
export const APPROVE_ACTION = "mobileclaw.approve";
export const DENY_ACTION = "mobileclaw.deny";

/** The category the buttons are attached to. */
export const APPROVAL_CATEGORY = "mobileclaw-approval";

/** Must match `APPROVAL_CHANNEL_ID` in `MobileClawForegroundService.kt`. */
export const APPROVAL_CHANNEL = "mobileclaw-approval";

/**
 * The notification identifier is the approval id itself.
 *
 * Deliberately not prefixed or hashed: the same string then serves as the pending-approval key, the
 * `data` payload, and the dismissal handle, so there is one name for one thing across the three
 * places this value travels.
 */
function identifierFor(approvalId: string): string {
  return approvalId;
}

/** Read the approval id back out of a notification identifier. */
export function approvalIdFrom(identifier: string | null | undefined): string | undefined {
  return identifier === null || identifier === undefined || identifier === "" ? undefined : identifier;
}

/**
 * Declare the category and its two buttons, and make sure the channel exists.
 *
 * Safe to call more than once: both operations are idempotent, and a failure is not fatal — without
 * them the in-app sheet still works, which is the state this file exists to improve on rather than to
 * replace.
 */
export async function prepareApprovalNotifications(options: {
  prepareChannel?: () => Promise<unknown>;
} = {}): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await options.prepareChannel?.();
    await Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY, [
      {
        identifier: DENY_ACTION,
        buttonTitle: "拒绝",
        // Destructive styling: it stops the run, which is the more consequential of the two.
        options: { isDestructive: true, opensAppToForeground: false },
      },
      {
        identifier: APPROVE_ACTION,
        buttonTitle: "本次允许",
        // The run continues where it is; bringing the app forward would take the screen away from
        // the app the agent is working, which is the situation being fixed.
        options: { opensAppToForeground: false },
      },
    ]);
  } catch {
    // Swallowed on purpose: the sheet in the app remains, so this is a degraded path, not a broken one.
  }
}

/**
 * Post one question. Returns the notification id so it can be withdrawn when answered in the app.
 */
export async function postApprovalNotification(approval: PendingApproval): Promise<string> {
  return Notifications.scheduleNotificationAsync({
    identifier: identifierFor(approval.id),
    content: {
      title: approval.title,
      body: approval.detail,
      categoryIdentifier: APPROVAL_CATEGORY,
      // The question blocks the run, so it should not be dismissible by a swipe alone; letting it
      // vanish would leave a stopped run with nothing on screen explaining why.
      sticky: true,
      // The id travels in `data` as well as in the identifier: an Android action button rebuilds the
      // notification from its own record, and `data` is the field that survives that trip.
      data: { approvalId: approval.id },
      ...(Platform.OS === "android" ? { channelId: APPROVAL_CHANNEL } : {}),
    },
    trigger: null,
  });
}

export async function withdrawApprovalNotification(identifier: string): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(identifier);
  } catch {
    // Already dismissed, or never posted. Both mean it is not on screen, which is the goal.
  }
}

/** What the user chose, once a button is pressed. */
export interface ApprovalResponse {
  approvalId: string;
  approved: boolean;
}

/**
 * Read a button press out of an expo-notifications response.
 *
 * Returns `undefined` for anything that is not an approval answer — a tap on the body, another
 * notification, a dismissal — so the caller can distinguish "no answer" from "answered no".
 */
export function readApprovalResponse(
  response: Notifications.NotificationResponse,
): ApprovalResponse | undefined {
  const action = response.actionIdentifier;
  if (action !== APPROVE_ACTION && action !== DENY_ACTION) return undefined;

  const data = response.notification.request.content.data as { approvalId?: unknown } | null;
  const fromData = typeof data?.approvalId === "string" ? data.approvalId : undefined;
  const approvalId = fromData ?? approvalIdFrom(response.notification.request.identifier);
  if (approvalId === undefined) return undefined;

  return { approvalId, approved: action === APPROVE_ACTION };
}
