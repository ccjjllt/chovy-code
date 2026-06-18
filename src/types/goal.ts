/**
 * /goal long-running task contracts (DRAFT).
 *
 * Canonical shape is frozen in step-23. Goal state mutates round-by-round
 * via the Stop hook (step-13) and the convergence checker (step-23).
 */
import type { SubAgentHandle } from "./agent.js";

/** Phases of a `/goal` run. See `architecture.md §4.3`. */
export type GoalPhase =
  | "set" // user just issued /goal "<objective>"
  | "running" // agent loop is iterating
  | "stop-hook" // checking convergence
  | "converged" // criteria met → finish
  | "diverged" // criteria failing repeatedly or budget blown
  | "cancelled" // user cancelled
  | "max-rounds"; // bumped up against `maxRounds` cap

/** Predicate that decides whether the goal is met. */
export interface ConvergenceCriteria {
  /** Human-readable rubric. Shown in UI; passed to judge in step-21. */
  rubric: string;
  /** Optional shell command whose exit code 0 == converged. */
  command?: string;
  /**
   * Optional structured matcher. The judge model (step-21) returns JSON
   * matching this schema; we declare it untyped here to avoid pulling
   * `zod` into the type layer.
   */
  judgeSchema?: Record<string, unknown>;
}

/** The persisted state of a `/goal` run. */
export interface GoalState {
  id: string;
  objective: string;
  phase: GoalPhase;
  round: number;
  maxRounds: number;
  /**
   * USD budget cap. Going over flips `phase` to `"diverged"` and surfaces
   * `ErrorCode = "AGENT_BUDGET_EXCEEDED"`.
   */
  budgetUSD: number;
  costUSD: number;
  startedAt: number;
  finishedAt?: number;
  criteria: ConvergenceCriteria;
  /** Sub-agents spawned during this goal run (step-20). */
  spawned: SubAgentHandle[];
}
