/**
 * SCW — Smart Context Window contracts (DRAFT).
 *
 * Canonical shapes are frozen in:
 *   - step-27 (monitor — token measurement + threshold transitions)
 *   - step-28 (rebuild — checkpoint+truncate protocol + budgeted injection)
 */

/**
 * Per-bucket token budget for context injection. Each request reserves a
 * fixed slice of the model's context window for these layers; the
 * remaining tokens host the active conversation tail.
 */
export interface ContextBudget {
  memory: number;
  checkpoint: number;
  notes: number;
  skills: number;
  /** Reserved for the conversation tail (most recent K messages). */
  tail: number;
}

/**
 * Snapshot of the live context, captured by the monitor (step-27). The
 * thresholds are derived from the active provider's `contextWindow`
 * (PCM; step-17) at request time.
 */
export interface ContextSnapshot {
  /** Current measured token usage of the message list. */
  tokens: number;
  /** Soft threshold (default 0.75 * model ctx). */
  softLimit: number;
  /** Hard threshold (default 0.9 * model ctx). Triggers rebuild. */
  hardLimit: number;
  /** Number of messages currently in window. */
  messages: number;
  /** ISO timestamp of last checkpoint write, if any. */
  lastCheckpointAt?: string;
}

/**
 * Per-round pressure hint injected into the dynamic suffix of the system
 * prompt when the SCW monitor (step-27) detects the conversation crossed
 * the soft or hard threshold. The model sees this as a `<context-pressure>`
 * XML block (`prompts/snippets.ts:pressureSection`) and should respond by
 * tightening its working set before the next round.
 *
 * Frozen at step-27. Extensions must add optional fields only.
 */
export interface ContextPressure {
  /** Pressure level — `'fresh'` is allowed for round-stable plumbing
   *  but `pressureSection` renders nothing for it (so the prompt stays
   *  unchanged below soft). */
  level: "fresh" | "soft" | "hard";
  /** Used percentage relative to the provider's full context window
   *  (0–100, integer). */
  usedPct: number;
  /** Remaining input headroom in tokens (post-reserve). */
  remainingTokens: number;
  /** True iff the monitor fired a `coordinator.maybeCheckpoint('token-soft')`
   *  on the round that pushed us into this pressure level. Used by the
   *  prompt block to tell the model "checkpoint already saved". */
  checkpointWritten: boolean;
}
