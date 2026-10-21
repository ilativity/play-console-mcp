import { GoogleApiError, appPath, editPath, type PlayClient } from "./client.js";

export interface EditOptions {
  /** Validate the edit, then discard it. Nothing changes in the Console. */
  validateOnly?: boolean;
  /** For apps with managed publishing: commit without sending the changes for review. */
  changesNotSentForReview?: boolean;
}

export interface EditOutcome<T> {
  result: T;
  editId: string;
  dryRun: boolean;
  committed: boolean;
  changesNotSentForReview?: boolean;
  note?: string;
}

/**
 * Opens an edit, runs `fn` in it, then validates-and-discards (dry run) or commits.
 * Any edit that is not committed is deleted in `finally`, so a failure never leaves
 * an open edit behind to block the next one.
 */
export async function withEdit<T>(
  client: PlayClient,
  pkg: string,
  fn: (editId: string) => Promise<T>,
  opts: EditOptions = {},
): Promise<EditOutcome<T>> {
  const edit = await client.request<{ id: string }>("publisher", `${appPath(pkg)}/edits`, {
    method: "POST",
    json: {},
  });
  const editId = edit.id;
  const base = editPath(pkg, editId);
  let committed = false;
  try {
    const result = await fn(editId);
    if (opts.validateOnly) {
      await client.request("publisher", `${base}:validate`, { method: "POST" });
      return { result, editId, dryRun: true, committed: false, note: "Validated and discarded; nothing changed." };
    }
    const commit = await commitEdit(client, base, opts.changesNotSentForReview === true);
    committed = true;
    return { result, editId, dryRun: false, committed: true, ...commit };
  } finally {
    if (!committed) {
      await client.request("publisher", base, { method: "DELETE" }).catch(() => {});
    }
  }
}

/** Opens an edit for reading only; it is always deleted afterwards. */
export async function withReadEdit<T>(client: PlayClient, pkg: string, fn: (editId: string) => Promise<T>): Promise<T> {
  const edit = await client.request<{ id: string }>("publisher", `${appPath(pkg)}/edits`, {
    method: "POST",
    json: {},
  });
  try {
    return await fn(edit.id);
  } finally {
    await client.request("publisher", editPath(pkg, edit.id), { method: "DELETE" }).catch(() => {});
  }
}

function needsNotSentForReview(e: unknown): boolean {
  return e instanceof GoogleApiError && e.status === 400 && JSON.stringify(e.body).includes("changesNotSentForReview");
}

async function commitEdit(
  client: PlayClient,
  base: string,
  notSentForReview: boolean,
): Promise<{ changesNotSentForReview?: boolean; note?: string }> {
  try {
    await client.request("publisher", `${base}:commit`, {
      method: "POST",
      query: notSentForReview ? { changesNotSentForReview: true } : undefined,
    });
    return notSentForReview
      ? { changesNotSentForReview: true, note: "Committed but NOT sent for review. Send it for review in Play Console." }
      : {};
  } catch (e) {
    // Managed publishing (or a previously rejected update) refuses an auto-send.
    // Commit anyway, held back, and say so — the user still decides when it goes to review.
    if (!notSentForReview && needsNotSentForReview(e)) {
      await client.request("publisher", `${base}:commit`, {
        method: "POST",
        query: { changesNotSentForReview: true },
      });
      return {
        changesNotSentForReview: true,
        note: "Google refused to send these changes for review automatically (managed publishing). They were committed and are waiting in Play Console → Publishing overview for you to send for review.",
      };
    }
    throw e;
  }
}
