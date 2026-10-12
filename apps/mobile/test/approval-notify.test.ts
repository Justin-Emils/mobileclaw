import { describe, expect, it } from "vitest";
import type { NotificationResponse } from "expo-notifications";
import {
  APPROVE_ACTION,
  APPROVAL_CATEGORY,
  DENY_ACTION,
  approvalIdFrom,
  readApprovalResponse,
} from "@/runtime/approval-notify";

/** A notification response, with only the fields the reader is entitled to look at. */
function response(over: {
  actionIdentifier?: string;
  identifier?: string;
  data?: Record<string, unknown>;
}): NotificationResponse {
  return {
    actionIdentifier: over.actionIdentifier ?? "",
    notification: {
      request: {
        identifier: over.identifier ?? "approval_1",
        content: { data: over.data ?? {} },
      },
    },
  } as unknown as NotificationResponse;
}

describe("readApprovalResponse", () => {
  it("reads an approval from the data payload", () => {
    const answer = readApprovalResponse(
      response({ actionIdentifier: APPROVE_ACTION, data: { approvalId: "approval_7" } }),
    );
    expect(answer).toEqual({ approvalId: "approval_7", approved: true });
  });

  it("reads a denial as an answer, not as no answer", () => {
    // The distinction the whole feature turns on: "no answer" must not be confused with "said no".
    // A missing approval was the failure mode that left runs waiting forever.
    const answer = readApprovalResponse(
      response({ actionIdentifier: DENY_ACTION, data: { approvalId: "approval_7" } }),
    );
    expect(answer).toEqual({ approvalId: "approval_7", approved: false });
  });

  it("falls back to the notification identifier when the payload is empty", () => {
    // An Android action button rebuilds the notification from its own record, and `data` does not
    // always survive that trip. The identifier is the approval id, so it is the second route in.
    const answer = readApprovalResponse(
      response({ actionIdentifier: APPROVE_ACTION, identifier: "approval_9", data: {} }),
    );
    expect(answer).toEqual({ approvalId: "approval_9", approved: true });
  });

  it("ignores a tap on the body rather than treating it as consent", () => {
    // Opening the app is not an answer. Reading it as one would approve a mutating action the user
    // never agreed to.
    expect(
      readApprovalResponse(
        response({ actionIdentifier: "expo.modules.notifications.actions.DEFAULT", data: { approvalId: "a" } }),
      ),
    ).toBeUndefined();
  });

  it("ignores an unrelated notification", () => {
    expect(readApprovalResponse(response({ actionIdentifier: APPROVE_ACTION, data: {} , identifier: ""}))).toBeUndefined();
  });

  it("ignores a non-string approval id", () => {
    expect(
      readApprovalResponse(response({ actionIdentifier: APPROVE_ACTION, data: { approvalId: 42 }, identifier: "" })),
    ).toBeUndefined();
  });
});

describe("approvalIdFrom", () => {
  it("treats the identifier as the approval id", () => {
    expect(approvalIdFrom("approval_3")).toBe("approval_3");
  });

  it("reports nothing for an empty identifier", () => {
    expect(approvalIdFrom("")).toBeUndefined();
    expect(approvalIdFrom(null)).toBeUndefined();
    expect(approvalIdFrom(undefined)).toBeUndefined();
  });
});

describe("the action identifiers", () => {
  it("are distinct, so a button press cannot be read as the other button", () => {
    expect(APPROVE_ACTION).not.toBe(DENY_ACTION);
    expect(APPROVAL_CATEGORY).toBeTruthy();
  });
});
