/**
 * Per-conversation workspaces.
 *
 * ## What a workspace is, and what it is not
 *
 * A workspace is a directory the agent is told to treat as *this conversation's*
 * own place: scratch files, exports and anything it produces go there, so two
 * conversations cannot tread on each other's output.
 *
 * It is deliberately **not** a sandbox. The app is for managing the phone's real
 * files, so the shared-storage roots stay readable and writable from every
 * conversation; narrowing the roots to the workspace would break the main use case.
 * What is scoped is *ownership and default location*, not capability. Access control
 * is the permission gate's job (see PermissionGate, which scopes approvals per
 * conversation).
 *
 * The name is derived from the conversation id, so it is stable across restarts and
 * safe to use as a directory name without escaping.
 */

/** Directory under the app's own storage that holds every conversation workspace. */
export const WORKSPACES_DIR_NAME = "workspaces";

/**
 * Turn a conversation id into a filesystem-safe directory name.
 *
 * Ids are generated internally (`createId`) and contain only URL-safe characters, but
 * this is defensive: a stray separator or `..` would otherwise let a workspace name
 * escape its parent.
 */
export function workspaceSlug(conversationId: string): string {
  const cleaned = conversationId
    .replace(/[^A-Za-z0-9._-]/g, "-")
    // A leading dot would make the directory hidden and awkward to browse.
    .replace(/^\.+/, "-")
    .replace(/\.{2,}/g, ".")
    .slice(0, 64)
    // Leading/trailing separators read as noise in a file browser, and an id made
    // entirely of punctuation would otherwise become a name like "---".
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "");
  return cleaned === "" ? "conversation" : cleaned;
}

/** Absolute path of a conversation's workspace, given the app-owned base directory. */
export function workspacePath(baseDir: string, conversationId: string): string {
  const base = baseDir.replace(/\/+$/, "");
  return `${base}/${WORKSPACES_DIR_NAME}/${workspaceSlug(conversationId)}`;
}

/**
 * The line added to the system prompt describing the workspace.
 *
 * Stated positively (where to put things) rather than as a restriction, because the
 * model otherwise tends to invent an output directory per task — which is how a
 * download folder ends up with `output/`, `output2/`, `organized/` and so on.
 */
export function describeWorkspace(path: string): string {
  return [
    `Conversation workspace: ${path}`,
    "Write files you produce (exports, reports, generated scripts) into this workspace",
    "rather than scattering them through the folders you were asked to tidy. It is",
    "yours: other conversations have their own, and reading the user's files elsewhere",
    "is expected — this is about where new files belong.",
  ].join(" ");
}
