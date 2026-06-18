/**
 * Swarm progress bus (step-20 SwarmR).
 *
 * A tiny typed pub/sub so the router can broadcast sub-agent lifecycle + per-
 * round progress events to subscribers. The Ink panel (step-22) subscribes
 * to render the live swarm grid; the smoke harness subscribes to assert
 * ordering. There is no IPC — the bus is in-process only and wiped when the
 * process exits (mirrors the step-18 pool's no-persistence stance).
 *
 * Events are deliberately coarser than the pool's `subagent.spawn` /
 * `subagent.end` telemetry: those carry bookkeeping; these carry the
 * user-facing phase + token rollups the UI needs. Telemetry stays single-
 * source in `agent/pool.ts` (AGENTS.md §17); this bus is a *consumer* of
 * handle state, not a second emitter of telemetry.
 *
 * Event channels:
 *   - `progress`  — a child advanced its phase or produced more output tokens.
 *   - `lifecycle` — a child transitioned between AgentStatus values.
 *
 * Subscribers receive their own copy of the payload (shallow spread) so a
 * misbehaving listener can't mutate the router's live handle snapshot.
 */
import type { AgentLifecycle, SubAgentHandle } from "../types/index.js";

export interface SwarmProgressEvent {
  id: string;
  /** Free-form phase label, e.g. "reading src/engine/". */
  phase: string;
  /** Output tokens produced so far by this child. */
  tokensOut: number;
}

export interface SwarmLifecycleEvent {
  id: string;
  /** New lifecycle status (queued / running / done / failed / cancelled / paused). */
  status: AgentLifecycle;
  /** Cumulative USD spent by this child at the moment of the transition. */
  costUSD: number;
}

type ProgressListener = (e: SwarmProgressEvent) => void;
type LifecycleListener = (e: SwarmLifecycleEvent) => void;

export interface SwarmBus {
  on(channel: "progress", fn: ProgressListener): () => void;
  on(channel: "lifecycle", fn: LifecycleListener): () => void;
  off(channel: "progress", fn: ProgressListener): void;
  off(channel: "lifecycle", fn: LifecycleListener): void;
  /** Emit a progress event. Returns the number of listeners notified. */
  emitProgress(e: SwarmProgressEvent): number;
  /** Emit a lifecycle event. Returns the number of listeners notified. */
  emitLifecycle(e: SwarmLifecycleEvent): number;
  /** Drop every listener (test-only). */
  clear(): void;
}

export function createSwarmBus(): SwarmBus {
  const progressListeners = new Set<ProgressListener>();
  const lifecycleListeners = new Set<LifecycleListener>();

  return {
    on(channel, fn) {
      if (channel === "progress") {
        const f = fn as ProgressListener;
        progressListeners.add(f);
        return () => progressListeners.delete(f);
      }
      const f = fn as LifecycleListener;
      lifecycleListeners.add(f);
      return () => lifecycleListeners.delete(f);
    },
    off(channel, fn) {
      if (channel === "progress") {
        progressListeners.delete(fn as ProgressListener);
      } else {
        lifecycleListeners.delete(fn as LifecycleListener);
      }
    },
    emitProgress(e) {
      for (const fn of progressListeners) {
        try {
          fn({ ...e });
        } catch {
          /* a subscriber fault must not break the dispatch */
        }
      }
      return progressListeners.size;
    },
    emitLifecycle(e) {
      for (const fn of lifecycleListeners) {
        try {
          fn({ ...e });
        } catch {
          /* a subscriber fault must not break the dispatch */
        }
      }
      return lifecycleListeners.size;
    },
    clear() {
      progressListeners.clear();
      lifecycleListeners.clear();
    },
  };
}

/**
 * Module-level default bus. The router uses this; the UI (step-22) will
 * import `swarmBus` directly. Tests that need isolation construct their own
 * via `createSwarmBus()` and pass it to `dispatch()`.
 */
export const swarmBus: SwarmBus = createSwarmBus();

/**
 * Read-only projection of a `SubAgentHandle` into the lifecycle event the
 * bus carries. Kept here (rather than on the handle) so the handle type
 * stays free of bus-coupled helpers.
 */
export function toLifecycleEvent(h: SubAgentHandle): SwarmLifecycleEvent {
  return { id: h.id, status: h.status, costUSD: h.costUSD };
}
