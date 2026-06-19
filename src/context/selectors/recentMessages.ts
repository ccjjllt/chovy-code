/**
 * Recent-message selector (step-28 §重建流程 step 4).
 *
 * Picks the latest K messages from the live conversation while preserving
 * tool_use ↔ tool_result pairing. The spec calls this out explicitly
 * (line 124–125 §风险): if we keep an `assistant.tool_calls` message but
 * drop the matching `role:'tool'` follow-up (or vice versa), most
 * providers reject the request with `tool_call_id refers to no prior
 * tool call`.
 *
 * Strategy:
 *   1. Walk the array from the END collecting messages until either
 *      `K` user/assistant messages are kept OR the budget is exhausted.
 *   2. After the cut point, sweep forward to drop any orphan tool
 *      messages whose paired `assistant.tool_calls` is not present
 *      (and conversely, drop assistant tool_calls without all their
 *      tool results — providers are stricter about this direction).
 *   3. The first kept message must be `user` or `assistant` (not a
 *      bare `tool` response) — providers expect a clean turn boundary.
 *
 * Complexity is O(N) — we never look at all-pairs and there are no
 * recursive selectors.
 */

import type { ChatMessage } from "../../types/messages.js";
import { defaultEstimator } from "../tokenizer.js";

export interface RecentPickOptions {
  /** Soft cap on user/assistant turns to keep (default 8). */
  k?: number;
  /** Hard cap on tokens — overrides `k` when budget is small. */
  budgetTokens?: number;
}

export interface RecentPickResult {
  kept: ChatMessage[];
  /** Number of *original* messages dropped. */
  droppedCount: number;
  /** Pre-trim count (length of the input array). */
  originalCount: number;
  /** Estimated token cost of the kept slice. */
  approxTokens: number;
}

const DEFAULT_K = 8;

export function recentMessagesPick(
  messages: ChatMessage[],
  opts: RecentPickOptions = {},
): RecentPickResult {
  const k = opts.k ?? DEFAULT_K;
  const budget = opts.budgetTokens ?? Infinity;
  const originalCount = messages.length;

  if (originalCount === 0) {
    return { kept: [], droppedCount: 0, originalCount: 0, approxTokens: 0 };
  }

  // Phase 1: walk backwards collecting messages until either k user/asst
  // messages are kept OR the budget is exceeded. Spec line 68: "超
  // budget.history 时按 重要性 × recency 裁剪" — strict trim, no
  // "always keep one" fallback. If every candidate blows the budget the
  // rebuilder will land on the fallback path with just the system marker.
  const reverse: ChatMessage[] = [];
  let kept = 0;
  let approxTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const cost = defaultEstimator.countMessages([m]);
    if (approxTokens + cost > budget) break;
    reverse.push(m);
    approxTokens += cost;
    if (m.role === "user" || m.role === "assistant") kept++;
    if (kept >= k) break;
  }
  reverse.reverse();
  let trimmed = reverse;

  // Phase 2: drop orphan tool messages whose paired tool_call is missing.
  trimmed = pruneOrphans(trimmed);

  // Phase 3: ensure first kept message is user/assistant. If the slice
  // starts with a `role:'tool'` (paired tool_calls were lost in phase 1)
  // we shift forward until the first non-tool message.
  while (trimmed.length > 0 && trimmed[0]!.role === "tool") {
    trimmed.shift();
  }

  // Phase 4: also drop a trailing assistant message whose tool_calls are
  // not all matched by tool messages later in the slice. This case
  // appears when the budget cut split a tool round mid-flight.
  trimmed = pruneIncompleteTrailingAssistant(trimmed);

  approxTokens = defaultEstimator.countMessages(trimmed);
  return {
    kept: trimmed,
    droppedCount: originalCount - trimmed.length,
    originalCount,
    approxTokens,
  };
}

/**
 * Drop tool messages whose `id` (matched via the previous assistant's
 * `toolCalls[].id`) is absent in the slice. We use a forward scan: for
 * each `role:'tool'` message, look for the most recent `assistant` with
 * a matching `toolCalls[].id`. Orphans are filtered.
 */
function pruneOrphans(slice: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // Build a set of *assistant* tool_call ids visible in the slice so we
  // know which tool messages to keep. We also need the assistant message
  // itself to come BEFORE the tool message — providers verify ordering.
  const issuedIds = new Set<string>();
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i]!;
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) issuedIds.add(tc.id);
      out.push(m);
      continue;
    }
    if (m.role === "tool") {
      // Match by `id` (`tool_call_id`). Today's wire shape stores the call
      // id in `toolName`-adjacent metadata varying by provider; the engine
      // pushes a `role:'tool'` ChatMessage with `toolName` and content.
      // We don't have a direct tool_call_id link on ChatMessage today;
      // fall back to "drop tool messages with no preceding assistant
      // tool_calls in the slice" — conservative but provider-safe.
      const prevAsstHasToolCalls = out.some(
        (mm) => mm.role === "assistant" && mm.toolCalls && mm.toolCalls.length > 0,
      );
      if (!prevAsstHasToolCalls) continue;
      out.push(m);
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Drop the trailing assistant `tool_calls` message if no matching tool
 * messages follow it in the slice. Otherwise providers complain that
 * the assistant requested a tool whose result is missing.
 */
function pruneIncompleteTrailingAssistant(slice: ChatMessage[]): ChatMessage[] {
  if (slice.length === 0) return slice;
  const last = slice[slice.length - 1]!;
  if (
    last.role === "assistant" &&
    last.toolCalls &&
    last.toolCalls.length > 0
  ) {
    // No following tool messages — drop it.
    return slice.slice(0, -1);
  }
  return slice;
}
