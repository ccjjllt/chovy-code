/**
 * tasks/<id>/progress.md read/write helpers (step-24).
 *
 * `progress.md` is the per-task running log. No hard line cap (long-running
 * `/goal` tasks can churn for hours), but reads tail-truncate to 32 KB so the
 * model isn't fed unbounded context. Writes always *append* — the log is
 * intentionally chronological.
 */

import { safeFs } from "../../fs/safeFs.js";
import { goalProgressFile } from "../../fs/paths.js";
import { logger } from "../../logger/index.js";

/** Tail size returned by `readProgressFile` when the underlying file is large. */
export const PROGRESS_TAIL_BYTES = 32_000;

export interface ProgressFileRead {
  content: string;
  truncated: boolean;
  byteCount: number;
  path: string;
  existed: boolean;
}

/**
 * Read a task's progress.md. Returns the tail (last `PROGRESS_TAIL_BYTES`
 * bytes, cut on a newline boundary) when over the cap; full content otherwise.
 */
export async function readProgressFile(
  cwd: string,
  taskId: string,
): Promise<ProgressFileRead> {
  const path = goalProgressFile(cwd, taskId);
  const exists = await safeFs.exists(path);
  if (!exists) {
    return { content: "", truncated: false, byteCount: 0, path, existed: false };
  }
  const raw = (await safeFs.read(path)).replace(/^\uFEFF/, "");
  const byteCount = raw.length;
  if (byteCount <= PROGRESS_TAIL_BYTES) {
    return { content: raw, truncated: false, byteCount, path, existed: true };
  }
  const tail = raw.slice(byteCount - PROGRESS_TAIL_BYTES);
  // Cut to the next newline so we don't start mid-line.
  const cut = tail.indexOf("\n");
  const body = cut >= 0 ? tail.slice(cut + 1) : tail;
  logger.debug(`progressFile: tail-truncated ${path}`, { byteCount });
  return {
    content: `> NOTE: progress.md is ${byteCount} bytes; showing last ${body.length} bytes.\n\n${body}`,
    truncated: true,
    byteCount,
    path,
    existed: true,
  };
}

/** Append a chronological entry. The log header is `## YYYY-MM-DDTHH:mm:ssZ`. */
export async function appendProgress(
  cwd: string,
  taskId: string,
  entry: string,
): Promise<void> {
  const path = goalProgressFile(cwd, taskId);
  const stamp = new Date().toISOString();
  const block = `\n## ${stamp}\n\n${entry.trim()}\n`;
  await safeFs.append(path, block);
}

/**
 * Overwrite the entire progress.md (used by step-26 checkpoint-writer when
 * compacting the log). Atomic via `safeFs.write`.
 */
export async function writeProgressFile(
  cwd: string,
  taskId: string,
  content: string,
): Promise<void> {
  await safeFs.write(goalProgressFile(cwd, taskId), content);
}
