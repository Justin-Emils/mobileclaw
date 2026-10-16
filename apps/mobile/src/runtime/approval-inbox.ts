/**
 * Answers that arrived from the notification, handed over through a file.
 *
 * ## Why not a URL, as before
 *
 * The first version had the receiver start the launch activity with the answer as a
 * `mobileclaw://approval?…` URL. It worked, and it was the wrong shape twice over:
 *
 *  - It put MobileClaw in front of whatever the user was doing, **every time**. Not being interrupted is
 *    the entire point of answering from the notification, so the mechanism defeated the feature. The
 *    original note even claimed the interruption was a feature — "the user has just made a decision, so
 *    showing them where the run stopped is useful" — which is not what a user who chose a button in the
 *    shade is asking for.
 *  - The launch used `FLAG_ACTIVITY_CLEAR_TOP` with `ACTION_VIEW`, so the task was cleared and the chat
 *    screen remounted. The redirected `/?id=…` was briefly absent during that remount, and
 *    `app/index.tsx` treats "no id" as a **new conversation** — so approving a step replaced the run the
 *    user had just approved with an empty chat.
 *
 * ## What this is instead
 *
 * A file, appended by the native receiver and read by the runtime. The process is alive when a button is
 * pressed — the run is parked mid-step and the foreground service holds the process up — so the answer
 * can be handed over in-process, with nothing brought to the front.
 *
 * A file rather than a broadcast because it needs no registration ordering: the receiver may fire while
 * JavaScript is between polls or mid-render, and a missed broadcast is an approval that never resolves.
 * The reader is idempotent, so reading the same answer twice is harmless.
 *
 * The format is one JSON object per line. A partially written last line is skipped rather than throwing,
 * because a torn write is a real possibility and losing one line is recoverable where a parse error in
 * the middle of an approval is not.
 */

/** Must match `INBOX_FILE` in `MobileClawApprovalReceiver.kt`. */
export const APPROVAL_INBOX_FILE = "mobileclaw-approvals.jsonl";

/** How much of the file to ask for. A decision is under 100 bytes; this holds thousands. */
const READ_LIMIT = 64 * 1024;

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
}

/** Reads the inbox file, or `undefined` where the host has no such channel. */
export type ReadInbox = (
  relativePath: string,
  offset: number,
  length: number,
) => Promise<{ size: number; offset: number; content: string; eof: boolean }>;

/**
 * Parse the inbox.
 *
 * Returns every decision found, and tolerates the malformed last line a concurrent append can produce.
 */
export function parseInbox(contents: string): ApprovalDecision[] {
  const decisions: ApprovalDecision[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as { approvalId?: unknown; approved?: unknown };
      // Both fields are required and must be the right type: a decision missing its id cannot be routed,
      // and one whose `approved` is not a boolean is not something to guess at.
      if (typeof parsed.approvalId !== "string" || typeof parsed.approved !== "boolean") continue;
      decisions.push({ approvalId: parsed.approvalId, approved: parsed.approved });
    } catch {
      // A torn line. Skipping is safer than throwing: the write is not atomic, and the answer it was
      // carrying is one the user can give again.
    }
  }
  return decisions;
}

/**
 * Read decisions from the inbox.
 *
 * Whole-file reads rather than offsets: the file is truncated after every drain (see `drainInbox`), so
 * it is normally empty or holds one or two lines. Tracking an offset would add a failure mode — a
 * truncated file whose remembered offset is now past the end — for no measurable gain.
 */
export async function readInbox(read: ReadInbox | undefined): Promise<ApprovalDecision[]> {
  if (!read) return [];
  try {
    const result = await read(APPROVAL_INBOX_FILE, 0, READ_LIMIT);
    return parseInbox(result.content);
  } catch {
    // No file yet, or it cannot be read. Both mean "no answers waiting", which is the safe answer:
    // the question is still in the app's own sheet.
    return [];
  }
}
