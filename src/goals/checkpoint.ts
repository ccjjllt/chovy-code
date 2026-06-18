/**
 * Goal-loop checkpoint trigger (step-23 ↔ step-26 collaboration, finalized).
 *
 * The goal loop calls `triggerCheckpoint(goal, ctx)` every
 * `CHECKPOINT_INTERVAL_ROUNDS` rounds (`shouldCheckpoint`). Step-23 shipped
 * a placeholder that just `void spawnFn(...)`-detached the writer with a
 * narrative prompt; step-26 replaces that with a real coordinator delegation:
 *
 *   - The CheckpointCoordinator (`src/memory/checkpointWriter.ts`) owns
 *     the snapshot prompt, archive rotation, validation, and fallback.
 *   - The trigger is fire-and-forget from the goal loop's perspective:
 *     `void getCheckpointCoordinator().maybeCheckpoint(...)` so the loop
 *     never blocks on the writer.
 *   - Failures inside the coordinator are swallowed + logged; an
 *     occasional missing checkpoint just means the next session start
 *     rebuilds context from the goal file alone (per spec §性能).
 *
 * Cancellation: the coordinator wraps `parentSignal` in a *local* AC, so
 * the spawned writer cancels alongside the goal but neither shares the
 * caller's signal nor leaks across runs (AGENTS.md §9).
 *
 * Backward compat: the public surface (`shouldCheckpoint` / `triggerCheckpoint`)
 * is unchanged so step-23 callers keep working without code edits.
 */

import { logger } from "../logger/index.js";
import { CHECKPOINT_INTERVAL_ROUNDS } from "./goalState.js";
import { getCheckpointCoordinator } from "../memory/index.js";
import type { GoalState, ProviderId, SpawnFn, ToolContext } from "../types/index.js";

/** True when the current round is a multiple of `CHECKPOINT_INTERVAL_ROUNDS`. */
export function shouldCheckpoint(goal: GoalState): boolean {
  return goal.rounds > 0 && goal.rounds % CHECKPOINT_INTERVAL_ROUNDS === 0;
}

/**
 * Trigger a checkpoint via the coordinator. The legacy `spawnFn` arg is
 * accepted for backward-compat with step-23 callers but ignored — the
 * coordinator pulls the live `SubAgentPool` itself, so callers no longer
 * need to plumb a SpawnFn through `RunGoalOptions`. The `cwd` / `provider`
 * / `model` / `parentSignal` / `hooks` fields are forwarded to the
 * coordinator when present.
 */
export async function triggerCheckpoint(
  goal: GoalState,
  ctx: {
    cwd?: string;
    provider?: ProviderId;
    model?: string;
    parentSignal?: AbortSignal;
    hooks?: ToolContext["hooks"];
    /** @deprecated step-23 kept this for back-compat; coordinator owns spawn now. */
    spawnFn?: SpawnFn;
  },
): Promise<void> {
  // Provider is required by the coordinator (it constructs `parentCtx` for
  // the spawn). When the goal loop doesn't have a provider snapshot in the
  // ctx (e.g. headless tests), we can't run a writer — log & skip.
  if (!ctx.provider) {
    logger.debug("checkpoint: no provider on ctx (skipping trigger)", {
      goalId: goal.id,
      round: goal.rounds,
    });
    return;
  }

  const coordinator = getCheckpointCoordinator(
    ctx.hooks ? { hooks: ctx.hooks } : undefined,
  );

  // Fire-and-forget: the goal loop must not block on the writer (per
  // step-23 §单轮迭代 + step-26 §性能). Errors are surfaced via telemetry +
  // the coordinator's own logger.warn — we still attach a `.catch` so
  // unhandled rejections don't pollute the runtime.
  void coordinator
    .maybeCheckpoint("goal-round", {
      cwd: ctx.cwd ?? process.cwd(),
      objective: goal.objective,
      historyTail: goal.history.slice(-5),
      // Goal loop does not retain the rolling message tail — the coordinator
      // builds the snapshot from objective + history only when no messages
      // are passed. Future SCW (step-27/28) hooks can pass the live tail.
      recentMessages: [],
      provider: ctx.provider,
      model: ctx.model,
      parentSignal: ctx.parentSignal,
      threadId: goal.threadId,
    })
    .catch((err) => {
      logger.warn("checkpoint: coordinator threw", {
        goalId: goal.id,
        round: goal.rounds,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  logger.debug("checkpoint: delegated to coordinator", {
    goalId: goal.id,
    round: goal.rounds,
  });
}
