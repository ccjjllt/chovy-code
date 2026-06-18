/**
 * Public barrel for `src/context/` (step-27 §产物).
 *
 * Higher-level modules (engine, REPL, future step-28 rebuilder) import
 * from this barrel rather than cherry-picking individual files. Re-exports
 * follow the AGENTS.md §16 single-source pattern: types come from
 * `src/types/context.ts` (where `ContextBudget` / `ContextSnapshot` live),
 * runtime is in `monitor.ts` / `tokenizer.ts` / `thresholds.ts`.
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
