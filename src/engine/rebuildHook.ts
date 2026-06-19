/**
 * SCW rebuild glue between QueryEngine and `src/context/rebuilder.ts`
 * (step-28).
 *
 * Two helpers:
 *
 *   - `maybeRebuild(...)` — fire the rebuilder if the snapshot crossed
 *     hard threshold; mutate `messages` in place; reset the monitor +
 *     split the cost session. Returns `{rebuilt, result?}` so callers
 *     can re-inspect / re-render.
 *
 *   - `runScwRound(...)` — one-shot wrapper QueryEngine calls per round:
 *     inspect → notifyContextSnapshot → maybeRebuild → re-inspect (when
 *     a rebuild fires) → return next-round prompt hints. Centralizes
 *     the logic so `queryEngine.ts` stays under the AGENTS.md §17
 *     600-line hard cap.
 *
 * No state lives in this module — it is a pure glue point. The engine
 * still owns the *when* (after `inspect()`, before the provider call)
 * and *what* (which arrays/state to swap); this module owns the *how*.
 *
 * Single-source: this module is the ONLY caller of `rebuildContext`
 * inside the engine. CLI / test paths call `rebuildContext` directly
 * for offline scenarios.
 */

import { logger } from "../logger/index.js";
import {
  rebuildContext,
  type RebuildContextInput,
  type RebuildContextResult,
} from "../context/rebuilder.js";
import type {
  ContextMonitor,
  MonitorState,
} from "../context/index.js";
import type { ChatMessage } from "../types/messages.js";
import type { ProviderId } from "../types/provider.js";
import type { ChovyConfig } from "../config/config.js";
import type { HookEngine } from "../types/hook.js";
import type { CostTracker } from "./costTracker.js";
import {
  notifyContextSnapshot,
  pendingFromMonitorState,
  type PendingContextHints,
} from "./contextHook.js";

export interface MaybeRebuildInput {
  /** Engine's live message array (mutated in place on rebuild). */
  messages: ChatMessage[];
  monitor: ContextMonitor | null;
  cost: CostTracker;
  snapshot: MonitorState;
  cwd: string;
  sessionId: string;
  provider: ProviderId;
  model: string;
  cfg: ChovyConfig;
  hooks?: HookEngine;
  parentSignal?: AbortSignal;
  goalId?: string;
  goalObjective?: string;
}

export interface MaybeRebuildOutcome {
  /** True iff a rebuild fired this round. */
  rebuilt: boolean;
  /** Populated when `rebuilt:true`; useful for telemetry tests / UI. */
  result?: RebuildContextResult;
}

/**
 * Decide whether the snapshot triggers a rebuild and, if so, perform it
 * end-to-end. Safe to call every round — a no-op for fresh / soft snaps
 * and for already-degraded paths (`monitor === null`).
 */
export async function maybeRebuild(
  input: MaybeRebuildInput,
): Promise<MaybeRebuildOutcome> {
  if (!input.monitor) return { rebuilt: false };
  if (input.snapshot.level !== "hard") return { rebuilt: false };
  if (!input.snapshot.transitioned) return { rebuilt: false };

  let result: RebuildContextResult;
  try {
    const rebuildInput: RebuildContextInput = {
      messages: input.messages,
      cwd: input.cwd,
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      cfg: input.cfg,
      goalId: input.goalId,
      goalObjective: input.goalObjective,
      triggeringTokens: input.snapshot.total,
      parentSignal: input.parentSignal,
      hooks: input.hooks,
    };
    result = await rebuildContext(rebuildInput);
  } catch (err) {
    // rebuilder is supposed to never throw — but if it does, we MUST NOT
    // crash the engine. Degrade to "no rebuild fired" + warn.
    logger.warn("maybeRebuild: rebuildContext threw (continuing without rebuild)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { rebuilt: false };
  }

  // Swap in place: keep the same array reference so the engine's downstream
  // references (`messages.push(...)` after the provider call) keep working.
  input.messages.length = 0;
  input.messages.push(...result.messages);

  // Reset SCW state. Cost tracker keeps its cumulative bucket — budget
  // enforcement via `cost.cumulativeTotal()` continues to see absolute
  // spend (AGENTS.md §23 — budget can't be dodged via rebuild).
  input.monitor.reset();
  input.cost.splitSession();

  logger.info("SCW: context rebuilt at hard threshold", {
    before: result.before,
    after: result.after,
    dropped: result.dropped,
    fallback: result.buckets.fallback,
    durMs: result.durMs,
  });

  return { rebuilt: true, result };
}

// ── runScwRound — single-call helper for QueryEngine ──────────────────────

export interface ScwRoundInput {
  monitor: ContextMonitor | null;
  /** Engine's live message array (mutated by maybeRebuild on rebuild). */
  messages: ChatMessage[];
  /** System prompt size in characters (engine builds it before this call). */
  systemBytes: number;
  cost: CostTracker;
  cwd: string;
  sessionId: string;
  provider: ProviderId;
  model: string;
  cfg: ChovyConfig;
  hooks?: HookEngine;
  parentSignal?: AbortSignal;
  goalId?: string;
  goalObjective?: string;
  /** Forward to UI snapshot callback. Best-effort, swallowed on throw. */
  onSnapshot?: (s: MonitorState) => void;
}

export interface ScwRoundOutcome extends PendingContextHints {
  /** True iff a rebuild fired this round (for engine logging / smoke). */
  rebuilt: boolean;
}

/**
 * One-shot SCW pipeline for QueryEngine: inspect → notify → maybe-rebuild
 * → re-inspect → produce next-round hints. Returns `pendingFromMonitorState`
 * for the FRESH / SOFT path and an updated post-rebuild snapshot for HARD.
 *
 * `monitor === null` (env-disable / construction failure) returns the
 * neutral hint — `pressure: undefined, budget: undefined, rebuilt: false`.
 */
export async function runScwRound(
  input: ScwRoundInput,
): Promise<ScwRoundOutcome> {
  const monitor = input.monitor;
  if (!monitor) {
    return { pressure: undefined, budget: undefined, rebuilt: false };
  }
  const snap = monitor.inspect(input.messages, input.systemBytes);
  notifyContextSnapshot(input.onSnapshot, snap);

  const rb = await maybeRebuild({
    messages: input.messages,
    monitor,
    cost: input.cost,
    snapshot: snap,
    cwd: input.cwd,
    sessionId: input.sessionId,
    provider: input.provider,
    model: input.model,
    cfg: input.cfg,
    hooks: input.hooks,
    parentSignal: input.parentSignal,
    goalId: input.goalId,
    goalObjective: input.goalObjective,
  });

  // After a rebuild the message list shrunk; re-inspect so the next
  // round's pressure block reflects the post-rebuild reality.
  const finalSnap = rb.rebuilt
    ? monitor.inspect(input.messages, input.systemBytes)
    : snap;
  const next = pendingFromMonitorState(finalSnap);
  return { ...next, rebuilt: rb.rebuilt };
}

