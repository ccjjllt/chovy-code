/**
 * Persistent memory contracts (TMT — Tiered Memory Tree; DRAFT).
 *
 * Canonical shapes are frozen in:
 *   - step-24 (memory store — bun:sqlite + FTS5 schema)
 *   - step-25 (cross-session injection + relevance ranker)
 *   - step-26 (checkpoint-writer agent)
 */

/** The four tiers of the memory tree. See `architecture.md §5`. */
export type MemoryLayer =
  | "project" // MEMORY.md — project-level facts shared with humans
  | "checkpoint" // checkpoints/*.md — structured session snapshots
  | "notes" // notes.md — agent-only scratchpad
  | "task"; // tasks/<id>/progress.md — per-task running log

/** Coarse classification used by the ranker (step-25) and UI filters. */
export type MemoryKind =
  | "fact"
  | "decision"
  | "todo"
  | "summary"
  | "log";

/**
 * A single record in the memory store. Persisted via `bun:sqlite` with an
 * FTS5 virtual table over `content` and `tags`.
 */
export interface MemoryRecord {
  id: string;
  layer: MemoryLayer;
  kind: MemoryKind;
  /** Free-form content; usually markdown. */
  content: string;
  /** Optional path-like scope, e.g. "projects/<hash(cwd)>". */
  scope?: string;
  /** Tags consumed by the FTS5 ranker (step-25). */
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  /** Cheap relevance hint (0..1) populated by the ranker; never persisted. */
  score?: number;
}

/** A query against the memory store (step-24/25). */
export interface MemoryQuery {
  /** Layers to search. Empty / undefined = all layers. */
  layers?: MemoryLayer[];
  /** Free-text query forwarded to FTS5 MATCH. */
  text?: string;
  /** Tag filters; AND-combined. */
  tags?: string[];
  /** Hard cap on returned rows. */
  limit?: number;
  /** Lower bound on `createdAt` (ms epoch). */
  since?: number;
}
