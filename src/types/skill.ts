/**
 * CSG — Conditional Skill Graph contracts (DRAFT).
 *
 * Canonical shape is frozen in step-29. Skills form a DAG where edges are
 * declared as `requires` (incoming) / `provides` (outgoing capability
 * tokens). The Skill Planner (step-29) walks this graph to inject the
 * minimum viable subset given the current user intent.
 */

/** A single skill definition. Loaded from `~/.chovy/skills/*` or bundled. */
export interface Skill {
  /** Stable id. Used as both filename slug and graph node key. */
  id: string;
  /** Human-readable description; shown in `chovy skill list`. */
  description: string;
  /** Skill ids this skill depends on (incoming graph edges). */
  requires?: string[];
  /** Capability tokens this skill exposes once activated. */
  provides?: string[];
  /** Match heuristic for the planner. */
  match?: {
    keywords?: string[];
    /** Stored as a string so this file stays runtime-free. */
    regex?: string;
    /** When true, the skill is only ever activated by explicit user opt-in. */
    manual?: boolean;
  };
  /** Body merged into the system prompt when the skill is active. */
  body: string;
  /** Approximate token cost — used by `ContextBudget` accounting. */
  approxTokens?: number;
}

/**
 * A node in the resolved planning graph (step-29). The planner builds a
 * graph of these from the registered `Skill[]`, then prunes by score.
 */
export interface SkillNode {
  skill: Skill;
  /** Parents that pulled this skill in. Empty for root nodes. */
  parents: string[];
  /** Children pulled in transitively by this skill. */
  children: string[];
  /** Activation score from the planner (0..1). */
  score: number;
}
