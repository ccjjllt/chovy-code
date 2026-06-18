/**
 * `src/swarm/` barrel — SwarmR (step-20).
 *
 * Public surface:
 *   - `dispatch()`        — the router entry point (the dispatch tool wraps it).
 *   - `swarmBus`          — module-level progress/lifecycle bus (UI subscribes).
 *   - helpers + types for tests / the step-22 Ink panel.
 *
 * Layering: `swarm/` is a *consumer* of `agent/` (step-18 pool) + `engine/`
 * (QueryEngine runs inside each child via the pool). It does not reach into
 * provider/tool internals — those stay encapsulated behind the pool's
 * `spawn()` which constructs a QueryEngine per child.
 *
 * Single-source rule (AGENTS.md §17): handle state + `subagent.*` telemetry
 * stay in `agent/pool.ts`. This module only *observes* handles (cost/phase)
 * and emits `swarm.dispatch` telemetry once per dispatch (the one event the
 * step-20 spec assigns to the router).
 */
export {
  dispatch,
  toAgentRole,
  MAX_DISPATCH_PROMPTS,
  DEFAULT_PARALLELISM,
  type DispatchInput,
  type DispatchPrompt,
  type DispatchOutput,
  type DispatchChildResult,
  type DispatchJudgeOptions,
  type DispatchRole,
  type JudgeSchemaName,
  type DispatchDeps,
} from "./router.js";

export {
  createLimiter,
  type ConcurrencyLimiter,
} from "./concurrency.js";

export {
  createGlobalBudget,
  type GlobalBudget,
  type BudgetStopReason,
} from "./budgets.js";

export {
  createSwarmBus,
  swarmBus,
  toLifecycleEvent,
  type SwarmBus,
  type SwarmProgressEvent,
  type SwarmLifecycleEvent,
} from "./progress.js";

export {
  createSwarmPool,
  type SwarmPool,
  type SwarmPoolOptions,
  type SwarmSpawnRequest,
} from "./pool.js";
