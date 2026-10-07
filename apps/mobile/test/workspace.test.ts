import { describe, expect, it } from "vitest";
import {
  WORKSPACES_DIR_NAME,
  describeWorkspace,
  workspacePath,
  workspaceSlug,
} from "@/runtime/workspace";

/**
 * Workspace paths end up as real directory names on the device, so the interesting
 * cases are the hostile ones: a separator or `..` in a conversation id must not be
 * able to place a workspace outside its parent.
 */

describe("workspaceSlug", () => {
  it("keeps ordinary ids untouched", () => {
    expect(workspaceSlug("conv_abc-123")).toBe("conv_abc-123");
  });

  it("cannot escape its parent directory", () => {
    // Path traversal is the failure that matters: this becomes a real mkdir path.
    expect(workspaceSlug("../../etc")).not.toContain("/");
    expect(workspaceSlug("../../etc")).not.toBe("..");
    expect(workspaceSlug("a/../../b")).not.toContain("..");
  });

  it("strips separators from either platform", () => {
    expect(workspaceSlug("a/b\\c")).toBe("a-b-c");
  });

  it("does not produce a hidden directory", () => {
    expect(workspaceSlug(".hidden").startsWith(".")).toBe(false);
  });

  it("falls back rather than returning an empty name", () => {
    expect(workspaceSlug("///")).toBe("conversation");
    expect(workspaceSlug("")).toBe("conversation");
  });

  it("bounds the length so deep paths stay workable", () => {
    expect(workspaceSlug("x".repeat(500)).length).toBeLessThanOrEqual(64);
  });
});

describe("workspacePath", () => {
  it("nests every workspace under one browsable directory", () => {
    expect(workspacePath("/data/app/files", "conv1")).toBe(
      `/data/app/files/${WORKSPACES_DIR_NAME}/conv1`,
    );
  });

  it("tolerates a trailing slash on the base", () => {
    expect(workspacePath("/data/app/files/", "conv1")).toBe(
      `/data/app/files/${WORKSPACES_DIR_NAME}/conv1`,
    );
  });

  it("gives different conversations different directories", () => {
    expect(workspacePath("/base", "a")).not.toBe(workspacePath("/base", "b"));
  });

  it("is stable for the same conversation across calls", () => {
    // Stability is what lets the path be persisted once and reused after a restart.
    expect(workspacePath("/base", "a")).toBe(workspacePath("/base", "a"));
  });
});

describe("describeWorkspace", () => {
  it("says where output belongs rather than forbidding other paths", () => {
    const text = describeWorkspace("/base/workspaces/c1");
    expect(text).toContain("/base/workspaces/c1");
    expect(text).toMatch(/Write files you produce/);
    // The app's whole purpose is managing the user's real files, so the wording must
    // not read as an access restriction.
    expect(text).toMatch(/reading the user's files elsewhere\s+is expected/);
  });
});
