/**
 * `/goal` long-running task contracts (frozen at step-23).
 *
 * Single source for every goal-loop type — `src/goals/*` re-export the
 * structural types they need from here, and the CLI / REPL / GoalPanel
 * import the *type* via the barrel (`@chovy/types`-style).
 *
 * Design notes (AGENTS.md §17/§18 single-source pattern):
 *   - `GoalStatus` is the canonical 5-state machine; the older draft had
 *     `GoalPhase` (`set`/`running`/`stop-hook`/...) which never shipped —
 *     no consumer references it (verified via grep). Replaced wholesale.
 *   - `ConvergenceMode` is a discriminated union (`mode` field) so callers
 *     can switch on a single tag instead of probing optional fields.
 *   - The persisted JSON layout matches `GoalState` exactly: writes go
 *     through `safeFs.write` (atomic). We do NOT version the file — if
 *     fields are added later they MUST be optional so old states load.
 */
import type { ProviderId } from "./provider.js";
import type { SubAgentHandle } from "./agent.js";

/** The 5-state goal lifecycle (step-23 §数据结构). */
export type GoalStatus =
  | "active" // loop running
  | "paused" // user paused / death-spiral guard tripped
  | "achieved" // convergence ok
  | "failed" // budget / max-rounds / unrecoverable error
  | "cancelled"; // external abort signal

/**
 * Convergence judge configuration (step-23 §收敛判据).
 * Discriminated union so callers branch on `mode`.
 */
export type ConvergenceMode =
  | { mode: "rubric"; rubric: string }
  | {
      mode: "command";
      cmd: string;
      /** Exit code that signals "achieved". Defaults to 0. */
      expectedExitCode?: number;
    }
  | {
      mode: "hybrid";
      rubric: string;
      cmd: string;
      expectedExitCode?: number;
    };

/** A single round's record in `GoalState.history`. */
export interface GoalHistoryEntry {
  round: number;
  /** Short summary of what the round produced (last assistant content snippet). */
  summary: string;
  /** Did the convergence judge agree at this round? */
  converged: boolean;
  /** USD cost of this round (engine + rubric judge if any). */
  cost: number;
  /** Failure reasons from the convergence judge (when `converged === false`). */
  reasons?: string[];
  ts: number;
}

/**
 * The persisted state of a `/goal` run (step-23 §数据结构 — frozen).
 *
 * `~/.chovy/projects/<id>/goals/<goal-id>.json` is the source of truth —
 * an in-memory `Map<threadId, GoalState>` mirrors it for the active REPL
 * session, but `chovy goal` (headless) and crash-recovery only need the
 * file. All field names match the spec verbatim.
 */
export interface GoalState {
  id: string;
  threadId: string;
  objective: string;
  /** Optional human-supplied rubric overlay (e.g. via `/goal --rubric "..."`). */
  rubric?: string;
  /** Resolved convergence mode (auto-inferred at /goal time; never undefined). */
  convergence: ConvergenceMode;
  createdAt: number;
  updatedAt: number;
  rounds: number;
  /** Hard cap; default 25 (step-23 §单轮迭代). */
  maxRounds: number;
  status: GoalStatus;
  history: GoalHistoryEntry[];
  /** USD budget cap; default 5 (step-23 §数据结构). */
  budgetUSD: number;
  totalCostUSD: number;
  /**
   * Death-spiral guard counter (step-23 §风险): consecutive rounds with no
   * fs-mutate tool calls. When this hits 5 we flip status='paused'.
   */
  noProgressRounds: number;
  /** Caller override for the rubric judge provider (defaults to parent). */
  rubricProvider?: ProviderId;
  rubricModel?: string;
  /** Wall-clock end time (set on terminal status). */
  finishedAt?: number;
}

// ── Legacy aliases ──────────────────────────────────────────────────────────
//
// Earlier drafts (step-01) referenced `GoalPhase` / `ConvergenceCriteria`.
// They never shipped (no in-tree consumer); kept as deprecated re-exports
// for one cycle so any uncommitted experimental code keeps compiling. The
// barrel exports them via `export *`; new code MUST use `GoalStatus` /
// `ConvergenceMode`.

/** @deprecated step-23: use `GoalStatus`. */
export type GoalPhase =
  | "set"
  | "running"
  | "stop-hook"
  | "converged"
  | "diverged"
  | "cancelled"
  | "max-rounds";

/** @deprecated step-23: use `ConvergenceMode`. */
export interface ConvergenceCriteria {
  rubric: string;
  command?: string;
  judgeSchema?: Record<string, unknown>;
}

// ── Spawned-agent bookkeeping (additive) ────────────────────────────────────
//
// step-23 keeps the old "list of sub-agent handles" idea as a read-only
// view callers can derive on demand from the live pool — we do NOT persist
// SubAgentHandle in the JSON (handles are per-process). The optional
// helper field is retained for the GoalPanel which slices it for display.

/** Live sub-agent handles spawned during this goal run (UI-only, not persisted). */
export interface GoalRuntime {
  /** A view into the pool, filtered to this goal's session. */
  spawned(): readonly SubAgentHandle[];
}
