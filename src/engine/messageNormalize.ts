/**
 * Per-provider message normalization (step-16).
 *
 * Different providers want different shapes:
 *   - OpenAI: a flat `messages` array, with `tool_calls` on assistant turns
 *     and `role: "tool"` carrying `tool_call_id`.
 *   - Anthropic: assistant `content` is an array of blocks
 *     (`text` / `tool_use` / `thinking`); tool results live in user-turn
 *     `tool_result` blocks.
 *   - Gemini: parts-array; tool calls are `functionCall` blocks; thinking
 *     is suppressed unless explicitly enabled.
 *   - GLM / DeepSeek / Kimi / MiniMax: OpenAI-compatible with quirks.
 *
 * Step-17 owns the actual wire-format adapters (each provider does its own
 * mapping inside `complete` / `stream`). What this module supplies is a
 * **provider-neutral preprocessing pass** the QueryEngine can run *before*
 * handing messages to a provider:
 *   - drop empty assistant turns left over from cancellation;
 *   - merge consecutive system messages;
 *   - clip ultra-long tool outputs to a configurable byte cap;
 *   - strip `reasoning` from messages destined for providers that don't
 *     accept thinking blocks (capability-driven; falls back to the
 *     conservative "strip" when no PCM entry is present).
 *
 * The normalization is intentionally **idempotent** — running it twice
 * produces the same output. Tests in step-17 will pin specific transforms.
 */

import type { ChatMessage } from "../types/messages.js";
import type { ProviderId } from "../types/provider.js";

const DEFAULT_TOOL_OUTPUT_CAP_BYTES = 16 * 1024;

export interface NormalizeOptions {
  provider: ProviderId;
  /** Cap on a single tool message's `content` length (chars). */
  toolOutputCapBytes?: number;
  /** Force-strip `reasoning` even if the provider would accept it. */
  stripReasoning?: boolean;
}

/**
 * Normalize an incoming `ChatMessage[]` for a target provider. Pure;
 * returns a new array (does not mutate inputs).
 */
export function normalizeForProvider(
  messages: ChatMessage[],
  opts: NormalizeOptions,
): ChatMessage[] {
  const cap = opts.toolOutputCapBytes ?? DEFAULT_TOOL_OUTPUT_CAP_BYTES;
  const stripReasoning = opts.stripReasoning ?? !providerAcceptsReasoning(opts.provider);

  const out: ChatMessage[] = [];
  for (const m of messages) {
    // Drop empty assistant ghosts (no content + no tool calls). They show up
    // when a previous round was cancelled mid-stream.
    if (
      m.role === "assistant" &&
      (!m.content || !m.content.trim()) &&
      (!m.toolCalls || m.toolCalls.length === 0)
    ) {
      continue;
    }

    let next: ChatMessage = m;

    // Clip oversized tool outputs. cc-haha caps at ~25k tokens; we cap at
    // 16 KB chars (~4k tokens) to leave headroom for many tool turns.
    if (m.role === "tool" && m.content && m.content.length > cap) {
      next = {
        ...m,
        content: m.content.slice(0, cap) + `\n…(tool output truncated; ${m.content.length - cap} bytes elided)`,
      };
    }

    // Strip reasoning when the provider doesn't accept it (or caller forces).
    if (stripReasoning && next.reasoning) {
      const { reasoning: _drop, ...rest } = next;
      void _drop;
      next = rest as ChatMessage;
    }

    out.push(next);
  }

  // Merge consecutive same-role system messages (rare but cheap).
  return mergeAdjacentSystem(out);
}

function mergeAdjacentSystem(msgs: ChatMessage[]): ChatMessage[] {
  if (msgs.length <= 1) return msgs;
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === "system" && m.role === "system") {
      out[out.length - 1] = {
        ...last,
        content: `${last.content}\n${m.content}`,
      };
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * Whether the target provider can ingest `reasoning` blocks today.
 * Conservative defaults — only providers with documented thinking support
 * pass through. PCM in step-17 may flip more switches.
 */
function providerAcceptsReasoning(provider: ProviderId): boolean {
  switch (provider) {
    case "anthropic":
      return true;
    case "openai":
      return true; // o-series silently swallow if not requested
    case "gemini":
      return true;
    default:
      // DeepSeek / GLM / Kimi / MiniMax — strip until step-17 verifies.
      return false;
  }
}

/**
 * Strip an entire run of consecutive `tool` messages that follow an empty
 * (cancelled) assistant message. Useful when retrying after a cancel:
 * keeping orphan tool replies confuses providers that require pairing.
 */
export function pruneOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let lastAssistantHadCalls = false;
  for (const m of messages) {
    if (m.role === "assistant") {
      lastAssistantHadCalls = (m.toolCalls?.length ?? 0) > 0;
      out.push(m);
      continue;
    }
    if (m.role === "tool" && !lastAssistantHadCalls) {
      // orphan — drop
      continue;
    }
    out.push(m);
  }
  return out;
}
