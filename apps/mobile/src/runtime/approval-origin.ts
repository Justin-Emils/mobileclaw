/**
 * Which conversation a notification answer belongs to.
 *
 * ## The problem
 *
 * A notification button cannot reach JavaScript directly — an Android notification action is a
 * `PendingIntent`, so the answer comes back to the app as a URL (`mobileclaw://approval?…`). That
 * URL is a *route*, and answering it sends the user to `app/approval.tsx`.
 *
 * On a device that screen redirected to `/`, and **`/` with no `?id=` is a brand-new conversation**:
 * the user answered a question about the run they were watching and was dropped into an empty chat,
 * with the original conversation still in the list. Answering a question must not change what the
 * user is looking at.
 *
 * ## What this stores
 *
 * The conversation the app was showing when the app went to the background, set by `index.tsx` while
 * it is focused. `approval.tsx` reads it and goes back there instead of to a fresh chat.
 *
 * A module-level store rather than context because the two screens are reached through different
 * mounts: the index screen may never have rendered on a cold start, and a value in a provider would
 * arrive too late to be useful — the redirect has to happen on the first frame that can see the
 * runtime.
 */

interface ApprovalOrigin {
  /** `undefined` means the user was in an unsaved new conversation, which is also worth returning to. */
  conversationId?: string;
}

let origin: ApprovalOrigin | undefined;

/** What `index.tsx` calls while it is the screen in front. */
export function rememberApprovalOrigin(conversationId: string | undefined): void {
  // A deleted or stale id is still the honest answer: the index screen falls back to a new chat on
  // its own, and guessing here would put the user somewhere they never were.
  origin = { conversationId };
}

export function approvalOrigin(): ApprovalOrigin | undefined {
  return origin;
}

/** Test seam: forget the remembered conversation. */
export function resetApprovalOrigin(): void {
  origin = undefined;
}
