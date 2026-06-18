/**
 * Goal-loop iteration — the heart of `/goal` (step-23).
 *
 * One `runGoal()` call drives a goal from `active` to a terminal status
 * (`achieved` / `failed` / `cancelled` / `paused`). Each iteration:
 *
 *   1. emit `goal.iteration` telemetry + `GoalIteration` hook (advisory);
 *   2. run a single `QueryEngine` round with the current message list;
 *   3. record the round (rounds++, totalCostUSD += result.costUSD, persist);
 *   4. if the engine returned `cancelled` / budget-exceeded → terminate;
 *   5. if `stopReason === 'final'`, run convergence judge:
 *        - achieved → terminate with `status='achieved'`;
 *        - else → push `<goal-not-achieved>...</goal-not-achieved>` user
 *          message and continue;
 *   6. update death-spiral counter (no fs-mutate this round → ++);
 *   7. checkpoint trigger every N rounds (step-26).
 *
 * Loop-driven Stop adaptation (AGENTS.md §17): cc-haha registers a Stop
 * hook in settings.json that decides "did we converge?" inside the hook
 * engine. chovy-code's HookEvent union has no `Stop` event — we instead
 * own the iteration outside the engine and check convergence here. The
 * `GoalIteration` hook still fires per round so users can observe.
 *
 * Cancellation (AGENTS.md §9): the loop wraps the caller's `abortSignal`
 * in a LOCAL AbortController. Programmatic cancels (budget exceeded, etc.)
 * never touch the caller's signal. The local signal is forwarded as
 * `engine.run({ abortSignal })` so any in-flight provider call / tool
 * inherits the abort.
 *
 * Cost folding (mirrors step-21 judge): the rubric judge's USD cost is
 * folded into `goal.totalCostUSD` but does NOT emit a separate
 * `agent.cost` telemetry event — convergence.evaluate uses a CostTracker
 * with `telemetry:false`. Single-source per AGENTS.md §17.
 */

import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import { QueryEngine, type QueryRunResult } from "../engine/index.js";
import { evaluate as evaluateConvergence } from "./convergence.js";
import {
  finalizeGoal,
  NO_PROGRESS_LIMIT,
  persistGoal,
  updateGoal,
} from "./goalState.js";
import { shouldCheckpoint, triggerCheckpoint } from "./checkpoint.js";
import { goalProgressFile } from "../fs/paths.js";
import { safeFs } from "../fs/safeFs.js";
import type {
  ChatMessage,
  GoalState,
  ProviderId,
  SpawnFn,
  ToolContext,
} from "../types/index.js";
import type { PermissionMode } from "../config/index.js";

// ── Public surface ─────────────────────────────────────────────────────────

export interface RunGoalOptions {
  cwd: string;
  provider: ProviderId;
  model: string;
  permissionMode?: PermissionMode | string;
  /** Initial messages — the goal loop seeds with the objective by default. */
  messages?: ChatMessage[];
  /** Caller-controlled cancel. Wrapped in a local AC per AGENTS.md §9. */
  abortSignal?: AbortSignal;
  /** UI callbacks. */
  onRound?(goal: GoalState, result: QueryRunResult): void;
  onConvergenceCheck?(goal: GoalState, ok: boolean, reasons: string[]): void;
  onToken?(delta: string): void;
  onHookMessage?(msg: string): void;
  /** Per-round engine maxRounds cap (defaults to 8 = engine default). */
  engineMaxRounds?: number;
  /** Checkpoint spawn factory (sub-agent runtime); skipped when absent. */
  spawnFn?: SpawnFn;
  /** Optional askUser handle for the engine's meta tools. */
  askUser?: ToolContext["askUser"];
  isInteractive?: ToolContext["isInteractive"];
}

export interface RunGoalResult {
  goal: GoalState;
  /** Rounds the loop ran (== `goal.rounds` at exit). */
  rounds: number;
  /** Total USD spent (engine + rubric judge). */
  costUSD: number;
}

