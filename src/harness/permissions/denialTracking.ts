/**
 * Denial tracking — the permission engine's circuit breaker (step-12).
 *
 * Direct port of cc-haha's 46-line `denialTracking.ts` (see step-12 参考源).
 * Tracks consecutive and total permission denials; when either limit is hit
 * the `auto` permission mode is force-downgraded to `default` for the
 * remainder of the session so a runaway agent can't keep silently failing.
 *
 * Pure functions on a plain state object — no I/O, no globals. The engine
 * (`./engine.ts`) owns the live `DenialState` instance; tests can construct
 * one directly.
 */

/**
 * Hard limits. Reaching *either* threshold trips the breaker.
 *
 * - `maxConsecutive: 3` — three denials in a row ⇒ the agent is clearly
 *   trying something the user keeps refusing; stop auto-approving.
 * - `maxTotal: 20` — a session-wide ceiling so a slow drip of denials can't
 *   run indefinitely under `auto`.
 */
export const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20,
} as const;

export interface DenialState {
  consecutiveDenials: number;
  totalDenials: number;
}

/** Fresh state — zero denials. */
export function createDenialState(): DenialState {
  return { consecutiveDenials: 0, totalDenials: 0 };
}

/**
 * Record one denial. Bumps both counters. Returns a *new* object so callers
 * can treat state immutably (mirrors cc-haha's spread style).
 */
export function recordDenial(state: DenialState): DenialState {
  return {
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
  };
}

/**
 * Record a success. Only resets the *consecutive* counter — the total still
 * accrues over the session so a flaky "succeed, fail, succeed, fail" pattern
 * still trips the total limit. No-op when consecutive is already 0 (avoids
 * needless allocation churn on the hot read-only path).
 */
export function recordSuccess(state: DenialState): DenialState {
  if (state.consecutiveDenials === 0) return state;
  return { ...state, consecutiveDenials: 0 };
}

/**
 * True when the breaker should fire — i.e. `auto` mode must fall back to
 * `default` for the rest of the session.
 */
export function shouldFallbackToPrompting(state: DenialState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  );
}
