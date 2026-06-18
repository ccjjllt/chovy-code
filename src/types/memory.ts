/**
 * Persistent memory contracts (TMT — Tiered Memory Tree).
 *
 * **Frozen at step-24 (B4 屏障, architecture.md §3.3).** Subsequent steps
 * (25 injection / 26 checkpoint-writer / 27-28 SCW) extend this surface only
 * by *appending* optional fields — never renaming or replacing existing ones.
 *
 * Single-source rule (AGENTS.md §16/§17/§18 延续): the literal unions and
 * record shapes live HERE; `src/memory/types.ts` re-exports them so the
 * `memory` barrel stays self-contained without redeclaring the wire format.
 */

// ---------------------------------------------------------------------------
// Layer / Type — closed string-literal unions (no enums; tsconfig forbids them)
// ---------------------------------------------------------------------------

/**
 * The four tiers of the memory tree (architecture.md §5).
 *
 *   - `project`    — `MEMORY.md`, project-level facts shared with humans.
 *   - `checkpoint` — structured snapshots under `checkpoints/*.md` (step-26).
 *   - `notes`      — agent-only scratchpad `notes.md`.
 *   - `progress`   — per-task running log `tasks/<id>/progress.md`.
 */
export type MemoryLayer = "project" | "checkpoint" | "notes" | "progress";

/** All four layers as a runtime tuple (validators / CLI iteration). */
export const MEMORY_LAYERS: readonly MemoryLayer[] = [
  "project",
  "checkpoint",
  "notes",
  "progress",
] as const;

/**
 * Eight semantic record types. The taxonomy is intentionally a **superset** of
 * cc-haha's 4-type system (`user/feedback/project/reference`) so chovy-code
 * can capture richer signals (architectural decisions, coding rules, prefs)
 * without bloating the schema with per-type tables.
 */
export type MemoryType =
  | "decision"
  | "rule"
  | "fact"
  | "pref"
  | "snapshot"
  | "progress"
  | "note"
  | "reference";

/** All eight types as a runtime tuple (validators / CLI iteration). */
export const MEMORY_TYPES: readonly MemoryType[] = [
  "decision",
  "rule",
  "fact",
  "pref",
  "snapshot",
  "progress",
  "note",
  "reference",
] as const;

// ---------------------------------------------------------------------------
// Record + Query — wire shapes persisted via bun:sqlite (step-24 store.ts)
// ---------------------------------------------------------------------------

/**
 * A single record in the memory store. Persisted via `bun:sqlite` with an
 * FTS5 virtual table over `content` and `tags`.
 *
 * `id` — `'mem_' + base36(rand)` is the convention; the store generates ids
 *        when callers pass an empty string. Deterministic ids (used by file
 *        sync to dedupe across re-parses) are `'mem_' + sha1(sourcePath:line:content).slice(0,12)`.
 *
 * `importance` — 0..100 inclusive. The ranker (step-25) uses it as a static
 *        prior; values outside the range are clamped at upsert time.
 *
 * `tags` — always present (defaults to `[]` not `undefined`) so callers can
 *        do `record.tags.includes(...)` without a null guard. Persisted as
 *        JSON array text in SQL.
 *
 * `score` — runtime-only relevance hint set by `search()` when the ranker
 *        runs. Never persisted; absent on `list()` / `upsert` results.
 */
export interface MemoryRecord {
  id: string;
  projectId: string;
  layer: MemoryLayer;
  type: MemoryType;
  /** Source file path (relative or absolute) the record was parsed from. */
  sourcePath: string;
  /** 1-indexed line number inside `sourcePath` (when known). */
  sourceLine?: number;
  content: string;
  tags: string[];
  importance: number;
  createdAt: number;
  updatedAt: number;
  /** Runtime ranker output (0..1). NEVER persisted. */
  score?: number;
}

/** A query against the memory store (step-24 §API; step-25 reuses + extends). */
export interface MemoryQuery {
  /** FTS5 MATCH expression (chained with AND on layers/types/minImportance). */
  text?: string;
  /** Layers to include. Empty / undefined = all four layers. */
  layers?: MemoryLayer[];
  /** Types to include. Empty / undefined = all eight types. */
  types?: MemoryType[];
  /** Tag filters; AND-combined (every tag must be present in `record.tags`). */
  tags?: string[];
  /** Lower bound on `importance` (inclusive). */
  minImportance?: number;
  /** Lower bound on `createdAt` (ms epoch). */
  since?: number;
  /** Hard cap on returned rows. Default = 50. Hard ceiling = 1000. */
  limit?: number;
  /**
   * Ranker for the result ordering.
   *   - `bm25`  — pure FTS5 BM25 (default when `text` is set).
   *   - `mixed` — `weight = bm25 * 0.7 + recency * 0.3` (step-24 §API).
   * Ignored when `text` is empty (rows are sorted by `importance` DESC then
   * `updatedAt` DESC).
   */
  ranker?: "bm25" | "mixed";
}

// ---------------------------------------------------------------------------
// @deprecated — DRAFT shapes preserved for reviewer diff-safety. No in-tree
// consumers (grep verified at step-24); will be deleted at step-26 cleanup.
// ---------------------------------------------------------------------------

/** @deprecated step-24: replaced by {@link MemoryType}. */
export type MemoryKind = "fact" | "decision" | "todo" | "summary" | "log";
