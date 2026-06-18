/**
 * Provider Capability Matrix — PCM (step-17).
 *
 * Single source of truth for "what can each provider do, and at what
 * price". The QueryEngine (step-16) consults this to:
 *   - choose between native tools, json-mode tool emulation, and a pure
 *     prompt fallback (`tools: 'no'`);
 *   - decide whether streaming is even worth attempting;
 *   - feed `costTracker.ModelPrice` defaults so single-source updates here
 *     ripple into the spend tracker;
 *   - clip `maxTokens` requests when the user asks for more than the
 *     provider's per-call cap.
 *
 * Design notes:
 *   - The frozen `ProviderCapabilities` from `src/types/provider.ts` is
 *     a coarse boolean matrix from step-01. Step-17 introduces the richer
 *     `ProviderCapabilitySpec` defined here without breaking the older
 *     interface — both are exported and `getCapability()` returns the
 *     richer one. Existing consumers of the boolean version stay valid.
 *   - Pricing is expressed in USD per 1M tokens (matching the cost tracker's
 *     `inputPerMTok` / `outputPerMTok` shape).
 *   - `family` is the shared streaming dialect — gpt / claude / gemini /
 *     deepseek / glm / kimi / minimax. Most non-OpenAI families fall back
 *     to the gpt SSE dialect because they ship OpenAI-compatible
 *     /chat/completions endpoints.
 */

import type { ProviderId } from "../types/provider.js";

/** Tool support — native function calling, json-mode emulation, or none. */
export type ToolSupportMode = "native" | "json-mode" | "no";

/** Provider streaming dialect — see `streaming.ts` for the merger map. */
export type ProviderFamily =
  | "gpt"
  | "claude"
  | "gemini"
  | "deepseek"
  | "glm"
  | "kimi"
  | "minimax";

/** USD per 1M tokens — matches `engine/costTracker.ts` `ModelPrice`. */
export interface PricingSpec {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** PCM entry — frozen at step-17. New fields MUST be added optionally. */
export interface ProviderCapabilitySpec {
  contextWindow: number;
  supportsStreaming: boolean;
  supportsTools: ToolSupportMode;
  supportsVision: boolean;
  supportsJsonMode: boolean;
  supportsParallelToolCalls: boolean;
  maxOutputTokens: number;
  pricing: PricingSpec;
  family: ProviderFamily;
}

/**
 * The capability table. Keep entries in alphabetical order so a `git diff`
 * surfaces re-pricing cleanly.
 */
export const CAPS: Record<ProviderId, ProviderCapabilitySpec> = {
  anthropic: {
    contextWindow: 200_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: false,
    supportsParallelToolCalls: true,
    maxOutputTokens: 8192,
    pricing: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    family: "claude",
  },
  deepseek: {
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: false,
    supportsJsonMode: true,
    supportsParallelToolCalls: false,
    maxOutputTokens: 8192,
    pricing: { in: 0.27, out: 1.1 },
    family: "deepseek",
  },
  gemini: {
    contextWindow: 1_000_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: true,
    supportsParallelToolCalls: false,
    maxOutputTokens: 8192,
    pricing: { in: 0.075, out: 0.3 },
    family: "gemini",
  },
  glm: {
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: true,
    supportsParallelToolCalls: true,
    maxOutputTokens: 8192,
    pricing: { in: 0.5, out: 1.5 },
    family: "glm",
  },
  kimi: {
    contextWindow: 256_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: false,
    supportsJsonMode: true,
    supportsParallelToolCalls: false,
    maxOutputTokens: 8192,
    pricing: { in: 0.6, out: 2.5 },
    family: "kimi",
  },
  minimax: {
    contextWindow: 245_000,
    supportsStreaming: true,
    // MiniMax abab models lack native tool calling; we degrade via a
    // JSON-mode prompt injection (see `toolFormat.toJsonModePromptInjection`).
    supportsTools: "json-mode",
    supportsVision: false,
    supportsJsonMode: true,
    supportsParallelToolCalls: false,
    maxOutputTokens: 8192,
    pricing: { in: 0.2, out: 0.8 },
    family: "minimax",
  },
  openai: {
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: true,
    supportsParallelToolCalls: true,
    maxOutputTokens: 16_384,
    pricing: { in: 0.15, out: 0.6 },
    family: "gpt",
  },
};

/** Lookup. Throws on unknown id so call sites get a fast, loud failure. */
export function getCapability(p: ProviderId): ProviderCapabilitySpec {
  const cap = CAPS[p];
  if (!cap) {
    throw new Error(`No capability entry for provider "${p}"`);
  }
  return cap;
}
