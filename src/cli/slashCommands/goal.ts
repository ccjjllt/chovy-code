/**
 * `/goal` slash command (step-23).
 *
 * Subcommands:
 *   /goal <objective> [--rubric "..."] [--cmd "..."]
 *   /goal status      — show current goal
 *   /goal pause       — pause the running loop (resumable)
 *   /goal resume      — re-enter the loop with the persisted goal
 *   /goal complete    — manually mark the goal achieved
 *   /goal clear       — drop the goal entirely
 *
 * Per AGENTS.md §17 Stop-hook adaptation, the loop is driven from the
 * REPL (not from the hook engine). The REPL injects the runtime hooks
 * needed (`startGoal` / `cancelGoal` / `getGoalState` / `setReplGoal`) so
 * this module stays UI-only — no provider / queryEngine imports here.
 */

import {
  parseGoalCommand,
  getActiveGoal,
  finalizeGoal,
  dropActiveGoal,
  persistGoal,
  inferConvergence,
} from "../../goals/index.js";
import type { ReplCtx, SlashEntry } from "../slashCommands.js";
import type { GoalState } from "../../types/index.js";

import { t } from "../../i18n/index.js";

export const goalSlashEntry: SlashEntry = {
  help: t("slash.goal.desc"),
  handler: async (args, ctx) => {
    let parsed;
    try {
      parsed = parseGoalCommand(args);
    } catch (err) {
      ctx.appendSystem(err instanceof Error ? err.message : String(err));
      return;
    }
    const goalCtx = ctx.goal;
    if (!goalCtx) {
      ctx.appendSystem("内部错误：REPL 未注入 goal 运行时（需要 step-23 接线）。");
      return;
    }
    switch (parsed.type) {
      case "status":
        await handleStatus(ctx, goalCtx);
        return;
      case "pause":
        await handlePause(ctx, goalCtx);
        return;
      case "resume":
        await handleResume(ctx, goalCtx);
        return;
      case "complete":
        await handleComplete(ctx, goalCtx);
        return;
      case "clear":
        await handleClear(ctx, goalCtx);
        return;
      case "set":
        await handleSet(ctx, goalCtx, parsed.objective, parsed.rubric, parsed.cmd);
        return;
    }
  },
};

// ── Handlers ───────────────────────────────────────────────────────────────

async function handleSet(
  ctx: ReplCtx,
  goalCtx: NonNullable<ReplCtx["goal"]>,
  objective: string,
  rubric: string | undefined,
  cmd: string | undefined,
): Promise<void> {
  const existing = getActiveGoal(goalCtx.threadId);
  if (existing && existing.status === "active") {
    ctx.appendSystem(
      `已有活跃 /goal："${existing.objective}"（round ${existing.rounds}/${existing.maxRounds}）。请先 /goal clear 或 /goal complete。`,
    );
    return;
  }
  // Resolve convergence: explicit --cmd > inferred from objective. If both
  // --rubric and --cmd are passed → hybrid. If only --rubric → still use
  // inferConvergence (which may pick command + hybrid based on objective
  // keywords) but caller's rubric takes the rubric slot.
  const convergence =
    cmd && rubric
      ? { mode: "hybrid" as const, rubric, cmd }
      : cmd
        ? { mode: "command" as const, cmd }
        : inferConvergence(objective, rubric);

  const goal = await goalCtx.startGoal({
    threadId: goalCtx.threadId,
    objective,
    rubric,
    convergence,
  });
  ctx.appendSystem(
    `Goal set: ${goal.objective}\n  convergence: ${describeConvergence(goal)}\n  budget: $${goal.budgetUSD}  maxRounds: ${goal.maxRounds}`,
  );
}

