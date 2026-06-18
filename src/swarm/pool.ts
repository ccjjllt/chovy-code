/**
 * Swarm pool wrapper (step-20 SwarmR).
 *
 * Step-18's `SubAgentPool` is the single owner of handles + `subagent.*`
 * telemetry. SwarmR does NOT re-implement spawning — it wraps the pool so
 * the router can:
 *   - broadcast progress / lifecycle events on the swarm bus,
 *   - assert the "prompts + currentRunning ≤ MAX" capacity check from
 *     `docs/step-20 §算法` *before* handing the spawn to the pool (the pool
 *     already enforces the 100-active cap, but a pre-check gives the router
 *     a chance to skip-spawn cleanly under budget pressure rather than
 *     throwing `AGENT_BUDGET_EXCEEDED` mid-dispatch),
 *   - poll handle cost/phase for the budget watchdog + progress bus.
 *
 * The wrapper holds no handle state of its own — every query delegates to
 * the underlying pool. This keeps the single-source rule intact: handles
 * live in exactly one `Map` (the pool's).
 */
// Import the pool directly from `agent/pool.js` (NOT the `agent/index.js`
// barrel). The barrel re-exports `runAgent`, which imports `engine/`, which
// — once SwarmR wiring lands in `runAgent.ts` — would import `swarm/router`.
// Reaching the leaf module keeps the dependency graph acyclic:
// swarm/pool → agent/pool (leaf, no runAgent) rather than
// swarm/pool → agent/index → runAgent → engine → swarm/router → swarm/pool.
import { getSubAgentPool, MAX_SUB_AGENTS } from "../agent/pool.js";
import type { SubAgentPool } from "../agent/pool.js";
import type {
  ParentRuntimeCtx,
  SpawnInput,
  SubAgentHandle,
} from "../types/index.js";
import type { SwarmBus } from "./progress.js";

export interface SwarmPoolOptions {
  /** Underlying pool; defaults to the module singleton. */
  pool?: SubAgentPool;
  /** Bus to broadcast lifecycle events on. */
  bus: SwarmBus;
}

export interface SwarmSpawnRequest {
  /** Caller-assigned id (stable across the dispatch result array). */
  id: string;
  /** Spawn input minus `parentCtx` (the wrapper injects it). */
  input: SpawnInput;
  /** Parent runtime context (provided by the router). */
  parentCtx: ParentRuntimeCtx;
}

export interface SwarmPool {
  /** Active (non-terminal) sub-agent count in the underlying pool. */
  activeCount(): number;
  /** Remaining spawn headroom against the 100-handle hard cap. */
  headroom(): number;
  /** True iff `prompts.length` more spawns would fit under the cap. */
  canFit(prompts: number): boolean;
  /** Spawn + wire bus lifecycle events. Returns the settled handle. */
  spawn(req: SwarmSpawnRequest): Promise<SubAgentHandle>;
  /** Cancel every active handle (used on budget / dispatch cancellation). */
  cancelAll(): Promise<void>;
  /** Read-only handle lookup (router polls cost/phase from this). */
  get(id: string): SubAgentHandle | undefined;
}

export function createSwarmPool(opts: SwarmPoolOptions): SwarmPool {
  const pool = opts.pool ?? getSubAgentPool();
  const bus = opts.bus;

  return {
    activeCount() {
      return pool.activeCount();
    },
    headroom() {
      return Math.max(0, MAX_SUB_AGENTS - pool.activeCount());
    },
    canFit(prompts) {
      return prompts > 0 && pool.activeCount() + prompts <= MAX_SUB_AGENTS;
    },

    async spawn(req) {
      const handle = await pool.spawn(req.input, {
        parentCtx: req.parentCtx,
      });
      // Emit the initial lifecycle event so the UI sees the handle appear
      // even before the pool flips it to `running`. Subsequent transitions
      // are observed by the router's poll loop (cheaper than wiring a per-
      // handle listener into the pool's internal setStatus path).
      bus.emitLifecycle({ id: handle.id, status: handle.status, costUSD: handle.costUSD });
      return handle;
    },

    cancelAll() {
      return pool.cancelAll();
    },

    get(id) {
      return pool.get(id);
    },
  };
}
