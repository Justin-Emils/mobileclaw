import { afterEach, describe, expect, it, vi } from "vitest";
import {
  postApprovalNotification,
  setApprovalNotificationPorts,
  withdrawApprovalNotification,
} from "@/runtime/approval-notify";

/**
 * What is left to test here is the port plumbing.
 *
 * The URL parsing that used to live in this module is gone: the native receiver no longer starts the
 * app with an answer, because that brought MobileClaw to the front every time and cleared the task,
 * which turned the approved run into a new conversation. Answers arrive through a file instead, and
 * that parsing is covered by `approval-inbox.test.ts`.
 */

afterEach(() => {
  setApprovalNotificationPorts({});
  vi.restoreAllMocks();
});

describe("postApprovalNotification", () => {
  it("hands the question to the native port", async () => {
    const post = vi.fn(async () => undefined);
    setApprovalNotificationPorts({ post });
    await postApprovalNotification({ id: "approval_7", title: "标题", detail: "细节" });
    expect(post).toHaveBeenCalledWith("approval_7", "标题", "细节");
  });

  it("does nothing when no port is installed", async () => {
    // A host without the native module still runs; the in-app sheet remains the way to answer.
    await expect(
      postApprovalNotification({ id: "a", title: "t", detail: "d" }),
    ).resolves.toBeUndefined();
  });

  it("surfaces a port that fails, so the caller can log it", async () => {
    // The runtime logs this and carries on; swallowing it here would hide a channel that never got
    // created, which is the difference between a visible question and a run that looks hung.
    setApprovalNotificationPorts({
      post: async () => {
        throw new Error("no channel");
      },
    });
    await expect(postApprovalNotification({ id: "a", title: "t", detail: "d" })).rejects.toThrow(
      "no channel",
    );
  });
});

describe("withdrawApprovalNotification", () => {
  it("takes the question down by id", async () => {
    const dismiss = vi.fn(async () => undefined);
    setApprovalNotificationPorts({ dismiss });
    await withdrawApprovalNotification("approval_7");
    expect(dismiss).toHaveBeenCalledWith("approval_7");
  });

  it("does nothing when no port is installed", async () => {
    await expect(withdrawApprovalNotification("approval_7")).resolves.toBeUndefined();
  });
});
