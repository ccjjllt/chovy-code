/**
 * Cost tracker (step-16).
 *
 * Tracks USD spend + token usage across a session. The price table is
 * intentionally minimal here — step-17 expands it into the PCM
 * (Provider Capability Matrix) and may inject per-model overrides.
 *
 * Design:
 *   - The tracker is an instance, not a global, so each `runAgent` call
 *     gets its own (or sub-agents bring their own per `architecture.md
 *     §3.3`).
 *   - `record()` is best-effort: an unknown model uses the provider's
 *     default rate; usage with no rate logs a warn but doesn't throw.
 *   - `total()` and `perModel()` are O(1) snapshots — no allocations.
 *
 * Telemetry: the tracker emits `agent.cost` events via the local sink so
 * `chovy log tail` can audit spend without adding a CLI subcommand.
 */

import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import { CAPS } from "../providers/capabilities.js";
import type { ProviderId } from "../types/provider.js";

export interface TokenUsage {
  in: number;
  out: number;
  /** Cached prompt tokens read (Anthropic / others); priced at the cache rate. */
  cacheRead?: number;
  /** Cache write tokens (priced at the write rate). */
  cacheWrite?: number;
}

/** Per-(provider, model) USD price table; values are USD per 1M tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Optional cache read price (typically 10% of input). */
  cacheReadPerMTok?: number;
  /** Optional cache write price (typically 25% over input). */
  cacheWritePerMTok?: number;
}

export interface PerModelStats {
  usd: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** Number of `record()` calls observed. */
  rounds: number;
}

export interface CostTotals {
  usd: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

// ---------------------------------------------------------------------------
// Default price book.
//
// Per-model overrides are sourced from public pricing as of 2026-06; values
// here are conservative defaults for popular SKUs each provider ships. When
// the model isn't in this table, we fall back to `PROVIDER_DEFAULTS` (which
// derives **structurally** from `providers/capabilities.ts` — PCM is the
// single source of truth per AGENTS.md §17 / step-17 §8).
// ---------------------------------------------------------------------------
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  // Anthropic
  "claude-sonnet-4-5": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4 },
  // Gemini
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 5 },
  "gemini-2.5-flash": { inputPerMTok: 0.075, outputPerMTok: 0.3 },
  // DeepSeek
  "deepseek-chat": { inputPerMTok: 0.27, outputPerMTok: 1.1 },
  "deepseek-reasoner": { inputPerMTok: 0.55, outputPerMTok: 2.19 },
  // GLM (Zhipu)
  "glm-4-plus": { inputPerMTok: 0.7, outputPerMTok: 0.7 },
  "glm-4.6": { inputPerMTok: 0.6, outputPerMTok: 2.2 },
  // Kimi (Moonshot)
  "moonshot-v1-32k": { inputPerMTok: 1.7, outputPerMTok: 1.7 },
  "moonshot-v1-128k": { inputPerMTok: 8.5, outputPerMTok: 8.5 },
  // MiniMax
  "abab6.5s-chat": { inputPerMTok: 0.28, outputPerMTok: 0.28 },
};

/**
 * Provider-level fallback price table — *derived from PCM* so a price
 * change in `providers/capabilities.ts` automatically ripples here. This
 * cements the "PCM is single source of truth" invariant promised by
 * step-17 §8 / AGENTS.md §17 (no more silent drift between PCM and the
 * cost tracker's hand-rolled defaults).
 */
