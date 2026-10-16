import { describe, expect, it } from "vitest";
import { parseInbox, readInbox } from "@/runtime/approval-inbox";

describe("parseInbox", () => {
  it("reads a decision", () => {
    const line = JSON.stringify({ approvalId: "approval_1", approved: true, at: 1 });
    expect(parseInbox(`${line}\n`)).toEqual([{ approvalId: "approval_1", approved: true }]);
  });

  it("reads a denial as an answer, not as no answer", () => {
    // The distinction the feature turns on. A missing answer read as a denial stops runs silently; read
    // as consent it performs a mutating action nobody agreed to.
    const line = JSON.stringify({ approvalId: "approval_1", approved: false });
    expect(parseInbox(line)).toEqual([{ approvalId: "approval_1", approved: false }]);
  });

  it("tolerates the torn last line a concurrent append can produce", () => {
    // The receiver appends while JavaScript reads. Losing one line is recoverable — the user can answer
    // again — where throwing would abandon every answer in the file.
    const good = JSON.stringify({ approvalId: "approval_1", approved: true });
    const torn = '{"approvalId":"approval_2","appro';
    expect(parseInbox(`${good}\n${torn}`)).toEqual([{ approvalId: "approval_1", approved: true }]);
  });

  it("skips a line whose approved flag is not a boolean", () => {
    // "yes" is not a decision. Guessing at it is exactly the kind of inference this file refuses.
    expect(parseInbox('{"approvalId":"a","approved":"yes"}')).toEqual([]);
  });

  it("skips a line with no id", () => {
    // A decision that cannot be routed is not a decision.
    expect(parseInbox('{"approved":true}')).toEqual([]);
  });

  it("ignores blank lines", () => {
    const line = JSON.stringify({ approvalId: "a", approved: true });
    expect(parseInbox(`\n\n${line}\n\n`)).toHaveLength(1);
  });

  it("reads an empty file as no answers", () => {
    expect(parseInbox("")).toEqual([]);
  });

  it("keeps the order the decisions were written in", () => {
    const a = JSON.stringify({ approvalId: "a", approved: true });
    const b = JSON.stringify({ approvalId: "b", approved: false });
    expect(parseInbox(`${a}\n${b}`).map((d) => d.approvalId)).toEqual(["a", "b"]);
  });
});

describe("readInbox", () => {
  it("returns nothing when the host has no reader", async () => {
    // A host without the native module still runs; the in-app sheet remains the way to answer.
    expect(await readInbox(undefined)).toEqual([]);
  });

  it("returns nothing when the file cannot be read", async () => {
    const failing = async () => {
      throw new Error("ENOENT");
    };
    // No answers waiting is the safe reading: the question is still in the app's own sheet.
    expect(await readInbox(failing)).toEqual([]);
  });

  it("asks for the whole file from the beginning", async () => {
    const calls: Array<[string, number, number]> = [];
    const read = async (path: string, offset: number, length: number) => {
      calls.push([path, offset, length]);
      return { size: 0, offset: 0, content: "", eof: true };
    };
    await readInbox(read);
    expect(calls[0]?.[0]).toBe("mobileclaw-approvals.jsonl");
    expect(calls[0]?.[1]).toBe(0);
    expect(calls[0]?.[2]).toBeGreaterThan(0);
  });
});
