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
