/**
 * SCW glue between QueryEngine and `src/context/` (step-27).
 *
 * Two pure-ish helpers extracted from `queryEngine.ts:run()` to keep that
 * file under the AGENTS.md §17 600-line hard cap. The engine still owns
 * the *when* (after system prompt build, before provider call) and *what*
 * (forward to onContextSnapshot, stage pendingPressure / pendingBudget);
 * this module owns the *how* (construction + transition → pressure shape).
 *
 * No state lives here — both helpers are pure / call-time. The monitor
 * itself is the only stateful piece (per-run instance held by QueryEngine).
 */

import { logger } from "../logger/index.js";
import {
  createContextMonitor,
  type ContextMonitor,
  type ContextMonitorDeps,
  type MonitorState,
} from "../context/index.js";
import type { PressureSnippet } from "../prompts/index.js";

export interface PendingContextHints {
  pressure: PressureSnippet | undefined;
  budget: { used: number; total: number } | undefined;
}

/**
 * Build the per-run monitor unless `CHOVY_CTX_DISABLE=1` is set. Returns
 * `null` on env-disable OR on construction failure (degraded gracefully —
 * the engine simply skips inspection for the rest of the run).
 */
export function createContextMonitorIfEnabled(
  deps: ContextMonitorDeps,
): ContextMonitor | null {
  if (process.env["CHOVY_CTX_DISABLE"] === "1") return null;
  try {
    return createContextMonitor(deps);
  } catch (err) {
    logger.warn("QueryEngine: context monitor init failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Translate a fresh `MonitorState` into the next round's prompt hints.
 *
 * `fresh` returns `{ pressure: undefined, budget }` so callers can clear
 * a stale pressure block once the conversation drops back below soft
 * (post-rebuild — step-28 wired this path via `monitor.reset()`).
 *
 * The `hard` level used to log a `logger.warn` here as a placeholder for
 * step-28 ("rebuild pending"). step-28 has shipped — the QueryEngine now
 * delegates rebuild to `engine/rebuildHook.maybeRebuild()`. We keep an
 * `info`-level breadcrumb (without the misleading "pending" wording) so
 * `chovy log tail` retains a trace at hard transitions; the rebuild
 * itself emits the canonical `context.rebuild` telemetry event.
 */
export function pendingFromMonitorState(
  state: MonitorState,
): PendingContextHints {
  const budget = {
    used: state.total,
    total: state.thresholds.ctxWindow,
  };
  if (state.level === "fresh") {
    return { pressure: undefined, budget };
  }
  const usedPct = state.thresholds.ctxWindow > 0
    ? Math.round((state.total / state.thresholds.ctxWindow) * 100)
    : 0;
  const remaining = Math.max(
    0,
    state.thresholds.effectiveWindow - state.total,
  );
  if (state.transitioned && state.level === "hard") {
    logger.info("QueryEngine: context at hard threshold (rebuild engaged)", {
      tokens: state.total,
      hard: state.thresholds.hard,
      ctxWindow: state.thresholds.ctxWindow,
    });
  }
  return {
    pressure: {
      level: state.level,
      usedPct,
      remainingTokens: remaining,
      checkpointWritten: state.checkpointTriggered,
    },
    budget,
  };
}

/**
 * Forward a snapshot to the optional UI callback, swallowing exceptions.
 * Kept here so the engine's main loop reads as one line.
 */
export function notifyContextSnapshot(
  cb: ((s: MonitorState) => void) | undefined,
  state: MonitorState,
): void {
  if (!cb) return;
  try {
    cb(state);
  } catch (err) {
    logger.warn("onContextSnapshot callback threw", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
