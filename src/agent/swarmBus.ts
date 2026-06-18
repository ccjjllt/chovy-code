/**
 * In-process pub/sub bus for sub-agent UI progress (step-22).
 *
 * The pool / lifecycle helpers emit coarse-grained events here so the Ink
 * SwarmPanel (and, after step-20 lands, the SwarmR router) can observe
 * live transitions without polling. This is a **UI-only** channel:
 *   - It is never persisted (contrast `telemetry/events.ts` `subagent.spawn`
 *     / `subagent.end`, which remain the pool's single-source telemetry).
 *   - It carries no message content — only ids + an event kind — so leaking
 *     it to a sink wouldn't reveal anything.
 *   - step-20's `swarmBus.on('progress' | 'lifecycle' | 'cost')` API (from
 *     `docs/step-20-swarm-router.md §进度上报`) maps 1:1 to `onSwarmEvent`;
 *     we pre-build the bus it specifies rather than inventing a new one.
 *
 * Design: a single module-level `Set<SwarmListener>`. Emitting is O(listeners)
 * and synchronous; listeners are expected to be cheap (the React store
 * throttles). Unsubscribe is the return value of `onSwarmEvent` so hooks can
 * pair subscribe/unsubscribe in one `useEffect` (acceptance: no leak).
 */

/** Coarse event kind. `lifecycle` = status transition; `progress` = phase /
 *  output advanced; `cost` = token/USD rolled up. The id is the sub-agent
 *  handle id (`sa_…`). */
export type SwarmEvent =
  | { type: "lifecycle"; id: string; status?: string }
  | { type: "progress"; id: string; phase?: string }
  | { type: "cost"; id: string };

export type SwarmListener = (e: SwarmEvent) => void;

const listeners = new Set<SwarmListener>();

/**
 * Subscribe to swarm events. Returns an unsubscribe function — callers MUST
 * invoke it on teardown (the React store does this in a `useEffect` cleanup).
 */
export function onSwarmEvent(cb: SwarmListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Broadcast an event to every subscriber. Safe to call from inside a
 * listener (the Set is iterated via a snapshot copy so mid-emit
 * subscribe/unsubscribe can't corrupt the loop).
 */
export function emitSwarmEvent(e: SwarmEvent): void {
  if (listeners.size === 0) return;
  // Snapshot: a listener may unsubscribe synchronously while we iterate
  // (e.g. a one-shot test handler). Mutating the live Set during iteration
  // is well-defined for `Set` but the snapshot is cheap and avoids surprises.
  for (const cb of [...listeners]) {
    try {
      cb(e);
    } catch {
      // A throwing UI listener must never break the pool / lifecycle path.
      // Swallow; the React layer logs its own errors.
    }
  }
}

/** Current subscriber count (test-only; used by the leak-assertion smoke). */
export function _swarmBusListenerCount(): number {
  return listeners.size;
}

/** Test-only: drop every subscriber. Production code MUST NOT call this. */
export function _resetSwarmBusForTesting(): void {
  listeners.clear();
}
