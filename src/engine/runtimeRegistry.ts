/**
 * Engine runtime registry — sub-agent / SwarmR builder hooks (step-18 / step-20).
 *
 * The engine layer wants to call back into the agent + swarm layers (to spawn
 * sub-agents and to dispatch a swarm) but it must not statically import them
 * — that would cycle:
 *
 *   queryEngine.ts → swarm/router.ts → agent/runAgent.ts → queryEngine.ts
 *
 * Instead the agent / swarm layers register builder factories at module load
 * time (`agent/runAgent.ts` calls `setSpawnFnBuilder`; `agent/runAgent.ts`
 * also calls `setDispatchFnBuilder` after importing `swarm/router`). The
 * engine reads the builders via `getSpawnFnBuilder()` / `getDispatchFnBuilder()`
 * inside `run()` to construct a per-run `SpawnFn` / `dispatchSwarm` handle.
 *
 * Builders take a `ParentRuntimeCtx` rather than a `SpawnFn` directly because
 * they must close over the *live* messages array reference the engine owns —
 * a value-only `SpawnFn` would freeze the snapshot at registration time.
 *
 * AGENTS.md §17 single-source: this is the **only** module owning the
 * registration shim. `queryEngine.ts` re-exports the setters via the engine
 * barrel so callers continue to use the same API surface (back-compat).
 */
import type {
  ParentRuntimeCtx,
  SpawnFn,
  ToolContext,
} from "../types/index.js";

// ── spawn builder (step-18) ────────────────────────────────────────────────

/**
 * Builder: given a parent runtime context (with a *live* messages array
 * reference), return a `SpawnFn` the harness can attach to `ToolContext`.
 */
export type SpawnFnBuilder = (parentCtx: ParentRuntimeCtx) => SpawnFn;

let spawnFnBuilder: SpawnFnBuilder | null = null;

/**
 * Register the sub-agent spawn factory. Called once at import time by
 * `src/agent/index.ts`. Passing `null` clears the registration (test-only).
 */
export function setSpawnFnBuilder(builder: SpawnFnBuilder | null): void {
  spawnFnBuilder = builder;
}

/** Engine-internal accessor — reads the latest registration, may be `null`. */
export function getSpawnFnBuilder(): SpawnFnBuilder | null {
  return spawnFnBuilder;
}

// ── dispatch builder (step-20 SwarmR) ──────────────────────────────────────

/**
 * Builder: given a parent runtime context, return a `dispatchSwarm` handle
 * bound to it. The handle closes over the parent's live message array +
 * abort signal so a dispatch inherits the parent snapshot and cascades
 * cancellation the same way a single spawn does.
 */
export type DispatchFnBuilder = (
  parentCtx: ParentRuntimeCtx,
) => ToolContext["dispatchSwarm"];

let dispatchFnBuilder: DispatchFnBuilder | null = null;

/**
 * Register the SwarmR dispatch factory (step-20). Called once at import
 * time by `src/swarm/index.ts` wiring (mirrors `setSpawnFnBuilder`). The
 * engine never imports the swarm module directly — doing so would create a
 * cycle (engine → swarm → agent → engine), so the registration indirection
 * keeps the dependency graph acyclic.
 *
 * Passing `null` clears the registration (test-only).
 */
export function setDispatchFnBuilder(builder: DispatchFnBuilder | null): void {
  dispatchFnBuilder = builder;
}

/** Engine-internal accessor — reads the latest registration, may be `null`. */
export function getDispatchFnBuilder(): DispatchFnBuilder | null {
  return dispatchFnBuilder;
}
