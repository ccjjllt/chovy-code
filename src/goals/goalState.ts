/**
 * Goal state — in-memory map + JSON persistence (step-23).
 *
 * Two surfaces:
 *   1. Per-thread in-memory `Map<threadId, GoalState>` for the active REPL
 *      session. The REPL / GoalPanel poll this synchronously for UI.
 *   2. `~/.chovy/projects/<id>/goals/<goal-id>.json` for crash recovery,
 *      `chovy goal` headless runs, and pause/resume across CLI invocations.
 *
 * Both surfaces are kept in sync by routing every mutation through
 * `updateGoal()` — callers are forbidden from mutating `GoalState` objects
 * in place (the in-memory copy returned to UI is the same reference, so
 * mutating it would silently desync from disk).
 *
 * Adapted from `cc-haha/src/goals/goalState.ts` (which uses session hooks
 * + transcript scanning); chovy-code's loop-driven model (AGENTS.md §17
 * Stop-hook adaptation) doesn't need transcript replay — the file IS the
 * source of truth on resume.
 */

import { createHash } from "node:crypto";
import type { ConvergenceMode, GoalState, GoalStatus, ProviderId } from "../types/index.js";
import { ChovyError } from "../types/errors.js";
import { goalFile, goalsDir } from "../fs/paths.js";
import { safeFs } from "../fs/safeFs.js";
import { logger } from "../logger/index.js";

// ── Defaults (step-23 §数据结构) ───────────────────────────────────────────

/** Hard cap on iteration count. Mirrors `docs/step-23 §数据结构 maxRounds:25`. */
export const DEFAULT_MAX_ROUNDS = 25;
/** USD budget cap. Mirrors `docs/step-23 §数据结构 budgetUSD:5`. */
export const DEFAULT_BUDGET_USD = 5;
/** Death-spiral threshold (step-23 §风险). */
export const NO_PROGRESS_LIMIT = 5;
/** How often (in rounds) to trigger the checkpoint-writer sub-agent (step-26 hook). */
export const CHECKPOINT_INTERVAL_ROUNDS = 5;

// ── Per-thread in-memory state ──────────────────────────────────────────────

/**
 * Process-wide map keyed by `threadId` (= REPL sessionId). Mirrors
 * cc-haha's `goalsByThread` Map; private to this module so callers go
 * through the helpers (which keep file + memory consistent).
 */
const goalsByThread = new Map<string, GoalState>();

/** Read the active goal for a thread (or null). */
export function getActiveGoal(threadId: string): GoalState | null {
  return goalsByThread.get(threadId) ?? null;
}

/** Test/CLI helper: forget all in-memory goals (file is untouched). */
export function _resetGoalsForTesting(): void {
  goalsByThread.clear();
}

// ── Construction ────────────────────────────────────────────────────────────

export interface CreateGoalInput {
  threadId: string;
  objective: string;
  rubric?: string;
  /** Pre-resolved convergence mode (else `inferConvergence` is called). */
  convergence?: ConvergenceMode;
  maxRounds?: number;
  budgetUSD?: number;
  rubricProvider?: ProviderId;
  rubricModel?: string;
}

