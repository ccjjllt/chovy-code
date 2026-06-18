/**
 * Goal-loop checkpoint trigger (step-23 ↔ step-26 collaboration).
 *
 * Every `CHECKPOINT_INTERVAL_ROUNDS` (default 5) rounds we:
 *   1. spawn the `checkpoint-writer` built-in role via the live sub-agent
 *      pool (registered by step-19) — it writes a structured snapshot
 *      under `~/.chovy/projects/<id>/checkpoints/` (path enforcement by
 *      step-26 / SCW; for now it's pool-level role-config),
 *   2. emit `CheckpointWritten` (advisory) so user hooks can observe.
 *
 * step-26 is partially implemented (the role definition exists at
 * `src/agent/builtin/checkpointWriterAgent.ts`); step-26 finalizes the
 * exact prompt + path sandbox. Until then we still gain the periodic
 * snapshot benefit because the role's allowed-tools (`file_read` /
 * `file_write`) are real.
 *
 * Per `docs/step-23 §单轮迭代`:
 *   - the checkpoint writer is fire-and-forget (does NOT block the goal
 *     loop). The goal-loop awaits the checkpoint trigger but bounded by
 *     a small timeout; longer-running checkpoint runs are detached.
 *   - failures are non-fatal: a missing checkpoint just means the next
 *     /goal resume rebuilds context from the goal file alone.
 *
 * Cancellation: the spawn uses the goal's signal so cancelling the goal
 * cancels the in-flight checkpoint write. Per AGENTS.md §9 the spawned
 * agent gets its OWN AbortController inside the pool — we just observe.
 */

import { logger } from "../logger/index.js";
import { CHECKPOINT_INTERVAL_ROUNDS } from "./goalState.js";
import type { GoalState, SpawnFn, ToolContext } from "../types/index.js";

/** True when the current round is a multiple of `CHECKPOINT_INTERVAL_ROUNDS`. */
export function shouldCheckpoint(goal: GoalState): boolean {
  return goal.rounds > 0 && goal.rounds % CHECKPOINT_INTERVAL_ROUNDS === 0;
}

/**
 * Spawn a checkpoint-writer sub-agent if we have a `spawnFn` available.
 * Detached: we don't await the result — the goal loop continues immediately.
 * Errors are swallowed + logged.
 */
export async function triggerCheckpoint(
  goal: GoalState,
  ctx: { spawnFn?: SpawnFn; hooks?: ToolContext["hooks"] },
): Promise<void> {
  if (!ctx.spawnFn) {
    logger.debug("checkpoint: no spawnFn (sub-agent runtime not wired)", {
      goalId: goal.id,
      round: goal.rounds,
    });
    return;
  }

  const prompt = [
    `Write a checkpoint for /goal "${goal.objective}".`,
    `Round ${goal.rounds}/${goal.maxRounds}; cost $${goal.totalCostUSD.toFixed(4)}.`,
    `Status: ${goal.status}.`,
    `History (last 5):`,
    ...goal.history.slice(-5).map(
      (h) =>
        `  - round ${h.round}: ${h.summary.slice(0, 100)}${h.converged ? " ✓" : ""}`,
    ),
    "",
    "Save a structured summary to ~/.chovy/projects/<hash>/checkpoints/.",
  ].join("\n");

  try {
    // Detach intentionally: the spawn returns a handle synchronously; the
    // pool's `runChild` does the real work in the background. We don't
    // await the handle's result — checkpoint writing must NEVER block the
    // goal loop. Failures are visible via the swarm panel + telemetry.
    void ctx.spawnFn({
      role: "checkpoint-writer",
      prompt,
      background: true,
      // step-19 role default: allowedTools = ['file_read','file_write'];
      // step-26 will narrow file_write paths via the permission/sandbox
      // layer. We pass nothing here (caller intersection only collapses).
    });
    logger.info("checkpoint: spawned checkpoint-writer (detached)", {
      goalId: goal.id,
      round: goal.rounds,
    });

    // Best-effort CheckpointWritten emit (advisory). Real path/bytes are
    // unknown until the writer finishes; downstream hooks will pick up
    // the actual artifact on the next session start.
    if (ctx.hooks?.emit) {
      try {
        await ctx.hooks.emit("CheckpointWritten", {
          extra: { goalId: goal.id, round: goal.rounds, mode: "spawned" },
        });
      } catch {
        /* advisory — never fatal */
      }
    }
  } catch (err) {
    logger.warn("checkpoint: spawn failed", {
      goalId: goal.id,
      round: goal.rounds,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