const PROVIDER_DEFAULTS: Record<ProviderId, ModelPrice> = (() => {
  const out = {} as Record<ProviderId, ModelPrice>;
  for (const [id, cap] of Object.entries(CAPS) as Array<[ProviderId, (typeof CAPS)[ProviderId]]>) {
    out[id] = {
      inputPerMTok: cap.pricing.in,
      outputPerMTok: cap.pricing.out,
      ...(cap.pricing.cacheRead !== undefined
        ? { cacheReadPerMTok: cap.pricing.cacheRead }
        : {}),
      ...(cap.pricing.cacheWrite !== undefined
        ? { cacheWritePerMTok: cap.pricing.cacheWrite }
        : {}),
    };
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

export interface CostTrackerOptions {
  /** Override / extend the default price table (per-model). */
  prices?: Record<string, ModelPrice>;
  /** Agent id to tag in telemetry. */
  agentId?: string;
  /** Emit `agent.cost` telemetry on every `record()`. Default true. */
  telemetry?: boolean;
}

export class CostTracker {
  private prices: Record<string, ModelPrice>;
  private agentId: string | undefined;
  private telemetryEnabled: boolean;
  private byModel = new Map<string, PerModelStats>();
  private totals: CostTotals = {
    usd: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  /**
   * Cumulative spend across the entire engine run. Unlike `totals`, this
   * field is **never reset** by `splitSession()` (step-28 SCW rebuild
   * uses that to clear per-session telemetry while preserving the
   * absolute USD that the budget gate enforces). Production callers
   * read it via `cumulativeTotal()`.
   */
  private cumulative: CostTotals = {
    usd: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };

  constructor(opts: CostTrackerOptions = {}) {
    this.prices = { ...DEFAULT_PRICES, ...(opts.prices ?? {}) };
    this.agentId = opts.agentId;
    this.telemetryEnabled = opts.telemetry !== false;
  }

  /** Record one round's usage. Returns the marginal USD spent. */
  record(provider: ProviderId, model: string, usage: TokenUsage): number {
    const price = this.priceFor(provider, model);
    const tokensIn = usage.in ?? 0;
    const tokensOut = usage.out ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;

    const usd =
      (tokensIn * price.inputPerMTok) / 1_000_000 +
      (tokensOut * price.outputPerMTok) / 1_000_000 +
      (cacheRead * (price.cacheReadPerMTok ?? price.inputPerMTok * 0.1)) / 1_000_000 +
      (cacheWrite * (price.cacheWritePerMTok ?? price.inputPerMTok * 1.25)) / 1_000_000;

    const key = `${provider}:${model}`;
    const cur = this.byModel.get(key) ?? {
      usd: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      rounds: 0,
    };
    cur.usd += usd;
    cur.tokensIn += tokensIn;
    cur.tokensOut += tokensOut;
    cur.cacheRead += cacheRead;
    cur.cacheWrite += cacheWrite;
    cur.rounds += 1;
    this.byModel.set(key, cur);

    this.totals.usd += usd;
    this.totals.tokensIn += tokensIn;
    this.totals.tokensOut += tokensOut;
    this.totals.cacheRead += cacheRead;
    this.totals.cacheWrite += cacheWrite;

    // Cumulative bucket — survives `splitSession()` so the budget gate
    // (`cost.cumulativeTotal().usd >= budgetUSD`) still enforces the
    // absolute cap after a SCW rebuild (step-28).
    this.cumulative.usd += usd;
    this.cumulative.tokensIn += tokensIn;
    this.cumulative.tokensOut += tokensOut;
    this.cumulative.cacheRead += cacheRead;
    this.cumulative.cacheWrite += cacheWrite;

    if (this.telemetryEnabled) {
      emitTelemetry({
        type: "agent.cost",
        agentId: this.agentId ?? "main",
        provider,
        model,
        usd,
        tokensIn,
        tokensOut,
        cacheRead,
        cacheWrite,
      });
    }

    return usd;
  }

  total(): CostTotals {
    return { ...this.totals };
  }

  /**
   * Cumulative spend across the engine run, surviving `splitSession()`.
   * The QueryEngine budget gate uses this so an SCW rebuild can't reset
   * the budget back to zero (step-28 §重建后的副作用 line 95).
   */
  cumulativeTotal(): CostTotals {
    return { ...this.cumulative };
  }

  perModel(): Record<string, PerModelStats> {
    const out: Record<string, PerModelStats> = {};
    for (const [k, v] of this.byModel) out[k] = { ...v };
    return out;
  }

  reset(): void {
    this.byModel.clear();
    this.totals = {
      usd: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    this.cumulative = {
      usd: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  }

  /**
   * Reset the per-session counters but PRESERVE `cumulative` (step-28
   * §重建后的副作用). Called by the engine right after a SCW rebuild
   * so the next round's telemetry shows fresh numbers while the budget
   * gate still enforces the absolute USD cap.
   */
  splitSession(): void {
    this.byModel.clear();
    this.totals = {
      usd: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  }

  private priceFor(provider: ProviderId, model: string): ModelPrice {
    const exact = this.prices[model];
    if (exact) return exact;
    const fallback = PROVIDER_DEFAULTS[provider];
    if (!fallback) {
      logger.warn("CostTracker: no price for provider/model; using zero", {
        provider,
        model,
      });
      return { inputPerMTok: 0, outputPerMTok: 0 };
    }
    return fallback;
  }
}