/** Make a stable 12-char id from `objective + createdAt`. */
function makeGoalId(objective: string, createdAt: number): string {
  return createHash("sha1")
    .update(`${objective}\u0000${createdAt}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Create + register a new goal in memory. Caller is responsible for
 * `persistGoal(cwd, goal)` afterwards (the in-memory map updates
 * synchronously; disk writes are async to keep callers non-blocking).
 *
 * If `convergence` is omitted, `inferConvergence(objective, rubric)` runs
 * to pick a default mode (step-23 §收敛判据 "设置默认值").
 */
export function createGoal(input: CreateGoalInput): GoalState {
  const objective = input.objective.trim();
  if (objective.length === 0) {
    throw new ChovyError("CONFIG_INVALID", "/goal objective must be non-empty");
  }
  const now = Date.now();
  const id = makeGoalId(objective, now);
  const convergence: ConvergenceMode =
    input.convergence ?? inferConvergence(objective, input.rubric);

  const goal: GoalState = {
    id,
    threadId: input.threadId,
    objective,
    rubric: input.rubric,
    convergence,
    createdAt: now,
    updatedAt: now,
    rounds: 0,
    maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
    status: "active",
    history: [],
    budgetUSD: input.budgetUSD ?? DEFAULT_BUDGET_USD,
    totalCostUSD: 0,
    noProgressRounds: 0,
    rubricProvider: input.rubricProvider,
    rubricModel: input.rubricModel,
  };
  goalsByThread.set(input.threadId, goal);
  return goal;
}

/**
 * Heuristic mode inference from the objective text (step-23 §收敛判据
 * "设置默认值"). When the objective implies a verifiable command we pick
 * `command` mode with a sensible default; else we fall back to `rubric`.
 *
 * Keywords intentionally cover Chinese phrasings as well — most chovy-code
 * users write objectives in Chinese.
 */
export function inferConvergence(
  objective: string,
  rubric?: string,
): ConvergenceMode {
  const lower = objective.toLowerCase();
  const cmdHint = (() => {
    if (/typecheck|type[-\s]?check|tsc|类型检查/i.test(objective)) return "bun run typecheck";
    if (/\bbuild\b|构建/i.test(objective) && !/build pass/i.test(objective)) return "bun run build";
    if (/\btests?\b|test pass|测试通过|跑测试/i.test(objective)) return "bun test";
    if (/\blint\b/i.test(lower)) return "bun run lint";
    if (/\bcompile\b|编译/i.test(lower)) return "bun run typecheck";
    return undefined;
  })();
  if (cmdHint) {
    if (rubric && rubric.trim().length > 0) {
      return { mode: "hybrid", rubric: rubric.trim(), cmd: cmdHint };
    }
    return { mode: "command", cmd: cmdHint };
  }
  // Rubric mode: the rubric describes the success condition. If user
  // provided one, use it verbatim; else fall back to the objective itself.
  return { mode: "rubric", rubric: rubric?.trim() || objective };
}

// ── Mutation helpers ────────────────────────────────────────────────────────

/**
 * Apply a partial update to the in-memory goal AND bump `updatedAt`.
 * Returns the (same-reference) updated goal — mutates in place because
 * UI subscribers hold the reference. Persistence is a separate call so
 * batched mutations only hit disk once per round.
 */
export function updateGoal(
  threadId: string,
  patch: Partial<GoalState>,
): GoalState | null {
  const cur = goalsByThread.get(threadId);
  if (!cur) return null;
  Object.assign(cur, patch);
  cur.updatedAt = Date.now();
  return cur;
}

/** Mark the goal terminal — sets `finishedAt` + clears the in-memory entry. */
export function finalizeGoal(
  threadId: string,
  status: Exclude<GoalStatus, "active">,
): GoalState | null {
  const goal = goalsByThread.get(threadId);
  if (!goal) return null;
  goal.status = status;
  goal.updatedAt = Date.now();
  goal.finishedAt = goal.updatedAt;
  // Keep `paused` in memory so /goal resume can pick it up cheaply; only
  // truly terminal states (achieved / failed / cancelled) drop the entry.
  if (status !== "paused") {
    goalsByThread.delete(threadId);
  }
  return goal;
}

/** Force-remove the in-memory entry (used by `/goal clear`). */
export function dropActiveGoal(threadId: string): GoalState | null {
  const goal = goalsByThread.get(threadId) ?? null;
  if (goal) goalsByThread.delete(threadId);
  return goal;
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** Atomic write to `~/.chovy/projects/<id>/goals/<goal-id>.json`. */
export async function persistGoal(cwd: string, goal: GoalState): Promise<void> {
  const path = goalFile(cwd, goal.id);
  const json = JSON.stringify(goal, null, 2);
  try {
    await safeFs.write(path, json);
  } catch (err) {
    logger.warn("persistGoal failed (state still in memory)", {
      goalId: goal.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Load a goal from disk by id. Returns null on missing/corrupt files
 * (errors are logged + swallowed — `/goal resume` shouldn't crash on a
 * stale file). Will register the loaded goal in the in-memory map ONLY
 * if no entry exists yet for that threadId — a live in-memory goal is
 * always more authoritative than the disk copy (the in-memory entry is
 * the one being mutated by an active loop; persistGoal writes it last).
 */
export async function loadGoal(cwd: string, goalId: string): Promise<GoalState | null> {
  const path = goalFile(cwd, goalId);
  if (!(await safeFs.exists(path))) return null;
  try {
    const raw = await safeFs.read(path);
    const parsed = JSON.parse(raw) as GoalState;
    const recoverable =
      parsed.threadId &&
      (parsed.status === "active" || parsed.status === "paused");
    if (recoverable && !goalsByThread.has(parsed.threadId)) {
      goalsByThread.set(parsed.threadId, parsed);
    }
    return parsed;
  } catch (err) {
    logger.warn("loadGoal failed; ignoring", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** List all persisted goals for the project (active + terminal). */
export async function listGoals(cwd: string): Promise<GoalState[]> {
  const dir = goalsDir(cwd);
  if (!(await safeFs.exists(dir))) return [];
  let files: string[];
  try {
    files = await safeFs.list(dir);
  } catch {
    return [];
  }
  const out: GoalState[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await safeFs.read(f);
      out.push(JSON.parse(raw) as GoalState);
    } catch {
      // skip corrupt entry (already logged on first read)
    }
  }
  // Most-recent first.
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// ── Slash-command parsing (cc-haha goalState `parseGoalCommand` port) ───────

export type ParsedGoalCommand =
  | { type: "set"; objective: string; rubric?: string; cmd?: string }
  | { type: "status" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "complete" }
  | { type: "clear" };

/**
 * Parse the raw arg string after `/goal `. Supports:
 *   /goal <objective>
 *   /goal status | pause | resume | complete | clear
 *   /goal <objective> --rubric "<rule>"
 *   /goal <objective> --cmd "<command>"
 *
 * Throws `ChovyError(CONFIG_INVALID)` on empty input. Argument flag
 * parsing is intentionally tiny — the REPL strips quotes for us; for the
 * headless `chovy goal` we use commander's option parser instead.
 */
export function parseGoalCommand(raw: string): ParsedGoalCommand {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ChovyError(
      "CONFIG_INVALID",
      "用法：/goal <objective> | status | pause | resume | complete | clear",
    );
  }
  const lower = trimmed.toLowerCase();
  if (lower === "status") return { type: "status" };
  if (lower === "pause") return { type: "pause" };
  if (lower === "resume") return { type: "resume" };
  if (lower === "complete") return { type: "complete" };
  if (lower === "clear") return { type: "clear" };

  // Extract --rubric / --cmd flags (positional remainder is the objective).
  // Each flag is matched as a single regex over the whole remainder so the
  // whitespace between `<flag>` and `"value"` is consumed atomically — no
  // residual padding is left in the objective.
  let rest = trimmed;
  const out: { rubric?: string; cmd?: string } = {};
  for (const flag of ["--rubric", "--cmd"] as const) {
    const re = new RegExp(
      `\\s*${flag}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`,
      "",
    );
    const m = rest.match(re);
    if (!m) continue;
    const val = m[1] ?? m[2] ?? m[3] ?? "";
    if (flag === "--rubric") out.rubric = val;
    else out.cmd = val;
    rest = rest.replace(m[0], " ");
  }
  rest = rest.replace(/\s+/g, " ").trim();
  if (rest.length === 0) {
    throw new ChovyError(
      "CONFIG_INVALID",
      "用法：/goal <objective> [--rubric \"...\"] [--cmd \"...\"]",
    );
  }
  return { type: "set", objective: rest, ...out };
}