async function handleStatus(
  ctx: ReplCtx,
  goalCtx: NonNullable<ReplCtx["goal"]>,
): Promise<void> {
  const goal = getActiveGoal(goalCtx.threadId);
  if (!goal) {
    ctx.appendSystem("当前未设置 /goal。");
    return;
  }
  const last = goal.history[goal.history.length - 1];
  ctx.appendSystem(
    [
      `Goal: ${goal.objective}`,
      `  status: ${goal.status}  round ${goal.rounds}/${goal.maxRounds}  cost $${goal.totalCostUSD.toFixed(4)}/$${goal.budgetUSD.toFixed(2)}`,
      `  convergence: ${describeConvergence(goal)}`,
      last
        ? `  last: ${last.summary.slice(0, 200)}${last.converged ? " ✓" : ""}`
        : "  last: (no rounds yet)",
    ].join("\n"),
  );
}

async function handlePause(
  ctx: ReplCtx,
  goalCtx: NonNullable<ReplCtx["goal"]>,
): Promise<void> {
  const goal = getActiveGoal(goalCtx.threadId);
  if (!goal) {
    ctx.appendSystem("当前未设置 /goal。");
    return;
  }
  goalCtx.cancelGoal();
  finalizeGoal(goalCtx.threadId, "paused");
  await persistGoal(goalCtx.cwd, goal);
  goalCtx.setReplGoal(goal);
  ctx.appendSystem(`Goal paused: ${goal.objective}（/goal resume 可继续）`);
}

async function handleResume(
  ctx: ReplCtx,
  goalCtx: NonNullable<ReplCtx["goal"]>,
): Promise<void> {
  // Try in-memory first, fall back to disk by walking goalsDir. We don't
  // know the goalId from /goal resume alone — pick the most-recent paused
  // goal for this thread.
  let goal = getActiveGoal(goalCtx.threadId);
  if (!goal || goal.status !== "paused") {
    const recovered = await goalCtx.findPausedGoal();
    if (!recovered) {
      ctx.appendSystem("找不到可恢复的 /goal（需要 status=paused）。");
      return;
    }
    goal = recovered;
  }
  goal.status = "active";
  goal.finishedAt = undefined;
  await persistGoal(goalCtx.cwd, goal);
  goalCtx.setReplGoal(goal);
  ctx.appendSystem(`Goal resumed: ${goal.objective}（继续 round ${goal.rounds + 1}）`);
  // Fire-and-forget the loop again (the REPL impl decides how).
  void goalCtx.resumeGoalLoop(goal);
}

async function handleComplete(
  ctx: ReplCtx,
  goalCtx: NonNullable<ReplCtx["goal"]>,
): Promise<void> {
  const goal = getActiveGoal(goalCtx.threadId);
  if (!goal) {
    ctx.appendSystem("当前未设置 /goal。");
    return;
  }
  goalCtx.cancelGoal();
  finalizeGoal(goalCtx.threadId, "achieved");
  await persistGoal(goalCtx.cwd, goal);
  goalCtx.setReplGoal(null);
  ctx.appendSystem(`Goal marked complete: ${goal.objective}`);
}

async function handleClear(
  ctx: ReplCtx,
  goalCtx: NonNullable<ReplCtx["goal"]>,
): Promise<void> {
  goalCtx.cancelGoal();
  const goal = dropActiveGoal(goalCtx.threadId);
  if (goal) {
    goal.status = "cancelled";
    goal.finishedAt = Date.now();
    await persistGoal(goalCtx.cwd, goal);
  }
  goalCtx.setReplGoal(null);
  ctx.appendSystem(goal ? `Goal cleared: ${goal.objective}` : "Goal cleared.");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function describeConvergence(goal: GoalState): string {
  switch (goal.convergence.mode) {
    case "command":
      return `command \`${goal.convergence.cmd}\` (exit=${goal.convergence.expectedExitCode ?? 0})`;
    case "rubric":
      return `rubric: ${goal.convergence.rubric.slice(0, 80)}`;
    case "hybrid":
      return `hybrid: \`${goal.convergence.cmd}\` ∧ rubric "${goal.convergence.rubric.slice(0, 60)}"`;
  }
}

// Re-export type so the REPL can import it from one place.
export type { GoalState } from "../../types/index.js";

/** Helper for the REPL: load a paused goal for this thread from disk. */
export { loadGoal } from "../../goals/index.js";
