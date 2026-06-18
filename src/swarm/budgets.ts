/**
 * Global dispatch budget (step-20 SwarmR).
 *
 * Step-18 caps spend *per sub-agent*; SwarmR adds a *dispatch-wide* cap so a
 * 100-prompt fan-out can melt down on cost without melting the parent. The
 * budget watches cumulative `handle.costUSD` across all spawned children and
 * trips when it crosses `budgetUSD`, at which point the router cancels every
 * still-running child and returns `stopReason: 'budgetExceeded'`.
 *
 * Single-source: only the router constructs a `GlobalBudget` and only it
 * calls `trip()` / `check()`. Sub-agent cost telemetry stays single-source
 * in `engine/costTracker.ts` + `agent/pool.ts` — we merely *observe* handle
 * counters here rather than re-emitting `agent.cost`.
 *
 * The budget is consulted:
 *   1. before spawning each child (skip-spawn if already over),
 *   2. after each child settles (recompute from handle totals).
 *
 * When `budgetUSD` is undefined / non-finite the budget is inert (`exceeded`
 * stays false forever) — mirrors `QueryEngine`'s `Infinity` default.
 */
export type BudgetStopReason = "final" | "budgetExceeded" | "cancelled";

export interface GlobalBudget {
  /** Configured cap in USD; `undefined` ⇒ no cap. */
  readonly cap: number | undefined;
  /** True once cumulative spend has crossed the cap (sticky). */
  readonly exceeded: boolean;
  /** Cumulative spend observed so far (sum of settled child costUSD). */
  readonly spent: number;
  /** Mark the budget as exceeded. Idempotent. */
  trip(): void;
  /** Recompute `exceeded` from a caller-supplied cumulative total. */
  update(totalUSD: number): void;
  /** Reset for reuse (test-only). */
  reset(): void;
}

export function createGlobalBudget(budgetUSD?: number): GlobalBudget {
  const hasCap =
    typeof budgetUSD === "number" &&
    Number.isFinite(budgetUSD) &&
    budgetUSD > 0;
  const cap = hasCap ? (budgetUSD as number) : undefined;
  let exceeded = false;
  let spent = 0;

  return {
    get cap() {
      return cap;
    },
    get exceeded() {
      return exceeded;
    },
    get spent() {
      return spent;
    },
    trip() {
      exceeded = true;
    },
    update(totalUSD: number) {
      spent = totalUSD;
      if (cap !== undefined && totalUSD >= cap) exceeded = true;
    },
    reset() {
      exceeded = false;
      spent = 0;
    },
  };
}
