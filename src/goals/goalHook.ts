/**
 * GoalIteration / CheckpointWritten hook emit helpers (step-23).
 *
 * Two roles:
 *   1. Thin wrapper around `ctx.hooks.emit('GoalIteration', ...)` so the
 *      iteration loop in `iterations.ts` doesn't repeat the payload shape
 *      and error-swallowing logic.
 *   2. Public `inferDefaultCmd(objective)` re-export for the headless
 *      `chovy goal "..."` path — keeps the cmd-inference logic discoverable
 *      from `goals/goalHook.ts` (which the spec lists as a public sub-module).
 *
 * Note (AGENTS.md §17 Stop-hook adaptation): chovy-code's `HookEvent` union
 * has no `Stop` event. The "managed Stop hook in settings.json" pattern from
 * `cc-haha/src/goals/goalState.ts` is replaced by a loop-driven model
 * (`iterations.ts` checks convergence after each `stopReason='final'`).
 * `GoalIteration` remains an *advisory* hook — user-supplied hooks can
 * observe each round but cannot block it (block outcomes are downgraded to
 * a log message; the loop never stalls on a hook).
 */

import type { GoalState, ToolContext } from "../types/index.js";

export interface GoalIterationPayload {
  goalId: string;
  /** 1-indexed round number (the round about to run). */
  round: number;
  objective: string;
  totalCostUSD: number;
}

/**
 * Best-effort GoalIteration emit. Block outcomes are NOT propagated —
 * `GoalIteration` is advisory by design (a misbehaving hook can't stall a
 * long-running goal). Errors are swallowed + logged; never throws.
 */
export async function emitGoalIteration(
  ctx: Pick<ToolContext, "hooks" | "logger">,
  goal: GoalState,
): Promise<void> {
  if (!ctx.hooks?.emit) return;
  const payload: GoalIterationPayload = {
    goalId: goal.id,
    round: goal.rounds + 1,
    objective: goal.objective,
    totalCostUSD: goal.totalCostUSD,
  };
  try {
    const outcome = await ctx.hooks.emit("GoalIteration", { extra: payload });
    if (outcome.type === "block") {
      ctx.logger?.info("GoalIteration hook returned block; advisory — continuing", {
        goalId: goal.id,
        reason: outcome.reason,
      });
    }
  } catch (err) {
    ctx.logger?.warn("GoalIteration hook threw", {
      goalId: goal.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Re-export `inferConvergence` from goalState for callers that prefer the
 * `goalHook` namespace (the spec puts the inference helper here per
 * `docs/step-23 §产物`).
 */
export { inferConvergence } from "./goalState.js";
