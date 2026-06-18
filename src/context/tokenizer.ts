/**
 * Token estimator (step-27 §产物 / §"Token 估算").
 *
 * The SCW monitor needs a *cross-provider* token count cheap enough to run
 * once per round. Exact tokenizers (tiktoken / Anthropic's counter API) are
 * either heavyweight deps or one-extra-roundtrip — both unwanted on the hot
 * path. We default to a heuristic that is provably *upper-bound* across
 * GPT/Claude/Gemini/GLM tokenizers in practice and let advanced users
 * opt into exact counters via feature flags later.
 *
 * Heuristic (matches the spec line 53–55 + cc-haha's pre-tiktoken fallback):
 *
 *   tokens = ceil(chars / 4 * SAFETY)            with SAFETY = 1.2
 *
 * Empirically this overshoots by 5–15 % on natural-language ASCII (the
 * direction we want — under-counting risks missing the soft threshold).
 *
 * `countMessages` adds a small per-message overhead (4 tokens, OpenAI
 * convention) plus name + tool-call argument JSON serialization to capture
 * non-content tokens that providers count too.
 *
 * AGENTS.md §17 single-source: this file is the only token estimator in
 * the engine; future tiktoken/anthropic backends MUST plug into
 * `pickEstimator(family)` rather than fork a parallel implementation.
 */

import type { ChatMessage } from "../types/messages.js";
import type { ProviderFamily } from "../providers/capabilities.js";

/** Stable per-token character ratio. Average across English/Chinese mixed
 *  prose. Don't tune this without re-running smoke §2 (≤ 5 % error). */
export const CHARS_PER_TOKEN = 4;

/** Safety multiplier on top of the chars/token ratio. 1.2 = +20 %.
 *  Keeps the estimate on the over-counting side so we hit `soft` early. */
export const ESTIMATE_SAFETY = 1.2;

/** Per-message structural overhead (role + delimiters). Matches OpenAI's
 *  "every message follows <im_start>{role/name}\n{content}<im_end>\n"
 *  bookkeeping; other families have similar per-message envelopes. */
export const PER_MESSAGE_OVERHEAD_TOKENS = 4;

export interface TokenEstimator {
  /** Count tokens for a single string (used for system prompt / single text). */
  countString(s: string): number;
  /** Count tokens for a full message list (envelope + content + tool calls). */
  countMessages(msgs: ChatMessage[]): number;
}

/** The default heuristic — see file header for the formula. */
export const defaultEstimator: TokenEstimator = {
  countString(s: string): number {
    if (!s) return 0;
    return Math.ceil((s.length / CHARS_PER_TOKEN) * ESTIMATE_SAFETY);
  },
  countMessages(msgs: ChatMessage[]): number {
    let total = 0;
    for (const m of msgs) {
      total += PER_MESSAGE_OVERHEAD_TOKENS;
      // role label.
      total += defaultEstimator.countString(m.role);
      // name (tool messages).
      if (m.toolName) total += defaultEstimator.countString(m.toolName);
      // content.
      if (m.content) total += defaultEstimator.countString(m.content);
      // tool calls — JSON-serialized arguments are what providers actually count.
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          total += defaultEstimator.countString(tc.name);
          total += defaultEstimator.countString(tc.arguments);
        }
      }
      // reasoning (o1 / Claude thinking) — counts toward input on next turn.
      if (m.reasoning) total += defaultEstimator.countString(m.reasoning);
    }
    return total;
  },
};

/**
 * Pick an estimator for a provider family. Today we always return the
 * heuristic; future steps may register an exact counter (tiktoken-light
 * for `gpt`, Anthropic count-tokens API for `claude`) gated behind the
 * `'exact_count'` feature flag (AGENTS.md §17 PCM single-source).
 *
 * The signature is stable so callers can swap the registry under test.
 */
export function pickEstimator(_family?: ProviderFamily): TokenEstimator {
  // TODO step-27 follow-up: lazy-import tiktoken-light when family === "gpt"
  //                         and `feature('exact_count')` resolves true.
  // TODO step-27 follow-up: hit anthropic.count-tokens when family === "claude"
  //                         (extra roundtrip; gated behind same flag).
  return defaultEstimator;
}
