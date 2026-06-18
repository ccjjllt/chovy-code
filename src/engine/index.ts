/**
 * `src/engine/` barrel — public surface of the QueryEngine (step-16).
 *
 * Consumers (current + planned):
 *   - `src/agent/runAgent.ts` (back-compat shim)
 *   - sub-agent runtime (step-18) — spawns sub-engines per child agent
 *   - swarm router (step-20) — fan-out via parallel engine instances
 *   - `/goal` loop (step-23) — repeatedly runs a single engine until
 *     convergence
 *
 * Tests reach the building blocks via this barrel; production callers
 * should use `runAgent` (the convenience entry) unless they need engine
 * internals (sub-agents, swarm).
 */

export {
  QueryEngine,
  type QueryEngineDeps,
  type QueryRunOptions,
  type QueryRunResult,
  type StopReason,
} from "./queryEngine.js";

export {
  CostTracker,
  type CostTotals,
  type CostTrackerOptions,
  type ModelPrice,
  type PerModelStats,
  type TokenUsage,
} from "./costTracker.js";

export {
  normalizeForProvider,
  pruneOrphanToolMessages,
  type NormalizeOptions,
} from "./messageNormalize.js";

export {
  runStream,
  type StreamHandlerOptions,
  type StreamOutcome,
} from "./streamHandler.js";
