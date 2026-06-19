/**
 * Public barrel for `src/context/` (step-27 §产物 + step-28 §产物).
 *
 * Higher-level modules (engine, REPL, future SCG step-29) import from
 * this barrel rather than cherry-picking individual files. Re-exports
 * follow the AGENTS.md §16 single-source pattern: types come from
 * `src/types/context.ts` (where `ContextBudget` / `ContextSnapshot` live),
 * runtime is in `monitor.ts` / `tokenizer.ts` / `thresholds.ts` /
 * `budgets.ts` / `rebuilder.ts` / `selectors/*.ts`.
 */

export {
  createContextMonitor,
  _internalsForTesting,
  type ContextMonitor,
  type ContextMonitorDeps,
  type ContextLevel,
  type MonitorState,
  type Unsubscribe,
} from "./monitor.js";

export {
  thresholds,
  type ContextThresholds,
} from "./thresholds.js";

export {
  defaultEstimator,
  pickEstimator,
  CHARS_PER_TOKEN,
  ESTIMATE_SAFETY,
  PER_MESSAGE_OVERHEAD_TOKENS,
  type TokenEstimator,
} from "./tokenizer.js";

// step-28: budget computation + selectors + rebuilder.
export {
  computeBudget,
  budgetTotal,
  DEFAULT_SLABS,
} from "./budgets.js";

export {
  rebuildContext,
  type RebuildContextInput,
  type RebuildContextResult,
} from "./rebuilder.js";

export {
  recentMessagesPick,
  type RecentPickOptions,
  type RecentPickResult,
} from "./selectors/recentMessages.js";

export {
  checkpointPick,
  type CheckpointPickResult,
} from "./selectors/checkpointPick.js";

export {
  progressPick,
  type ProgressPickResult,
} from "./selectors/progressPick.js";

export {
  memoryPick,
  type MemoryPickInput,
  type MemoryPickResult,
} from "./selectors/memoryPick.js";

// Type-only re-export for the rebuilder's bucket interface (single-source
// in `types/context.ts`). Callers that only need the type should import
// from `@chovy/types` directly; this re-export is for callers already
// reaching into the context barrel.
export type { ContextBudget } from "../types/context.js";
