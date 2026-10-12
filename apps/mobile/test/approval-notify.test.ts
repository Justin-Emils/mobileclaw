import { describe, expect, it } from "vitest";
import { readApprovalUrl } from "@/runtime/approval-notify";

describe("readApprovalUrl", () => {
  it("reads an approval", () => {
    expect(readApprovalUrl("mobileclaw://approval?id=approval_7&approved=true")).toEqual({
      approvalId: "approval_7",
      approved: true,
    });
  });

  it("reads a denial as an answer, not as no answer", () => {
    // The distinction the feature turns on. A missing answer read as a denial would stop runs
    // silently; read as consent it would perform a mutating action nobody agreed to.
    expect(readApprovalUrl("mobileclaw://approval?id=approval_7&approved=false")).toEqual({
      approvalId: "approval_7",
      approved: false,
    });
  });

  it("ignores a deep link that is not an approval answer", () => {
    // The app receives every mobileclaw:// link here, including the ones that navigate.
    expect(readApprovalUrl("mobileclaw://logs")).toBeUndefined();
    expect(readApprovalUrl("mobileclaw://")).toBeUndefined();
  });

  it("ignores a missing or unreadable approved flag", () => {
    expect(readApprovalUrl("mobileclaw://approval?id=approval_7")).toBeUndefined();
    expect(readApprovalUrl("mobileclaw://approval?id=approval_7&approved=yes")).toBeUndefined();
  });

  it("ignores a missing id", () => {
    expect(readApprovalUrl("mobileclaw://approval?approved=true")).toBeUndefined();
  });

  it("reports nothing for no url at all", () => {
    expect(readApprovalUrl(null)).toBeUndefined();
    expect(readApprovalUrl(undefined)).toBeUndefined();
    expect(readApprovalUrl("")).toBeUndefined();
  });
});