/**
 * Drive a goal to completion. Returns when the goal reaches a terminal
 * status (or paused via the death-spiral guard). NEVER throws — provider
 * / tool errors are surfaced via `goal.status='failed'` + last-round
 * summary.
 */
export async function runGoal(
  goal: GoalState,
  opts: RunGoalOptions,
): Promise<RunGoalResult> {
  const ac = new AbortController();
  const onParentAbort = (): void => ac.abort();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) ac.abort();
    else opts.abortSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  // Seed messages with the objective if caller didn't provide a transcript.
  const messages: ChatMessage[] =
    opts.messages && opts.messages.length > 0
      ? [...opts.messages]
      : [seedObjectiveMessage(goal)];

  // Persist initial state so a crash mid-run leaves disk consistent.
  await persistGoal(opts.cwd, goal);

  emitTelemetry({
    type: "goal.start",
    goalId: goal.id,
    threadId: goal.threadId,
    convergence: goal.convergence.mode,
    maxRounds: goal.maxRounds,
    budgetUSD: goal.budgetUSD,
  });

  const engine = new QueryEngine();

  try {
    while (
      goal.status === "active" &&
      goal.rounds < goal.maxRounds &&
      goal.totalCostUSD < goal.budgetUSD &&
      !ac.signal.aborted
    ) {
      // ── 1. emit GoalIteration + telemetry ────────────────────────────
      emitTelemetry({
        type: "goal.iteration",
        goalId: goal.id,
        round: goal.rounds + 1,
        converged: false,
      });
      // Hook emit is best-effort; we don't have a real ToolContext here so
      // we skip it (the engine.run() below WILL emit GoalIteration via its
      // own ctx.hooks.emit if a managed hook is registered for the event —
      // not yet plumbed; advisory until step-13 user-supplied hooks land
      // for goals).

      // ── 2. one engine round ──────────────────────────────────────────
      let result: QueryRunResult;
      try {
        result = await engine.run({
          messages,
          provider: opts.provider,
          model: opts.model,
          permissionMode: opts.permissionMode,
          abortSignal: ac.signal,
          maxRounds: opts.engineMaxRounds ?? 8,
          // Budget the sub-run at the *remaining* budget so an engine round
          // can't blow past the goal cap in one shot.
          budgetUSD: Math.max(0.001, goal.budgetUSD - goal.totalCostUSD),
          onToken: opts.onToken,
          askUser: opts.askUser,
          isInteractive: opts.isInteractive,
          onHookMessage: opts.onHookMessage,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("goal-loop: engine.run threw", { goalId: goal.id, error: msg });
        // Failed engine call → record the round, mark failed, terminate.
        updateGoal(goal.threadId, {
          rounds: goal.rounds + 1,
          history: [
            ...goal.history,
            {
              round: goal.rounds + 1,
              summary: `engine error: ${msg}`,
              converged: false,
              cost: 0,
              ts: Date.now(),
              reasons: [`engine threw: ${msg}`],
            },
          ],
        });
        finalizeGoal(goal.threadId, "failed");
        await persistGoal(opts.cwd, goal);
        break;
      }

      // ── 3. record round ──────────────────────────────────────────────
      // Mutate the live `messages` ref so the next round sees the assistant
      // turn + any tool messages. The engine returns a copy; we adopt it.
      messages.length = 0;
      messages.push(...result.messages);

      goal.rounds += 1;
      goal.totalCostUSD += result.costUSD;
      opts.onRound?.(goal, result);

      // ── 4. terminal-engine-stopReason short circuit ──────────────────
      if (result.stopReason === "cancelled" || ac.signal.aborted) {
        finalizeGoal(goal.threadId, "cancelled");
        await persistGoal(opts.cwd, goal);
        break;
      }
      if (result.stopReason === "budgetExceeded" || goal.totalCostUSD >= goal.budgetUSD) {
        finalizeGoal(goal.threadId, "failed");
        appendHistory(goal, {
          round: goal.rounds,
          summary: lastAssistantText(result),
          converged: false,
          cost: result.costUSD,
          reasons: ["budget exceeded"],
          ts: Date.now(),
        });
        await persistGoal(opts.cwd, goal);
        break;
      }
      if (result.stopReason !== "final") {
        // maxRounds inside the engine — record and let the outer loop tick.
        appendHistory(goal, {
          round: goal.rounds,
          summary: lastAssistantText(result) || "(engine maxRounds; no final answer)",
          converged: false,
          cost: result.costUSD,
          reasons: [`engine stopReason=${result.stopReason}`],
          ts: Date.now(),
        });
        await persistGoal(opts.cwd, goal);
        // No <goal-not-achieved> injection here — the engine itself ran out
        // of internal rounds, not the model giving a final answer. Continue
        // the outer loop to re-prompt with fresh state.
        continue;
      }

      // ── 5. convergence ───────────────────────────────────────────────
      const conv = await evaluateConvergence(goal, messages, {
        cwd: opts.cwd,
        parentProvider: opts.provider,
        parentModel: opts.model,
        abortSignal: ac.signal,
      });
      goal.totalCostUSD += conv.costUSD;
      opts.onConvergenceCheck?.(goal, conv.ok, conv.reasons);

      const summary = lastAssistantText(result);
      appendHistory(goal, {
        round: goal.rounds,
        summary,
        converged: conv.ok,
        cost: result.costUSD + conv.costUSD,
        reasons: conv.ok ? undefined : conv.reasons,
        ts: Date.now(),
      });
      await appendProgress(opts.cwd, goal, summary, conv.ok, conv.reasons);

      if (conv.ok) {
        finalizeGoal(goal.threadId, "achieved");
        await persistGoal(opts.cwd, goal);
        break;
      }

      // ── 6. death-spiral guard ────────────────────────────────────────
      const mutated = roundMutatedFiles(result);
      goal.noProgressRounds = mutated ? 0 : goal.noProgressRounds + 1;
      if (goal.noProgressRounds >= NO_PROGRESS_LIMIT) {
        logger.warn("goal-loop: 5 rounds without fs-mutate; pausing", {
          goalId: goal.id,
        });
        finalizeGoal(goal.threadId, "paused");
        await persistGoal(opts.cwd, goal);
        break;
      }

      // ── 7. inject continuation user message ─────────────────────────
      messages.push({
        role: "user",
        content:
          `<goal-not-achieved/>\n` +
          `judge reasons: ${conv.reasons.join("; ") || "(unspecified)"}\n` +
          `请继续推进目标："${goal.objective}"。修复未通过的判据点，避免重复已尝试的方案。`,
        ts: Date.now(),
      });

      // ── 8. periodic checkpoint ───────────────────────────────────────
      if (shouldCheckpoint(goal)) {
        await triggerCheckpoint(goal, { spawnFn: opts.spawnFn });
      }

      await persistGoal(opts.cwd, goal);
    }

    // Outer-loop terminal conditions (max-rounds / budget without engine
    // stopReason flagging it).
    if (goal.status === "active") {
      if (goal.rounds >= goal.maxRounds) {
        finalizeGoal(goal.threadId, "failed");
        appendHistory(goal, {
          round: goal.rounds,
          summary: `max rounds (${goal.maxRounds}) reached without convergence`,
          converged: false,
          cost: 0,
          reasons: ["maxRounds"],
          ts: Date.now(),
        });
      } else if (goal.totalCostUSD >= goal.budgetUSD) {
        finalizeGoal(goal.threadId, "failed");
      } else if (ac.signal.aborted) {
        finalizeGoal(goal.threadId, "cancelled");
      }
      await persistGoal(opts.cwd, goal);
    }
  } finally {
    if (opts.abortSignal && !opts.abortSignal.aborted) {
      opts.abortSignal.removeEventListener("abort", onParentAbort);
    }
    emitTelemetry({
      type: "goal.end",
      goalId: goal.id,
      threadId: goal.threadId,
      status: goal.status === "active" ? "failed" : (goal.status as
        | "achieved"
        | "failed"
        | "cancelled"
        | "paused"),
      rounds: goal.rounds,
      costUSD: goal.totalCostUSD,
    });
  }

  return { goal, rounds: goal.rounds, costUSD: goal.totalCostUSD };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function seedObjectiveMessage(goal: GoalState): ChatMessage {
  const rubricLine =
    goal.convergence.mode === "command"
      ? `收敛判据：命令 \`${goal.convergence.cmd}\` 退出码 = ${goal.convergence.expectedExitCode ?? 0}。`
      : goal.convergence.mode === "hybrid"
        ? `收敛判据：命令 \`${goal.convergence.cmd}\` 退出码 = ${goal.convergence.expectedExitCode ?? 0}，且 rubric "${goal.convergence.rubric}" 通过。`
        : `收敛判据：${goal.convergence.rubric}`;
  return {
    role: "user",
    content:
      `<goal-objective>${goal.objective}</goal-objective>\n` +
      `${rubricLine}\n\n` +
      `请按目标推进；每轮结束前自检是否满足判据。`,
    ts: Date.now(),
  };
}

/**
 * Mutate `goal.history` (in place) to keep the in-memory + persisted copy
 * the same reference. Helper centralizes the array push for readability.
 */
function appendHistory(goal: GoalState, entry: GoalState["history"][number]): void {
  goal.history.push(entry);
  goal.updatedAt = Date.now();
}

/**
 * Did this engine round mutate any files? Walks the assistant turn's
 * tool messages looking for the fs-mutate family (file_write / file_edit /
 * bash with structuredOutput.classes containing WRITE). Conservative —
 * unknown shapes count as "no mutation" so the death-spiral guard
 * eventually trips on agents that just `read+grep` repeatedly.
 */
function roundMutatedFiles(result: QueryRunResult): boolean {
  for (const m of result.messages) {
    if (m.role !== "tool") continue;
    if (m.toolName === "file_write" || m.toolName === "file_edit") return true;
    // Heuristic for bash: we don't have the structuredOutput here (engine
    // pushes plain string content), so look for the summary header.
    if (m.toolName === "bash" && /\bclasses=.*WRITE/.test(m.content ?? "")) {
      return true;
    }
  }
  return false;
}

/** Best-effort grab of the last assistant text for `history.summary`. */
function lastAssistantText(result: QueryRunResult): string {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const m = result.messages[i];
    if (!m) continue;
    if (m.role === "assistant" && typeof m.content === "string" && m.content.length > 0) {
      return m.content.length > 240 ? m.content.slice(0, 240) + "…" : m.content;
    }
  }
  return result.finalContent.slice(0, 240);
}

/**
 * Append a progress line to `tasks/<goal-id>/progress.md`. step-26 reads
 * this when building checkpoints. Best-effort: errors are logged + ignored
 * so a flaky disk doesn't break the goal loop.
 */
async function appendProgress(
  cwd: string,
  goal: GoalState,
  summary: string,
  converged: boolean,
  reasons: string[],
): Promise<void> {
  const ts = new Date().toISOString();
  const line = [
    `## round ${goal.rounds} · ${ts}`,
    `- converged: ${converged ? "yes" : "no"}`,
    `- cost: $${goal.totalCostUSD.toFixed(4)}`,
    converged ? "" : `- reasons: ${reasons.join("; ") || "(unspecified)"}`,
    "",
    summary.length > 0 ? `> ${summary.replace(/\n/g, "\n> ")}` : "",
    "",
    "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    await safeFs.append(goalProgressFile(cwd, goal.id), line);
  } catch (err) {
    logger.warn("goal-loop: progress append failed", {
      goalId: goal.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
