/**
 * React adapter for the swarmBus (step-22).
 *
 * `useSwarmState()` subscribes to `onSwarmEvent` and exposes a throttled
 * snapshot of `{ agents, budget }` for the `<SwarmPanel>` / `<HeaderBar>`.
 *
 * Throttling (spec §性能 "progress 事件经 16ms 节流"): bursty progress/cost
 * events from 100 concurrent sub-agents are coalesced into one `setState`
 * per ~16ms frame. Without this, Ink re-renders on every token delta and
 * the terminal can't keep up. We use a dirty-flag + `setTimeout(flush, 16)`
 * pattern: the first event after a flush schedules a flush; subsequent
 * events just re-mark dirty (already-scheduled flush will pick them up).
 *
 * Subscribe/unsubscribe pairing (acceptance: "终止时无内存泄漏"): the
 * `useEffect` returns the `off` callback from `onSwarmEvent`, so React
 * tears down the listener on unmount. The timer is cleared in the same
 * cleanup. The smoke test asserts the listener count returns to baseline.
 *
 * Why poll `pool.list()` on flush rather than threading handles through the
 * bus: the bus carries only ids + event kinds (UI-only, no content — see
 * `swarmBus.ts`). The pool is the single owner of live `SubAgentHandle`
 * objects; re-reading `pool.list()` on each flush gives us fresh
 * references with current `status / phase / costUSD / tokens*` without
 * duplicating that state in the bus payload.
 */
import { useEffect, useRef, useState } from "react";
import { getSubAgentPool } from "../../agent/index.js";
import { onSwarmEvent } from "../../agent/swarmBus.js";
import type { SubAgentHandle } from "../../types/index.js";
import type { BudgetSnapshot } from "../components/HeaderBar.js";

export interface SwarmState {
  agents: SubAgentHandle[];
  /** Aggregate spend across all handles (running + done). */
  budget: BudgetSnapshot;
}

const THROTTLE_MS = 16;

/** Empty-state constant so callers can reference a stable zero snapshot. */
export const EMPTY_SWARM_STATE: SwarmState = {
  agents: [],
  budget: { costUSD: 0, ctxUsedTokens: 0, ctxTotalTokens: 0 },
};

function snapshot(): SwarmState {
  const pool = getSubAgentPool();
  const agents = pool.list();
  // Aggregate USD across every handle (the panel shows total swarm spend).
  let costUSD = 0;
  for (const a of agents) costUSD += a.costUSD ?? 0;
  return {
    agents,
    // ctxUsedTokens / ctxTotalTokens remain 0 until step-27 (SCW monitor);
    // costUSD is live from step-18's handle.costUSD (rolled up by the pool).
    budget: { costUSD, ctxUsedTokens: 0, ctxTotalTokens: 0 },
  };
}

/**
 * Subscribe to swarm events and return a throttled `{ agents, budget }`
 * snapshot. Re-renders at most once per ~16ms regardless of event volume.
 * Returns `EMPTY_SWARM_STATE` when the pool is empty (panel auto-collapses).
 */
export function useSwarmState(): SwarmState {
  const [state, setState] = useState<SwarmState>(EMPTY_SWARM_STATE);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Initial pull so the panel reflects handles that existed before mount.
    setState(snapshot());

    const flush = (): void => {
      dirtyRef.current = false;
      timerRef.current = null;
      setState(snapshot());
    };

    const schedule = (): void => {
      dirtyRef.current = true;
      if (timerRef.current !== null) return; // already scheduled
      timerRef.current = setTimeout(flush, THROTTLE_MS);
    };

    // Any event kind (lifecycle / progress / cost) just marks dirty and
    // schedules a flush. The flush re-reads pool.list() so we always see
    // the latest status/phase/cost regardless of which event fired.
    const off = onSwarmEvent(schedule);

    return () => {
      off();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      dirtyRef.current = false;
    };
  }, []);

  return state;
}

/**
 * Forces a re-render on an interval so elapsed-time / cost counters in the
 * panel tick even when no bus event fires (e.g. a long-running agent that
 * hasn't emitted a tool-start in a while). Returns a monotonically
 * increasing tick number; callers ignore the value — the re-render is the
 * point. Default 1000ms (matches the cc-haha CoordinatorTaskPanel 1s tick).
 */
export function useSwarmTick(intervalMs = 1000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

/**
 * Count running vs terminal handles for the panel title / header summary.
 * Pure helper so the panel and HeaderBar share one definition.
 */
export function swarmCounts(
  agents: ReadonlyArray<SubAgentHandle>,
): { running: number; done: number } {
  let running = 0;
  let done = 0;
  for (const a of agents) {
    if (a.status === "running" || a.status === "queued" || a.status === "paused") {
      running++;
    } else {
      done++;
    }
  }
  return { running, done };
}
