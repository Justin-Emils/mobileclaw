import { Platform } from "react-native";

/**
 * Ask for approval where the user can actually see it.
 *
 * ## The problem this solves
 *
 * Every mutating screen tool waits for approval, and the agent asks **while it is operating another
 * app**. MobileClaw is therefore in the background, its approval sheet is behind whatever is on
 * screen, and the run stops without the user being told anything.
 *
 * ## Why a notification and not an overlay
 *
 * A floating ball would also work and was considered. It was rejected on measured evidence: an
 * overlay window **takes over the accessibility dump** — with the notification shade open on the
 * device, `uiautomator` reported 200 nodes of SystemUI and the app underneath did not appear at all.
 * A permanently visible overlay would threaten every screen reading, and the platform gives no way to
 * exclude one from a capture (`screencap` cannot filter layers; the tools that can need root).
 *
 * A heads-up notification has none of that: it appears over another app, its buttons answer without
 * the run having to be interrupted, and it is gone once answered.
 *
 * ## Why the notice is built natively
 *
 * Because of the buttons. A notification action can only be declared with an Android `PendingIntent`,
 * and there is no way to reach a JavaScript listener from one — so the whole notice lives in
 * `MobileClawApprovalReceiver`, and a button press is handed back through a file the runtime polls
 * (`approval-inbox.ts`). The channel's importance is set there too, and it is what decides whether a
 * banner appears at all: `expo-notifications` creates a channel on first use at *default* importance
 * and never revisits it.
 */

/** Native surface, injected so this module stays testable and harmless on a host without it. */
export interface ApprovalNotificationPorts {
  post?(approvalId: string, title: string, body: string): Promise<unknown>;
  dismiss?(approvalId: string): Promise<unknown>;
}

let ports: ApprovalNotificationPorts = {};

export function setApprovalNotificationPorts(next: ApprovalNotificationPorts): void {
  ports = next;
}

export async function postApprovalNotification(approval: {
  id: string;
  title: string;
  detail: string;
}): Promise<void> {
  if (Platform.OS !== "android") return;
  await ports.post?.(approval.id, approval.title, approval.detail);
}

export async function withdrawApprovalNotification(approvalId: string): Promise<void> {
  if (Platform.OS !== "android") return;
  await ports.dismiss?.(approvalId);
}
