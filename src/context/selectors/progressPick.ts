/**
 * Progress selector (step-28 §重建流程 step 3).
 *
 * Returns the active goal's `progress.md` tail, trimmed to a token budget.
 * `progress.md` is a chronological append-only log (step-24
 * `appendProgress`); the *tail* (most recent entries) is what we want
 * when reconstructing context — older entries are already captured by
 * the latest checkpoint snapshot.
 *
 * Returns `null` when:
 *   - `goalId` is undefined (no active /goal — rebuilder simply omits
 *     the `<task-progress>` block per spec line 76-77).
 *   - progress.md doesn't exist for this goal id.
 *   - budgetTokens ≤ 0.
 *   - safeFs read throws.
 */

import { logger } from "../../logger/index.js";
import { readProgressFile } from "../../memory/files/progressFile.js";
import { defaultEstimator } from "../tokenizer.js";

export interface ProgressPickResult {
  text: string;
  bytes: number;
  truncated: boolean;
  approxTokens: number;
  path: string;
  /** Was the file already tail-truncated by readProgressFile (32 KB cap)? */
  fileTruncated: boolean;
}

const TRIM_MARKER = "\n\n…(progress tail trimmed by rebuilder)\n";

export async function progressPick(
  cwd: string,
  goalId: string | undefined,
  budgetTokens: number,
): Promise<ProgressPickResult | null> {
  if (!goalId) return null;
  if (budgetTokens <= 0) return null;

  let read;
  try {
    read = await readProgressFile(cwd, goalId);
  } catch (err) {
    logger.warn("progressPick: read failed", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!read.existed || !read.content.trim()) return null;

  const body = read.content;
  const tokens = defaultEstimator.countString(body);
  if (tokens <= budgetTokens) {
    return {
      text: body,
      bytes: Buffer.byteLength(body, "utf8"),
      truncated: false,
      approxTokens: tokens,
      path: read.path,
      fileTruncated: read.truncated,
    };
  }

  // Tail trim: keep the *last* `budgetTokens` worth of content (chronological
  // log — newer entries matter more than older ones).
  const charBudget = Math.max(0, Math.floor(budgetTokens * 4 / 1.2));
  const room = charBudget - TRIM_MARKER.length;
  if (room <= 0) {
    return {
      text: "",
      bytes: 0,
      truncated: true,
      approxTokens: 0,
      path: read.path,
      fileTruncated: read.truncated,
    };
  }
  // Cut to next newline so we don't start mid-line.
  let tail = body.slice(body.length - room);
  const cut = tail.indexOf("\n");
  if (cut >= 0 && cut < tail.length - 1) tail = tail.slice(cut + 1);
  const trimmed = TRIM_MARKER + tail;
  return {
    text: trimmed,
    bytes: Buffer.byteLength(trimmed, "utf8"),
    truncated: true,
    approxTokens: defaultEstimator.countString(trimmed),
    path: read.path,
    fileTruncated: read.truncated,
  };
}
