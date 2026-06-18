/**
 * Headless `chovy goal "..."` runner (step-23).
 *
 * Synchronous-style runner used by the CLI's `goal` subcommand. Drives the
 * loop to completion (no Ink UI), prints round-by-round progress to stdout,
 * and returns an exit code: `0` for `achieved`, `1` for `failed` /
 * `cancelled`, `2` for `paused` (death-spiral guard).
 *
 * Pulled into a separate file so `cli/index.tsx` doesn't pull `src/goals/`
 * into the main CLI bundle until the user actually runs `chovy goal …`.
 */

import { logger } from "../logger/index.js";
import { createGoal, inferConvergence, runGoal } from "../goals/index.js";
import type { ProviderId } from "../types/index.js";
import type { PermissionMode } from "../config/index.js";

export interface HeadlessGoalOptions {
  provider: ProviderId;
  model: string;
  mode: PermissionMode;
  objective: string;
  rubric?: string;
  cmd?: string;
  maxRounds?: number;
  budgetUSD?: number;
}

export async function runHeadlessGoal(opts: HeadlessGoalOptions): Promise<number> {
  const threadId = `headless_${Date.now().toString(36)}`;
  const convergence =
    opts.cmd && opts.rubric
      ? { mode: "hybrid" as const, rubric: opts.rubric, cmd: opts.cmd }
      : opts.cmd
        ? { mode: "command" as const, cmd: opts.cmd }
        : inferConvergence(opts.objective, opts.rubric);

  const goal = createGoal({
    threadId,
    objective: opts.objective,
    rubric: opts.rubric,
    convergence,
    maxRounds: opts.maxRounds,
    budgetUSD: opts.budgetUSD,
  });

  logger.info(`/goal: ${opts.objective}`);
  logger.info(
    `  convergence=${describeConvergence(goal.convergence)}  budget=$${goal.budgetUSD}  maxRounds=${goal.maxRounds}`,
  );

  const ac = new AbortController();
  process.once("SIGINT", () => {
    logger.warn("/goal: SIGINT received; cancelling…");
    ac.abort();
  });

  const result = await runGoal(goal, {
    cwd: process.cwd(),
    provider: opts.provider,
    model: opts.model,
    permissionMode: opts.mode,
    abortSignal: ac.signal,
    onRound: (g, res) => {
      logger.info(
        `[goal] round ${g.rounds}/${g.maxRounds}  cost=$${g.totalCostUSD.toFixed(4)}  stopReason=${res.stopReason}`,
      );
    },
    onConvergenceCheck: (g, ok, reasons) => {
      if (ok) {
        logger.info(`[goal] round ${g.rounds} ✓ converged`);
      } else {
        logger.info(`[goal] round ${g.rounds} not yet — ${reasons.slice(0, 3).join("; ")}`);
      }
    },
  });

  logger.info("");
  logger.info(`/goal terminal: status=${result.goal.status}  rounds=${result.rounds}  cost=$${result.costUSD.toFixed(4)}`);
  switch (result.goal.status) {
    case "achieved":
      return 0;
    case "paused":
      return 2;
    default:
      return 1;
  }
}

function describeConvergence(c: { mode: string; cmd?: string; rubric?: string; expectedExitCode?: number }): string {
  if (c.mode === "command") return `command \`${c.cmd}\` exit=${c.expectedExitCode ?? 0}`;
  if (c.mode === "rubric") return `rubric: ${c.rubric}`;
  return `hybrid: \`${c.cmd}\` ∧ rubric`;
}
