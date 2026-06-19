/**
 * Checkpoint selector (step-28 §重建流程 step 1).
 *
 * Reads `~/.chovy/projects/<id>/checkpoints/latest.md` (step-26 artifact)
 * and returns its body trimmed to a token budget. The checkpoint markdown
 * is already 7-section + ≤ 8 KB by step-26 contract, so we usually return
 * it verbatim; the trim path only fires for edge cases (corrupted file,
 * user-edited oversized files, very small budgets).
 *
 * Returns `null` when:
 *   - latest.md doesn't exist (no checkpoint ever taken — first session
 *     to hit hard threshold; rebuilder falls back per spec line 106-108).
 *   - safeFs.read throws (permission, IO, etc.).
 *   - budgetTokens ≤ 0 (caller decided to skip this slot).
 */

import { logger } from "../../logger/index.js";
import { safeFs } from "../../fs/safeFs.js";
import { latestCheckpointFile } from "../../fs/paths.js";
import { defaultEstimator } from "../tokenizer.js";

export interface CheckpointPickResult {
  text: string;
  bytes: number;
  truncated: boolean;
  /** Estimated tokens in the returned text. */
  approxTokens: number;
  path: string;
}

const TRUNCATION_MARKER = "\n\n…(checkpoint trimmed by rebuilder)\n";

/**
 * Pick the latest checkpoint, capped to `budgetTokens`. Returns `null`
 * when no checkpoint is available — caller is expected to use the
 * fallback path (`<rule-summary>...</rule-summary>` per spec).
 */
export async function checkpointPick(
  cwd: string,
  budgetTokens: number,
): Promise<CheckpointPickResult | null> {
  if (budgetTokens <= 0) return null;
  const path = latestCheckpointFile(cwd);
  if (!(await safeFs.exists(path))) return null;

  let raw: string;
  try {
    raw = await safeFs.read(path);
  } catch (err) {
    logger.warn("checkpointPick: read failed", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Strip leading BOM if present (handcrafted files sometimes carry one).
  const body = raw.replace(/^\uFEFF/, "");
  const tokens = defaultEstimator.countString(body);
  if (tokens <= budgetTokens) {
    return {
      text: body,
      bytes: Buffer.byteLength(body, "utf8"),
      truncated: false,
      approxTokens: tokens,
      path,
    };
  }

  // Token-aware trim. Approximation: budget * CHARS_PER_TOKEN / SAFETY
  // gives the *char* budget that the estimator would map to budgetTokens.
  // Keep head (which has the title + Goal section) + tail (which has
  // Next intended steps).
  const charBudget = Math.max(0, Math.floor(budgetTokens * 4 / 1.2));
  const room = charBudget - TRUNCATION_MARKER.length;
  if (room <= 0) {
    // Budget too small for even a marker — return empty.
    return {
      text: "",
      bytes: 0,
      truncated: true,
      approxTokens: 0,
      path,
    };
  }
  const half = Math.floor(room / 2);
  const trimmed = body.slice(0, half) + TRUNCATION_MARKER + body.slice(body.length - half);
  return {
    text: trimmed,
    bytes: Buffer.byteLength(trimmed, "utf8"),
    truncated: true,
    approxTokens: defaultEstimator.countString(trimmed),
    path,
  };
}
